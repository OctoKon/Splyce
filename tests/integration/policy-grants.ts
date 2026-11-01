// Splyce TD-13 (C2_policy_grants): NativePolicy dispatch requires real Store
// grants. Once grants (fs.write/shell.run) are consumed atomically with the
// approved->running receipts and revalidated before the effect callback;
// session grants (fs.read/net.provider) are checked on every call. Workspace
// identity is observed fresh through the native port on every check.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  NativePolicy,
  actionArgumentsDigest,
} from "../../packages/splyce-pi/dist/policy.js";
import { Store } from "../../packages/splyce-pi/dist/store.js";
import {
  IDENTITY,
  MemoryWorkspaceIdentity,
} from "../fixtures/native-grants.mjs";

const records = JSON.parse(
  readFileSync(
    new URL("../fixtures/contracts/records.json", import.meta.url),
    "utf8",
  ),
);
const caller = {
  sessionId: "pi-1",
  configRevision: "cfg1",
  profileRevision: "profile1",
  policyRevision: "policy1",
  resolveReference: () => true,
};
const ARGS = { path: "src/a.ts", content: "x" };
const DIGEST = actionArgumentsDigest(ARGS);
const ORIGIN = "https://api.example.com:443";
type Capability = "fs.read" | "fs.write" | "shell.run" | "net.provider";

function fixture(t: { after(callback: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), "td13-policy-"));
  const path = join(dir, "store.db");
  const store = Store.open(path);
  t.after(() => {
    if (!store.closed) store.close();
    const target = resolve(dir);
    assert.equal(dirname(target), resolve(tmpdir()));
    assert.ok(basename(target).startsWith("td13-policy-"));
    rmSync(target, { recursive: true, force: true });
  });
  const workspace = store.admitWorkspace(
    { canonicalPath: "C:\\Users\\dev\\policy-grants", ...IDENTITY },
    caller,
  );
  const workspaceId = workspace.workspaceId;
  store.append(
    {
      kind: "branchAnchor",
      record: {
        ...records.branchAnchor,
        scopeId: workspaceId,
        piSessionId: caller.sessionId,
      },
    },
    caller,
  );
  const identity = new MemoryWorkspaceIdentity();
  identity.set(workspaceId, IDENTITY);
  const live = new Set<string>();
  let run = {
    ...records.run,
    piSessionId: caller.sessionId,
    workspaceId,
    grantIds: [] as string[],
  };
  const ownership = store.acquireWorkspace(workspaceId, caller.sessionId);
  let revision = 0;
  /** Adds a grant ID to the run and the host's live grant set. */
  const allow = (grantId: string) => {
    live.add(grantId);
    revision += 1;
    run = {
      ...run,
      recordId: `rec-run-${String(revision)}`,
      grantIds: [...run.grantIds, grantId],
    };
    store.append({ kind: "run", record: run }, caller);
    return grantId;
  };
  const mint = (
    capability: Capability,
    actionId?: string,
    extra: Record<string, string> = {},
  ) =>
    allow(
      store.mintGrant(
        {
          workspaceId,
          sessionId: caller.sessionId,
          capability,
          scope: actionId === undefined ? "session" : "once",
          ...(actionId === undefined
            ? {}
            : { actionId, argumentsDigest: DIGEST }),
          ...extra,
        },
        caller,
      ).grantId,
    );
  const policy = (handle = store) =>
    new NativePolicy(
      handle,
      caller,
      () => ({
        configRevision: "cfg1",
        profileRevision: "profile1",
        policyRevision: "policy1",
        grantIds: [...live],
        planMode: false,
      }),
      identity,
    );
  const permit = (
    actionId: string,
    grantId: string,
    capability: Capability | undefined,
    extra: Record<string, unknown> = {},
  ) => ({
    toolCallId: `call-${actionId}`,
    toolName: "fixture_tool",
    actionId,
    runRecordId: run.recordId,
    grantId,
    parentActionId: null,
    capabilityId: "cap1",
    capabilityVersion: "1",
    argumentsArtifactId: "args1",
    argumentsDigest: DIGEST,
    targetScopeId: "w-demo",
    idempotencyKey: `key-${actionId}`,
    ownership,
    ...(capability === undefined ? {} : { capability }),
    ...extra,
  });
  const states = (actionId: string) =>
    store
      .list("w-demo")
      .records.filter(
        ({ kind, record }) =>
          kind === "action" &&
          (record as { actionId: string }).actionId === actionId,
      )
      .map(({ record }) => (record as { state: string }).state);
  return {
    dir,
    path,
    store,
    workspaceId,
    identity,
    allow,
    mint,
    policy,
    permit,
    states,
  };
}

type Permit = ReturnType<ReturnType<typeof fixture>["permit"]>;

/** The native call sequence the Pi adapter drives, ending in the effect callback. */
async function dispatch(
  policy: NativePolicy,
  permit: Permit,
  effects: { n: number },
) {
  policy.authorize(permit as never);
  policy.reserve(permit.toolCallId, permit.toolName, undefined);
  await policy.prepare(
    permit.toolCallId,
    permit.toolName,
    ARGS,
    undefined,
    undefined,
  );
  policy.finish(permit.toolCallId, permit.toolName, ARGS, undefined);
  return policy.execute(
    permit.toolCallId,
    permit.toolName,
    ARGS,
    async () => {
      effects.n += 1;
      return { isError: false };
    },
    undefined,
  );
}

/** Settles a dispatch so the effect assertion runs before the error-code assertion. */
const attempt = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (error: unknown) => error as { name?: string; code?: string },
  );
const assertDenied = (
  error: { name?: string; code?: string } | undefined,
  code: string,
) => {
  assert.equal(error?.name, "AdmissionError");
  assert.equal(error?.code, code);
};

for (const capability of [
  "fs.read",
  "net.provider",
  "fs.write",
  "shell.run",
] as const) {
  test(`public check revalidates a revoked ${capability} grant after an await`, async (t) => {
    const f = fixture(t);
    const once = capability === "fs.write" || capability === "shell.run";
    const extra = capability === "net.provider" ? { origin: ORIGIN } : {};
    const grantId = f.mint(capability, once ? "a1" : undefined, extra);
    const policy = f.policy();
    const permit = f.permit("a1", grantId, capability, extra);
    policy.authorize(permit as never);
    assert.doesNotThrow(() =>
      policy.check(permit.toolCallId, permit.toolName, undefined),
    );
    await Promise.resolve();
    const other = Store.open(f.path);
    try {
      other.revokeGrant(grantId, caller);
    } finally {
      other.close();
    }
    // The host projection and run still contain this ID: Store is authoritative.
    assert.throws(
      () => policy.check(permit.toolCallId, permit.toolName, undefined),
      { name: "AdmissionError", code: "GRANT_REVOKED" },
      "a revoked Store grant must be denied by the public check",
    );
    assert.deepEqual(f.states("a1"), ["denied"]);
  });
}

test("public check observes changed workspace identity on the same permit", (t) => {
  const f = fixture(t);
  const grantId = f.mint("fs.read");
  const policy = f.policy();
  const permit = f.permit("a1", grantId, "fs.read");
  policy.authorize(permit as never);
  assert.doesNotThrow(() =>
    policy.check(permit.toolCallId, permit.toolName, undefined),
  );
  f.identity.set(f.workspaceId, { ...IDENTITY, fileId: "2" });
  assert.throws(
    () => policy.check(permit.toolCallId, permit.toolName, undefined),
    { name: "AdmissionError", code: "WORKSPACE_IDENTITY_CHANGED" },
    "a changed identity must be denied by the public check",
  );
  assert.deepEqual(f.states("a1"), ["denied"]);
});

test("public check accepts its running once action but rejects completed replay", async (t) => {
  const f = fixture(t);
  const grantId = f.mint("fs.write", "a1");
  const policy = f.policy();
  const permit = f.permit("a1", grantId, "fs.write");
  policy.authorize(permit as never);
  policy.reserve(permit.toolCallId, permit.toolName, undefined);
  await policy.prepare(
    permit.toolCallId,
    permit.toolName,
    ARGS,
    undefined,
    undefined,
  );
  policy.finish(permit.toolCallId, permit.toolName, ARGS, undefined);
  let effects = 0;
  await policy.execute(
    permit.toolCallId,
    permit.toolName,
    ARGS,
    async () => {
      policy.check(permit.toolCallId, permit.toolName, undefined);
      effects += 1;
      return { isError: false };
    },
    undefined,
  );
  assert.equal(
    effects,
    1,
    "the same running action retains its consumed grant",
  );
  assert.throws(
    () => policy.check(permit.toolCallId, permit.toolName, undefined),
    { name: "AdmissionError", code: "GRANT_CONSUMED" },
    "public check must reject a completed once action as replay",
  );
});

test("revocation during canonicalization denies before intent receipts", async (t) => {
  const f = fixture(t);
  const grantId = f.mint("fs.read");
  const policy = f.policy();
  const permit = f.permit("a1", grantId, "fs.read");
  policy.authorize(permit as never);
  policy.reserve(permit.toolCallId, permit.toolName, undefined);
  await policy.prepare(
    permit.toolCallId,
    permit.toolName,
    ARGS,
    undefined,
    undefined,
  );
  policy.finish(permit.toolCallId, permit.toolName, ARGS, undefined);
  let revoked = false;
  let effects = 0;
  const args = new Proxy(ARGS, {
    getOwnPropertyDescriptor(target, key) {
      if (!revoked) {
        f.store.revokeGrant(grantId, caller);
        revoked = true;
      }
      return Reflect.getOwnPropertyDescriptor(target, key);
    },
  });
  const error = await attempt(
    policy.execute(
      permit.toolCallId,
      permit.toolName,
      args,
      async () => {
        effects += 1;
        return { isError: false };
      },
      undefined,
    ),
  );
  assert.equal(revoked, true, "canonicalization revoked the real Store grant");
  assert.equal(
    effects,
    0,
    "revocation during canonicalization prevents effect",
  );
  assertDenied(error, "GRANT_REVOKED");
  assert.deepEqual(
    f.states("a1"),
    ["proposed", "denied"],
    "the pre-intent recheck prevents approval under revoked authority",
  );
});

test("an fs.write with a once grant runs once and consumes the grant with its running receipt", async (t) => {
  const f = fixture(t);
  const grantId = f.mint("fs.write", "a1");
  const effects = { n: 0 };
  await dispatch(f.policy(), f.permit("a1", grantId, "fs.write"), effects);
  assert.equal(effects.n, 1);
  assert.deepEqual(f.states("a1"), [
    "proposed",
    "approved",
    "running",
    "completed",
  ]);
  const consumed = f.store
    .list(f.workspaceId)
    .records.find(({ record }) => record.recordId === `${grantId}.consumed`);
  const running = f.store
    .list("w-demo")
    .records.find(
      ({ kind, record }) =>
        kind === "action" && (record as { state: string }).state === "running",
    );
  assert.ok(consumed && running && consumed.seq === running.seq + 1);
});

test("an fs.write without a grant is denied and never reaches the effect", async (t) => {
  const f = fixture(t);
  const effects = { n: 0 };
  const error = await attempt(
    dispatch(
      f.policy(),
      f.permit("a1", f.allow("grant-missing"), "fs.write"),
      effects,
    ),
  );
  assert.equal(effects.n, 0, "write without grant must not run");
  assertDenied(error, "GRANT_REQUIRED");
  // Rejected before reserve: record denial without inventing a proposal.
  assert.deepEqual(f.states("a1"), ["denied"]);
});

test("a consumed once grant cannot be reused by another action", async (t) => {
  const f = fixture(t);
  const grantId = f.mint("fs.write", "a1");
  const effects = { n: 0 };
  await dispatch(f.policy(), f.permit("a1", grantId, "fs.write"), effects);
  assert.throws(
    () =>
      f.store.checkOnceGrantForActive({
        grantId,
        workspaceId: f.workspaceId,
        sessionId: caller.sessionId,
        capability: "fs.write",
        actionId: "a1",
        argumentsDigest: DIGEST,
        observedIdentity: IDENTITY,
      }),
    { code: "GRANT_CONSUMED" },
    "a completed action's consumption is a replay, not an active use",
  );
  const error = await attempt(
    dispatch(f.policy(), f.permit("a2", grantId, "fs.write"), effects),
  );
  assert.equal(effects.n, 1, "a reused once grant must not run again");
  assertDenied(error, "GRANT_CONSUMED");
  // Rejected before reserve: record denial without inventing a proposal.
  assert.deepEqual(f.states("a2"), ["denied"]);
});

test("a revocation between consumption and callback denies the effect and records it", async (t) => {
  const f = fixture(t);
  const grantId = f.mint("shell.run", "a1");
  const consume = f.store.consumeOnceGrant.bind(f.store);
  f.store.consumeOnceGrant = (...args: Parameters<typeof consume>) => {
    const result = consume(...args);
    f.store.revokeGrant(grantId, caller);
    return result;
  };
  const effects = { n: 0 };
  const error = await attempt(
    dispatch(f.policy(), f.permit("a1", grantId, "shell.run"), effects),
  );
  assert.equal(effects.n, 0, "revoked grant must not reach the callback");
  assertDenied(error, "GRANT_REVOKED");
  assert.deepEqual(f.states("a1"), [
    "proposed",
    "approved",
    "running",
    "denied",
  ]);
  assert.equal(
    f.store.list("w-demo").records.some(({ kind }) => kind === "outcome"),
    false,
    "no success is recorded for a denied effect",
  );
});

test("a changed directory identity between calls is WORKSPACE_IDENTITY_CHANGED", async (t) => {
  const f = fixture(t);
  const grantId = f.mint("fs.read");
  const policy = f.policy();
  const effects = { n: 0 };
  await dispatch(policy, f.permit("r1", grantId, "fs.read"), effects);
  await dispatch(policy, f.permit("r2", grantId, "fs.read"), effects);
  assert.equal(effects.n, 2, "a session read grant works across calls");
  f.identity.set(f.workspaceId, { ...IDENTITY, fileId: "2" });
  const error = await attempt(
    dispatch(policy, f.permit("r3", grantId, "fs.read"), effects),
  );
  assert.equal(effects.n, 2, "changed identity must not run");
  assertDenied(error, "WORKSPACE_IDENTITY_CHANGED");
  // Rejected before reserve: record denial without inventing a proposal.
  assert.deepEqual(f.states("r3"), ["denied"]);
});

test("a permit without an explicit capability is denied before any grant use", async (t) => {
  const f = fixture(t);
  const grantId = f.mint("fs.write", "a1");
  const effects = { n: 0 };
  const error = await attempt(
    dispatch(f.policy(), f.permit("a1", grantId, undefined), effects),
  );
  assert.equal(effects.n, 0, "missing capability must not run");
  assertDenied(error, "CAPABILITY_REQUIRED");
  assert.doesNotThrow(() =>
    f.store.checkOnceGrantForActive({
      grantId,
      workspaceId: f.workspaceId,
      sessionId: caller.sessionId,
      capability: "fs.write",
      actionId: "a1",
      argumentsDigest: DIGEST,
      observedIdentity: IDENTITY,
    }),
  );
});

test("a write permit cannot borrow a session read grant", async (t) => {
  const f = fixture(t);
  const effects = { n: 0 };
  const error = await attempt(
    dispatch(
      f.policy(),
      f.permit("a1", f.mint("fs.read"), "fs.write"),
      effects,
    ),
  );
  assert.equal(effects.n, 0, "a borrowed read grant must not run a write");
  assertDenied(error, "GRANT_MISMATCH");
});

test("concurrent execution of the same action runs the effect once", async (t) => {
  const f = fixture(t);
  const grantId = f.mint("fs.write", "a1");
  const policy = f.policy();
  const permit = f.permit("a1", grantId, "fs.write");
  policy.authorize(permit as never);
  policy.reserve(permit.toolCallId, permit.toolName, undefined);
  await policy.prepare(
    permit.toolCallId,
    permit.toolName,
    ARGS,
    undefined,
    undefined,
  );
  policy.finish(permit.toolCallId, permit.toolName, ARGS, undefined);
  const effects = { n: 0 };
  const execute = () =>
    policy.execute(
      permit.toolCallId,
      permit.toolName,
      ARGS,
      async () => {
        effects.n += 1;
        return { isError: false };
      },
      undefined,
    );
  const results = await Promise.allSettled([execute(), execute()]);
  assert.deepEqual(results.map(({ status }) => status).sort(), [
    "fulfilled",
    "rejected",
  ]);
  assert.equal(effects.n, 1, "the same action runs once");
  const other = Store.open(f.path);
  const error = await attempt(
    dispatch(f.policy(other), { ...permit, toolCallId: "call-again" }, effects),
  ).finally(() => other.close());
  assert.equal(effects.n, 1, "another handle cannot rerun the action");
  assertDenied(error, "ACTION_REQUIRES_RECONCILIATION");
});

test("net.provider requires the permit origin to match the grant origin", async (t) => {
  const f = fixture(t);
  const grantId = f.mint("net.provider", undefined, { origin: ORIGIN });
  const effects = { n: 0 };
  const foreign = await attempt(
    dispatch(
      f.policy(),
      f.permit("n1", grantId, "net.provider", {
        origin: "https://other.example.com:443",
      }),
      effects,
    ),
  );
  const missing = await attempt(
    dispatch(f.policy(), f.permit("n2", grantId, "net.provider"), effects),
  );
  assert.equal(effects.n, 0, "a foreign origin must not run");
  assertDenied(foreign, "GRANT_MISMATCH");
  assertDenied(missing, "GRANT_MISMATCH");
  await dispatch(
    f.policy(),
    f.permit("n3", grantId, "net.provider", { origin: ORIGIN }),
    effects,
  );
  assert.equal(effects.n, 1);
});

test("removing a grant guard fails its behavior assertion", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "td13-policy-mutation-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const loader = join(dir, "mutation.mjs");
  writeFileSync(
    loader,
    `import { registerHooks } from "node:module";
const cuts = JSON.parse(process.env.SPLYCE_GRANT_MUTATION);
registerHooks({ load(url, context, next) {
  const result = next(url, context);
  const mine = cuts.filter((entry) => url.endsWith(entry.file));
  if (mine.length === 0) return result;
  let source = String(result.source);
  for (const cut of mine) {
    const count = source.split(cut.from).length - 1;
    if (count < 1 || (cut.nth === undefined && count !== 1)) throw new Error("mutation target missing: " + cut.from);
    let at = -1;
    for (let i = 0; i <= (cut.nth ?? 0); i++) at = source.indexOf(cut.from, at + 1);
    source = source.slice(0, at) + cut.to + source.slice(at + cut.from.length);
  }
  return { ...result, source };
}});
`,
  );
  const policy = "/splyce-pi/dist/policy.js";
  const store = "/splyce-pi/dist/store.js";
  // A nested test run must not inherit the parent runner's context.
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => key !== "NODE_TEST_CONTEXT"),
  );
  const self = fileURLToPath(import.meta.url);
  const grants = fileURLToPath(new URL("./grants.ts", import.meta.url));
  for (const [name, cuts, file, pattern, observation] of [
    [
      "pre-intent revalidation after argument canonicalization",
      [{ file: policy, from: "this.requireGrant(permit, once);", to: "" }],
      self,
      "revocation during canonicalization",
      "the pre-intent recheck prevents approval under revoked authority",
    ],
    [
      "Store grant revalidation on every public check",
      [
        {
          file: policy,
          from: "this.requireGrant(permit, ONCE_CAPABILITIES.has(permit.capability));",
          to: "",
        },
      ],
      self,
      "public check revalidates a revoked",
      "a revoked Store grant must be denied by the public check",
    ],
    [
      "post-consumption revalidation",
      [
        {
          file: policy,
          from: "// No asynchronous callback separates the final fences from executor handoff.\n        this.check(toolCallId, toolName, signal);",
          to: "",
        },
      ],
      self,
      "revocation between consumption",
      "revoked grant must not reach the callback",
    ],
    [
      "explicit capability",
      [
        {
          file: policy,
          from: 'this.deny(permit, "CAPABILITY_REQUIRED");',
          to: ";",
        },
      ],
      self,
      "without an explicit capability",
      "CAPABILITY_REQUIRED",
    ],
    [
      "origin match",
      [{ file: store, from: "grant.origin !== use.origin", to: "false" }],
      self,
      "net.provider requires",
      "a foreign origin must not run",
    ],
    [
      "active-consumption replay check",
      [{ file: store, from: "latest.seq < consumedSeq &&", to: "true ||" }],
      self,
      "cannot be reused by another action",
      "a completed action's consumption is a replay",
    ],
    [
      "superseded workspace filter",
      [
        {
          file: store,
          from: "WHERE p.rowid = (SELECT MAX(q.rowid) FROM workspace_paths q WHERE q.canonical_path = p.canonical_path) ",
          to: "WHERE 1 = 1 ",
        },
      ],
      grants,
      "listWorkspaces returns current",
      "superseded workspaces are not listed",
    ],
    [
      "identity validation before idempotent return",
      [
        {
          file: store,
          from: "!canonicalUnsigned(volumeSerial, 0xffffffffn) ||",
          to: "false && !canonicalUnsigned(volumeSerial, 0xffffffffn) &&",
        },
      ],
      grants,
      "legacy non-decimal",
      "same legacy encoding is not equated",
    ],
  ] as const) {
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        pathToFileURL(loader).href,
        "--test",
        "--test-name-pattern",
        pattern,
        file,
      ],
      {
        encoding: "utf8",
        windowsHide: true,
        timeout: 60000,
        env: { ...environment, SPLYCE_GRANT_MUTATION: JSON.stringify(cuts) },
      },
    );
    const output = result.stdout + result.stderr;
    assert.ok(
      !output.includes("mutation target missing"),
      `${name} mutation target missing: ${output}`,
    );
    assert.notEqual(result.status, 0, `${name} removal must fail: ${output}`);
    assert.ok(
      output.includes(observation),
      `${name} must fail its behavior assertion: ${output}`,
    );
  }
});
