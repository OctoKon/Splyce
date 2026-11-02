// TD-70 / E1_readonly_subagents — delegated children on the real Pi Agent loop
// (built pi-agent-core), owned by a native Splyce owner, admitted through
// NativePolicy against a real Store, with real Pi tools on real files. Only the
// provider stream is a fixture; worktrees are the real @splyce/index
// WorktreeManager on a real temp repo; grants are real Store grants on a real
// admitted workspace (TD-13), identity from the in-memory native port fixture.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { Agent, bindSplyceToolAdmission } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { createBashTool } from "@earendil-works/pi-coding-agent";
import {
  CodeIndex,
  codeIndexTools,
} from "../../packages/splyce-index/dist/index.js";
import { WorktreeManager } from "../../packages/splyce-index/dist/worktrees.js";
import { RevisionFence } from "../../packages/splyce-pi/dist/admission.js";
import { AdmissionError } from "../../packages/splyce-pi/dist/policy.js";
import { Store, StoreError } from "../../packages/splyce-pi/dist/store.js";
import { isSecretPath } from "../../packages/splyce-pi/dist/secret-path.js";
import {
  type SpawnResult,
  SubagentError,
  SubagentSupervisor,
  subagentTools,
} from "../../packages/splyce-pi/dist/subagents.js";
import { childToolFactories } from "../../packages/splyce-pi/src/subagent-tools.mjs";
import { createSplyceOwner } from "../../vendor/pi/packages/agent/dist/splyce-readiness.js";
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
const SECRET = "sk-fixture-SECRET-0123456789";
const CAPS = ["fs.read", "code.index", "fs.write", "shell.run"] as const;
type Msg = Record<string, unknown>;
type Step = (input: {
  task: string;
  turn: number;
  signal: AbortSignal;
  messages: Msg[];
}) => Msg | Promise<Msg>;

const usage = (totalTokens = 10) => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});
const message = (content: unknown[], stopReason: string, tokens?: number) => ({
  role: "assistant",
  content,
  api: "openai-completions",
  provider: "fixture",
  model: "fixture",
  stopReason,
  timestamp: 0,
  usage: usage(tokens),
});
const say = (text: string, tokens?: number) =>
  message([{ type: "text", text }], "stop", tokens);
let callSeq = 0;
const call = (name: string, args: unknown, tokens?: number) =>
  message(
    [
      {
        type: "toolCall",
        id: `call-${++callSeq}`,
        name,
        arguments: args,
      },
    ],
    "toolUse",
    tokens,
  );
const text = (value: unknown): string =>
  typeof value === "string"
    ? value
    : Array.isArray(value)
      ? value.map((part) => (part as { text?: string }).text ?? "").join("")
      : "";
const until = (signal: AbortSignal, gate?: Promise<unknown>) =>
  new Promise<"aborted" | "open">((done) => {
    if (signal.aborted) return done("aborted");
    signal.addEventListener("abort", () => done("aborted"), { once: true });
    gate?.then(() => done("open"));
  });

type Store_ = ReturnType<typeof Store.open>;
async function harness(
  t: { after: (fn: () => void | Promise<void>) => void },
  steps: Step,
  options: {
    limits?: Record<string, number>;
    tools?: Record<string, unknown>;
    /** Runs before SubagentSupervisor.start (state a crashed run left). */
    beforeStart?: (ctx: {
      store: Store_;
      workspaceId: string;
      worktrees: InstanceType<typeof WorktreeManager>;
    }) => void | Promise<void>;
  } = {},
) {
  const dir = realpathSync.native(
    mkdtempSync(join(tmpdir(), "splyce-subagents-")),
  );
  const workspace = join(dir, "workspace");
  mkdirSync(join(workspace, "src"), { recursive: true });
  writeFileSync(
    join(workspace, "src", "main.ts"),
    'import { helper } from "./helper.js";\nexport function entrypoint() {\n  return helper();\n}\n',
  );
  writeFileSync(
    join(workspace, "src", "helper.ts"),
    "export function helper() {\n  return 42;\n}\n",
  );
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", workspace, ...args], { encoding: "utf8" });
  git("init", "-q");
  git("config", "core.autocrlf", "false");
  git("add", "-A");
  git(
    "-c",
    "user.email=e1@test",
    "-c",
    "user.name=e1",
    "commit",
    "-qm",
    "base",
  );
  const outside = join(dir, "outside.txt");
  writeFileSync(outside, "outside");
  mkdirSync(join(dir, "worktrees"));
  const store = Store.open(join(dir, "store.db"));
  const caller = {
    sessionId: "s1",
    configRevision: "cfg-0",
    profileRevision: "profile1",
    policyRevision: "policy1",
    resolveReference: () => true,
  };
  const { workspaceId } = store.admitWorkspace(
    { canonicalPath: workspace, ...IDENTITY },
    caller,
  );
  store.append(
    {
      kind: "branchAnchor",
      record: {
        ...records.branchAnchor,
        scopeId: workspaceId,
        piSessionId: "s1",
        parentAnchorId: null,
        forkPointEntryId: null,
        activeLeafEntryId: null,
      },
    },
    caller,
  );
  const identity = new MemoryWorkspaceIdentity();
  identity.set(workspaceId, IDENTITY);
  // Children only ever read the admitted workspace: one session fs.read grant.
  const read = store.mintGrant(
    { workspaceId, sessionId: "s1", capability: "fs.read", scope: "session" },
    caller,
  ).grantId;
  const grants = Object.fromEntries(CAPS.map((c) => [c, read]));
  const run = {
    ...records.run,
    recordId: "rec-run",
    workspaceId,
    grantIds: [read],
  };
  delete run.optionalNote;
  store.append({ kind: "run", record: run }, caller);
  const ownership = store.acquireWorkspace(workspaceId, "s1");
  const fence = new RevisionFence(
    { effectiveRevision: (scope: string) => store.configRevision(scope) },
    {
      scopeId: "w-demo",
      profileRevision: "profile1",
      policyRevision: "policy1",
      grantIds: [read],
    },
  );
  const owner = createSplyceOwner(() => {});
  const model = {
    id: "fixture",
    name: "Fixture",
    provider: "fixture",
    api: "openai-completions",
    baseUrl: "http://127.0.0.1:1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100000,
    maxTokens: 1000,
  };
  owner.bind(model, "model");
  let inFlight = 0;
  let maxInFlight = 0;
  const prompts: string[] = [];
  const streamFn = async (
    _model: unknown,
    context: { messages: Msg[] },
    opts: { signal?: AbortSignal },
  ) => {
    const task = text(context.messages.find((m) => m.role === "user")?.content);
    const turn = context.messages.filter((m) => m.role === "assistant").length;
    if (turn === 0) prompts.push(task);
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    const stream = createAssistantMessageEventStream();
    try {
      const reply = await steps({
        task,
        turn,
        signal: opts.signal ?? new AbortController().signal,
        messages: context.messages,
      });
      stream.push({ type: "done", reason: reply.stopReason, message: reply });
      stream.end(reply);
    } catch {
      const aborted = message([], "aborted");
      stream.push({ type: "error", reason: "aborted", error: aborted });
      stream.end(aborted);
    } finally {
      inFlight--;
    }
    return stream;
  };
  const parentAbort = new AbortController();
  let supervisorRef: SubagentSupervisor | undefined;
  const worktrees = new WorktreeManager({
    cacheDir: join(dir, "worktrees"),
    workspaces: {
      workspace: (id: string) =>
        id === workspaceId ? { canonicalPath: workspace } : undefined,
    },
    consumeGrant: (grantId, act) =>
      supervisorRef!.confirmApplyGrant(grantId, act),
    isChildLive: (childId) => supervisorRef?.isChildLive(childId) ?? false,
    maxPerWorkspace: 8,
  });
  let index: CodeIndex | undefined;
  const setup = (async () => {
    index = await CodeIndex.open({
      root: workspace,
      cacheDir: join(dir, "cache"),
    });
  })();
  await options.beforeStart?.({ store, workspaceId, worktrees });
  const supervisor = await SubagentSupervisor.start({
    store,
    caller,
    fence,
    identity,
    parent: {
      runId: "r1",
      runRecordId: "rec-run",
      scopeId: "w-demo",
      workspaceId,
      workspaceRoot: workspace,
      baseRevision: "A",
      ownership,
      grants,
      signal: parentAbort.signal,
    },
    owner,
    pi: { Agent, bindSplyceToolAdmission },
    model,
    streamFn,
    tools: {
      ...childToolFactories({ codeTools: () => codeIndexTools(index!) }),
      "shell.run": (root: string) => [createBashTool(root)],
      ...options.tools,
    },
    worktrees,
    redact: (value: string) => value.replaceAll(SECRET, "[redacted]"),
    ...(options.limits ? { limits: options.limits } : {}),
  });
  supervisorRef = supervisor;
  const live = () => worktrees.list(workspaceId).length;
  t.after(async () => {
    parentAbort.abort();
    owner.dispose();
    store.close();
    for (const w of worktrees.list(workspaceId))
      await worktrees.discard(w.worktreeId);
    rmSync(dir, {
      recursive: true,
      force: true,
      maxRetries: 6,
      retryDelay: 100,
    });
  });
  const events = () => store.replayEvents("w-demo", "s1");
  const kinds = (childId?: string) =>
    events()
      .filter(
        (e) =>
          e.kind.startsWith("child.") &&
          (!childId || (e.payload as { childId: string }).childId === childId),
      )
      .map((e) => e.kind);
  const actions = () =>
    store
      .list("w-demo")
      .records.filter(({ kind }) => kind === "action")
      .map(({ record }) => record as Record<string, unknown>);
  /** The user approves exactly this act: an fs.write once grant on the run and live fence. */
  const approve = (act: { actionId: string; argumentsDigest: string }) => {
    const grantId = store.mintGrant(
      {
        workspaceId,
        sessionId: "s1",
        capability: "fs.write",
        scope: "once",
        actionId: act.actionId,
        argumentsDigest: act.argumentsDigest,
      },
      caller,
    ).grantId;
    const latest = store
      .list("w-demo")
      .records.filter(({ kind }) => kind === "run")
      .at(-1)!.record as Record<string, unknown>;
    store.append(
      {
        kind: "run",
        record: {
          ...latest,
          recordId: `rec-run-${grantId}`,
          grantIds: [...(latest.grantIds as string[]), grantId],
        },
      },
      caller,
    );
    fence.grantAdded(grantId);
    return grantId;
  };
  return {
    dir,
    workspace,
    workspaceId,
    outside,
    store,
    fence,
    supervisor,
    parentAbort,
    worktrees,
    approve,
    live,
    events,
    kinds,
    actions,
    prompts,
    maxInFlight: () => maxInFlight,
    ready: setup,
    spawn: async (args: unknown) => {
      await setup;
      const [tool] = subagentTools(supervisor);
      return (await tool!.execute(args)) as SpawnResult;
    },
  };
}

test("read child cites code index and read results through admitted Pi tools; events replay", async (t) => {
  const h = await harness(
    t,
    ({ turn }) =>
      [
        call("code_search", { query: "entrypoint" }),
        call("read", { path: "src/helper.ts", offset: 1 }),
        say(`entrypoint calls helper (src/main.ts:2). key=${SECRET}`),
      ][turn]!,
  );
  const { results } = await h.spawn({
    tasks: [{ prompt: "find the entrypoint" }],
  });
  const [r] = results;
  assert.equal(r!.status, "completed");
  if (r!.status !== "completed") return;
  assert.ok(
    r.citations.some((c) => c.path === "src/main.ts" && c.line === 2),
    JSON.stringify(r.citations),
  );
  assert.ok(
    r.citations.some((c) => c.path === "src/helper.ts" && c.line === 1),
  );
  assert.deepEqual(h.kinds(r.childId), [
    "child.started",
    "child.progress",
    "child.progress",
    "child.progress",
    "child.completed",
  ]);
  // Every child tool call is a receipted parent-run action under the child's grant.
  const done = h.actions().filter((a) => a.state === "completed");
  assert.deepEqual(done.map((a) => a.capabilityId).sort(), [
    "code.index",
    "fs.read",
  ]);
  const replayed = JSON.stringify(h.events());
  assert.ok(!replayed.includes(SECRET), "child events must be redacted");
  assert.ok(replayed.includes("[redacted]"));
  assert.ok(!r.summary.includes(SECRET));
  // Published child.* contract (store-validated on commit, replayed as-is).
  const progress = h
    .events()
    .filter((e) => e.kind.startsWith("child."))
    .map((e) => e.payload as Record<string, unknown>);
  assert.deepEqual(
    progress.map((p) => [p.status, (p.budget as { used: number }).used]),
    [
      ["running", 0],
      ["running", 10],
      ["running", 20],
      ["running", 30],
      ["completed", 30],
    ],
  );
  const completed = progress.at(-1)!;
  assert.equal(completed.parentRunId, "r1");
  assert.equal(completed.childId, r.childId);
  assert.deepEqual(completed.budget, { used: 30, limit: 200_000 });
  assert.deepEqual(completed.citations, r.citations);
  assert.equal(completed.summary, r.summary);
  assert.equal("diff" in completed, false, "read children have no diff");
});

test("read child is denied write and shell tools even though the parent holds them", async (t) => {
  const h = await harness(t, ({ task }) =>
    task.includes("write")
      ? call("write", { path: "src/main.ts", content: "pwned" })
      : call("bash", { command: "echo pwned > src/main.ts" }),
  );
  const before = readFileSync(join(h.workspace, "src", "main.ts"), "utf8");
  const { results } = await h.spawn({
    tasks: [{ prompt: "write it" }, { prompt: "shell it" }],
  });
  for (const r of results) {
    assert.equal(r.status, "failed");
    if (r.status === "failed") assert.equal(r.reason, "CAPABILITY_DENIED");
  }
  assert.equal(
    readFileSync(join(h.workspace, "src", "main.ts"), "utf8"),
    before,
  );
  assert.equal(
    h
      .events()
      .filter(
        (e) =>
          e.kind === "child.failed" &&
          (e.payload as { reason: string }).reason === "CAPABILITY_DENIED",
      ).length,
    2,
  );
  // Requesting the capability up front is a typed denial before any child starts.
  await assert.rejects(
    h.spawn({ tasks: [{ prompt: "x", capabilities: ["fs.write"] }] }),
    (e: unknown) =>
      e instanceof SubagentError && e.code === "CAPABILITY_DENIED",
  );
  await assert.rejects(
    h.spawn({
      tasks: [{ prompt: "x", mode: "read", capabilities: ["shell.run"] }],
    }),
    (e: unknown) =>
      e instanceof SubagentError && e.code === "CAPABILITY_DENIED",
  );
});

test("read child path arguments are confined to the workspace", async (t) => {
  const h = await harness(t, ({ turn }) =>
    turn === 0 ? call("read", { path: "../outside.txt" }) : say("read it"),
  );
  const { results } = await h.spawn({ tasks: [{ prompt: "escape" }] });
  assert.equal(results[0]!.status, "failed");
  if (results[0]!.status === "failed")
    assert.equal(results[0]!.reason, "PATH_OUTSIDE_WORKSPACE");
});

for (const mode of ["read", "write"] as const)
  for (const form of [
    "at-drive",
    "at-parent",
    "drive",
    "url",
    "home",
    "device",
    "unicode",
  ])
    test(`${mode} child rejects Pi path alias ${form}`, async (t) => {
      let path = "";
      const returned: string[] = [];
      const h = await harness(t, ({ turn, messages }) => {
        returned.push(
          JSON.stringify(messages.filter((m) => m.role === "toolResult")),
        );
        return turn === 0
          ? call(mode === "write" ? "write" : "read", {
              path,
              ...(mode === "write" ? { content: "changed" } : {}),
            })
          : say("done");
      });
      const drive = h.outside
        .replace(/^([A-Za-z]):[\\/]/, (_, d: string) => `/${d.toLowerCase()}/`)
        .replaceAll("\\", "/");
      path = {
        "at-drive": `@${drive}`,
        "at-parent": "@../../outside.txt",
        drive,
        url: pathToFileURL(h.outside).href,
        home: "~/outside.txt",
        device: `\\\\?\\${h.outside}`,
        unicode: "src/ali\u00a0as.ts",
      }[form]!;
      writeFileSync(h.outside, "private outside sentinel");
      const { results } = await h.spawn({ tasks: [{ prompt: form, mode }] });
      assert.equal(results[0]!.status, "failed");
      if (results[0]!.status === "failed")
        assert.equal(results[0]!.reason, "PATH_OUTSIDE_WORKSPACE");
      assert.equal(readFileSync(h.outside, "utf8"), "private outside sentinel");
      assert.ok(!returned.join("").includes("private outside sentinel"));
      assert.equal(h.actions().length, 0, "denial precedes native receipts");
      assert.equal(h.live(), 0);
    });

for (const mode of ["read", "write"] as const)
  for (const path of [".env", "server.pem", ".ssh/config"])
    test(`${mode} child denies secret path ${path} without returning content`, async (t) => {
      const returned: string[] = [];
      const h = await harness(t, ({ turn, messages }) => {
        returned.push(JSON.stringify(messages));
        return turn === 0 ? call("read", { path }) : say("done");
      });
      mkdirSync(join(h.workspace, ".ssh"));
      writeFileSync(join(h.workspace, path), "private child fixture value");
      execFileSync("git", ["-C", h.workspace, "add", "-A"]);
      execFileSync("git", [
        "-C",
        h.workspace,
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@t",
        "commit",
        "-qm",
        "fixture",
      ]);
      const { results } = await h.spawn({ tasks: [{ prompt: "read", mode }] });
      assert.equal(results[0]!.status, "failed");
      if (results[0]!.status === "failed")
        assert.equal(results[0]!.reason, "POLICY_DENIED");
      assert.ok(!returned.join("").includes("private child fixture value"));
      assert.equal(h.actions().length, 0);
    });

test("secret path matching normalizes every Windows path segment", () => {
  for (const path of [
    ".env.",
    ".env ",
    ".ENV",
    "id_rsa::$DATA",
    ".env:x",
    "src\\.SSH. \\config",
    "src/.aws:stream/config",
    "src/.gnupg /config",
  ])
    assert.equal(isSecretPath(path), true, path);
  assert.equal(isSecretPath("src/.ENV.EXAMPLE. "), false);
  assert.equal(isSecretPath("src/ordinary.txt"), false);
});

for (const mode of ["read", "write"] as const)
  for (const path of [
    ".env.",
    ".env ",
    ".ENV",
    "id_rsa::$DATA",
    ".env:x",
    ".SSH. /config",
    ".aws:stream/config",
    ".gnupg /config",
  ])
    test(`${mode} child denies Windows secret alias ${path}`, async (t) => {
      const returned: string[] = [];
      const factories = childToolFactories();
      const roots: string[] = [];
      const h = await harness(
        t,
        ({ turn, messages }) => {
          returned.push(JSON.stringify(messages));
          return turn === 0
            ? call(mode, {
                path,
                ...(mode === "write" ? { content: "changed" } : {}),
              })
            : say("done");
        },
        {
          tools: {
            "fs.read": (root: string) => {
              roots.push(root);
              writeFileSync(join(root, ".env"), "private alias fixture value");
              writeFileSync(
                join(root, "id_rsa"),
                "private alias fixture value",
              );
              for (const dir of [".ssh", ".aws", ".gnupg"]) {
                mkdirSync(join(root, dir));
                writeFileSync(
                  join(root, dir, "config"),
                  "private alias fixture value",
                );
              }
              return factories["fs.read"](root);
            },
          },
        },
      );
      const { results } = await h.spawn({ tasks: [{ prompt: "alias", mode }] });
      assert.equal(results[0]!.status, "failed");
      if (results[0]!.status === "failed")
        assert.equal(results[0]!.reason, "POLICY_DENIED");
      assert.ok(!returned.join("").includes("private alias fixture value"));
      assert.ok(
        !JSON.stringify(h.events()).includes("private alias fixture value"),
      );
      assert.equal(h.actions().length, 0, "denial precedes native receipts");
      for (const root of roots)
        for (const file of [".env", "id_rsa"])
          if (existsSync(join(root, file)))
            assert.equal(
              readFileSync(join(root, file), "utf8"),
              "private alias fixture value",
            );
      assert.equal(h.live(), 0);
    });

test("read and write children deny a real Windows 8.3 secret alias", async (t) => {
  if (process.platform !== "win32")
    return t.skip("Windows 8.3 names require Windows");
  const shortName = (file: string) =>
    execFileSync(
      "cmd.exe",
      ["/d", "/c", `for %I in ("${file}") do @echo %~sI`],
      {
        encoding: "utf8",
      },
    )
      .trim()
      .split(/[\\/]/)
      .at(-1)!;
  for (const mode of ["read", "write"] as const) {
    let path = "";
    const returned: string[] = [];
    const factories = childToolFactories();
    const h = await harness(
      t,
      ({ turn, messages }) => {
        returned.push(JSON.stringify(messages));
        return turn === 0
          ? call(mode, {
              path,
              ...(mode === "write" ? { content: "changed" } : {}),
            })
          : say("done");
      },
      {
        tools: {
          "fs.read": (root: string) => {
            const file = join(root, ".env.production");
            writeFileSync(file, "private short-name fixture value");
            path = shortName(file);
            assert.match(path, /~\d/);
            assert.equal(
              realpathSync.native(join(root, path)),
              realpathSync.native(file),
            );
            return factories["fs.read"](root);
          },
        },
      },
    );
    const probe = join(h.workspace, ".env.production");
    await h.ready;
    writeFileSync(probe, "private short-name fixture value");
    if (!/~\d/.test(shortName(probe)))
      return t.skip("8.3 short names are disabled on this filesystem");
    const { results } = await h.spawn({
      tasks: [{ prompt: "short alias", mode }],
    });
    assert.equal(results[0]!.status, "failed");
    if (results[0]!.status === "failed")
      assert.equal(results[0]!.reason, "POLICY_DENIED");
    assert.ok(!returned.join("").includes("private short-name fixture value"));
    assert.equal(h.actions().length, 0);
    assert.equal(h.live(), 0);
  }
});

test("read child refuses unchecked Pi missing-file aliases", async (t) => {
  const returned: string[] = [];
  const h = await harness(t, ({ turn, messages }) => {
    returned.push(JSON.stringify(messages));
    return turn === 0
      ? call("read", { path: "alias'/outside.txt" })
      : say("done");
  });
  writeFileSync(h.outside, "private fallback fixture value");
  symlinkSync(
    h.dir,
    join(h.workspace, "alias’"),
    process.platform === "win32" ? "junction" : "dir",
  );
  const { results } = await h.spawn({ tasks: [{ prompt: "read alias" }] });
  assert.equal(results[0]!.status, "failed");
  if (results[0]!.status === "failed")
    assert.equal(results[0]!.reason, "PATH_OUTSIDE_WORKSPACE");
  assert.ok(!returned.join("").includes("private fallback fixture value"));
  assert.equal(h.actions().length, 0);
});

test("read child denies canonical secret aliases and permits .env.example", async (t) => {
  const returned: string[] = [];
  const h = await harness(t, ({ task, turn, messages }) => {
    returned.push(JSON.stringify(messages));
    return turn === 0 ? call("read", { path: task }) : say("done");
  });
  mkdirSync(join(h.workspace, ".ssh"));
  writeFileSync(
    join(h.workspace, ".ssh", "config"),
    "private alias fixture value",
  );
  writeFileSync(join(h.workspace, ".env.example"), "allowed example");
  symlinkSync(
    join(h.workspace, ".ssh"),
    join(h.workspace, "public"),
    process.platform === "win32" ? "junction" : "dir",
  );
  const { results } = await h.spawn({
    tasks: [{ prompt: "public/config" }, { prompt: ".env.example" }],
  });
  assert.equal(results[0]!.status, "failed");
  if (results[0]!.status === "failed")
    assert.equal(results[0]!.reason, "POLICY_DENIED");
  assert.equal(results[1]!.status, "completed");
  assert.ok(!returned.join("").includes("private alias fixture value"));
  assert.ok(returned.join("").includes("allowed example"));
});

for (const tool of ["write", "edit"])
  test(`write child denies ${tool} to secret paths before mutation`, async (t) => {
    const h = await harness(t, ({ turn }) =>
      turn === 0
        ? call(
            tool,
            tool === "write"
              ? { path: ".env", content: "changed" }
              : { path: ".env", edits: [{ oldText: "old", newText: "new" }] },
          )
        : say("done"),
    );
    writeFileSync(join(h.workspace, ".env"), "old");
    execFileSync("git", ["-C", h.workspace, "add", "-A"]);
    execFileSync("git", [
      "-C",
      h.workspace,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "commit",
      "-qm",
      "fixture",
    ]);
    const { results } = await h.spawn({
      tasks: [{ prompt: tool, mode: "write" }],
    });
    assert.equal(results[0]!.status, "failed");
    if (results[0]!.status === "failed")
      assert.equal(results[0]!.reason, "POLICY_DENIED");
    assert.equal(readFileSync(join(h.workspace, ".env"), "utf8"), "old");
    assert.equal(h.actions().length, 0);
    assert.equal(h.live(), 0);
  });

test("write child denies a new file through a canonical secret directory alias", async (t) => {
  const factories = childToolFactories();
  const h = await harness(
    t,
    ({ turn }) =>
      turn === 0
        ? call("write", { path: "public/new.txt", content: "changed" })
        : say("done"),
    {
      tools: {
        "fs.write": (root: string) => {
          mkdirSync(join(root, ".ssh"));
          symlinkSync(
            join(root, ".ssh"),
            join(root, "public"),
            process.platform === "win32" ? "junction" : "dir",
          );
          return factories["fs.write"](root);
        },
      },
    },
  );
  const { results } = await h.spawn({
    tasks: [{ prompt: "write", mode: "write" }],
  });
  assert.equal(results[0]!.status, "failed");
  if (results[0]!.status === "failed")
    assert.equal(results[0]!.reason, "POLICY_DENIED");
  assert.equal(h.actions().length, 0);
  assert.equal(h.live(), 0);
});

test("turn budget exhaustion fails only that child; parent and sibling continue", async (t) => {
  const h = await harness(t, ({ task, turn }) =>
    task.includes("loop")
      ? call("read", { path: "src/main.ts" })
      : turn === 0
        ? call("read", { path: "src/helper.ts" })
        : say("helper returns 42 (src/helper.ts:2)"),
  );
  const { results } = await h.spawn({
    tasks: [{ prompt: "loop forever" }, { prompt: "answer" }],
    budget: { maxTurns: 2 },
  });
  assert.equal(results[0]!.status, "failed");
  if (results[0]!.status === "failed")
    assert.equal(results[0]!.reason, "BUDGET_TURNS");
  assert.equal(results[1]!.status, "completed");
  assert.equal(h.parentAbort.signal.aborted, false);
  const failed = h.events().find((e) => e.kind === "child.failed");
  assert.equal((failed!.payload as { reason: string }).reason, "BUDGET_TURNS");
});

test("token and wall-clock budgets fail with their reason", async (t) => {
  const h = await harness(t, async ({ task, turn, signal }) => {
    if (task.includes("slow")) {
      await until(signal);
      throw new Error("aborted");
    }
    return turn === 0
      ? call("read", { path: "src/main.ts" }, 500)
      : say("done", 500);
  });
  const { results } = await h.spawn({
    tasks: [{ prompt: "tokens" }, { prompt: "slow" }],
    budget: { maxTokens: 100, wallClockMs: 300 },
  });
  assert.deepEqual(
    results.map((r) => (r.status === "failed" ? r.reason : r.status)),
    ["BUDGET_TOKENS", "BUDGET_WALL_CLOCK"],
  );
});

test("parent cancel cascades to running and queued children; child cancel spares parent and sibling", async (t) => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const h = await harness(t, async ({ task, signal }) => {
    if (task.includes("free")) return say("free done");
    if (
      (await until(signal, task.includes("gated") ? gate : undefined)) ===
      "aborted"
    )
      throw new Error("aborted");
    return say("gated done");
  });
  await h.ready;
  // Child cancel: cancel the blocked child, the gated sibling still completes.
  const pending = h.spawn({
    tasks: [{ prompt: "blocked" }, { prompt: "gated" }],
  });
  while (h.kinds().filter((k) => k === "child.started").length < 2)
    await new Promise((r) => setTimeout(r, 10));
  const blocked = h.events().find((e) => e.kind === "child.started")!;
  assert.equal(
    h.supervisor.cancel((blocked.payload as { childId: string }).childId),
    true,
  );
  release();
  const first = await pending;
  assert.deepEqual(
    first.results.map((r) => r.status),
    ["cancelled", "completed"],
  );
  assert.equal(h.parentAbort.signal.aborted, false);

  // Parent cancel: two running (default concurrency 2) and one queued.
  const all = h.spawn({
    tasks: [
      { prompt: "blocked a" },
      { prompt: "blocked b" },
      { prompt: "free c" },
    ],
  });
  while (h.kinds().filter((k) => k === "child.started").length < 4)
    await new Promise((r) => setTimeout(r, 10));
  h.parentAbort.abort();
  const second = await all;
  assert.deepEqual(
    second.results.map((r) => r.status),
    ["cancelled", "cancelled", "cancelled"],
  );
  assert.equal(h.kinds().filter((k) => k === "child.cancelled").length, 4);
});

test("default concurrency comes from the user budget and bounds in-flight children", async (t) => {
  const h = await harness(t, async () => {
    await new Promise((r) => setTimeout(r, 30));
    return say("ok");
  });
  const { results } = await h.spawn({
    tasks: [1, 2, 3, 4, 5].map((n) => ({ prompt: `task ${n}` })),
  });
  assert.equal(
    results.every((r) => r.status === "completed"),
    true,
  );
  assert.equal(h.supervisor.limits.concurrency, 2);
  assert.equal(h.maxInFlight(), 2);
  const h3 = await harness(
    t,
    async () => {
      await new Promise((r) => setTimeout(r, 30));
      return say("ok");
    },
    { limits: { concurrency: 3 } },
  );
  await h3.spawn({
    tasks: [1, 2, 3, 4, 5].map((n) => ({ prompt: `task ${n}` })),
    budget: { concurrency: 50 },
  });
  assert.equal(h3.maxInFlight(), 3, "a call cannot exceed the user budget");
});

test("dependencies order tasks, pass results forward and fail dependents; team roles prefix prompts", async (t) => {
  const h = await harness(t, ({ task }) =>
    task.includes("explode")
      ? call("write", { path: "x", content: "y" })
      : say(`summary of ${task.split("\n")[0]}`),
  );
  const { team, results } = await h.spawn({
    team: {
      name: "review",
      roles: { scout: "ROLE scout:", judge: "ROLE judge:" },
    },
    tasks: [
      { id: "b", prompt: "second", role: "judge", after: ["a"] },
      { id: "a", prompt: "first", role: "scout" },
      { id: "c", prompt: "explode", after: ["a"] },
      { id: "d", prompt: "never", after: ["c"] },
    ],
  });
  assert.equal(team, "review");
  // Every child.* event names the team and the task's role.
  const failedD = h
    .events()
    .map((e) => e.payload as Record<string, unknown>)
    .find((p) => p.childId === results[3]!.childId)!;
  assert.deepEqual(
    [failedD.team, failedD.role, failedD.status, failedD.reason],
    ["review", undefined, "failed", "DEPENDENCY_FAILED"],
  );
  const judge = h
    .events()
    .map((e) => e.payload as Record<string, unknown>)
    .find((p) => p.childId === results[0]!.childId)!;
  assert.deepEqual([judge.team, judge.role], ["review", "judge"]);
  assert.deepEqual(
    results.map((r) => [r.taskId, r.status]),
    [
      ["b", "completed"],
      ["a", "completed"],
      ["c", "failed"],
      ["d", "failed"],
    ],
  );
  const d = results[3]!;
  if (d.status === "failed") assert.equal(d.reason, "DEPENDENCY_FAILED");
  assert.ok(
    h.prompts.indexOf(h.prompts.find((p) => p.startsWith("ROLE scout:"))!) <
      h.prompts.indexOf(h.prompts.find((p) => p.startsWith("ROLE judge:"))!),
  );
  const second = h.prompts.find((p) => p.startsWith("ROLE judge:"))!;
  assert.match(second, /Result of a:\nsummary of ROLE scout:/u);
  await assert.rejects(
    h.spawn({
      tasks: [
        { id: "x", prompt: "1", after: ["y"] },
        { id: "y", prompt: "2", after: ["x"] },
      ],
    }),
    (e: unknown) => e instanceof SubagentError && e.code === "INVALID_ARGUMENT",
  );
});

test("write child edits only its worktree; subagent.diff binds the once grant that apply consumes", async (t) => {
  const h = await harness(
    t,
    ({ turn }) =>
      [
        call("write", {
          path: "src/new.ts",
          content: `export const added = 1;\nconst key = "${SECRET}";\n`,
        }),
        call("edit", {
          path: "src/helper.ts",
          edits: [{ oldText: "return 42;", newText: "return 43;" }],
        }),
        say("added src/new.ts and bumped helper"),
      ][turn]!,
  );
  const { results } = await h.spawn({
    tasks: [{ prompt: "change it", mode: "write" }],
  });
  const r = results[0]!;
  assert.equal(r.status, "completed", JSON.stringify(r));
  if (r.status !== "completed") return;
  assert.deepEqual(r.files!.map((f) => `${f.status} ${f.path}`).sort(), [
    "added src/new.ts",
    "modified src/helper.ts",
  ]);
  assert.equal(
    existsSync(join(h.workspace, "src", "new.ts")),
    false,
    "parent untouched before apply",
  );
  assert.match(
    readFileSync(join(h.workspace, "src", "helper.ts"), "utf8"),
    /return 42/u,
  );
  // Published child.* contract: the completed event carries the pending diff.
  const completed = h.events().find((e) => e.kind === "child.completed")!;
  const payload = completed.payload as {
    diff: { files: { path: string; status: string }[] };
  };
  assert.deepEqual(
    payload.diff.files.map((f) => `${f.status} ${f.path}`).sort(),
    ["added src/new.ts", "modified src/helper.ts"],
  );
  assert.deepEqual(Object.keys(completed.payload as object).sort(), [
    "budget",
    "childId",
    "citations",
    "diff",
    "parentRunId",
    "status",
    "summary",
  ]);
  // Worktree writes are receipted under the parent's session read grant.
  assert.ok(
    h
      .actions()
      .some((a) => a.capabilityId === "fs.write" && a.state === "completed"),
  );

  // subagent.diff: strict request, redacted bounded display copy, apply act.
  await assert.rejects(
    h.supervisor.diff({ childId: r.childId, extra: 1 }),
    (e: unknown) => e instanceof SubagentError && e.code === "INVALID_ARGUMENT",
  );
  const diff = await h.supervisor.diff({ childId: r.childId });
  assert.equal(diff.childId, r.childId);
  assert.equal(diff.actionId, `worktree.apply:${diff.worktreeId}`);
  assert.deepEqual(diff.files, r.files);
  assert.equal(diff.truncated, false);
  assert.ok(diff.patch.includes("+export const added = 1;"), diff.patch);
  assert.ok(!diff.patch.includes(SECRET), "secret-shaped strings are redacted");
  assert.ok(diff.patch.includes("[REDACTED]"));
  assert.ok(diff.bytes > Buffer.byteLength(diff.patch) - 1);

  // Not approved yet: refused before any receipt, nothing applied, retry stays possible.
  await assert.rejects(
    h.supervisor.apply(r.childId, { grantId: "g-unapproved" }),
    (e: unknown) => e instanceof AdmissionError && e.code === "POLICY_DENIED",
  );
  // A grant approved for another patch does not apply this one.
  const wrong = h.approve({
    actionId: diff.actionId,
    argumentsDigest: `sha256:${"0".repeat(64)}`,
  });
  await assert.rejects(
    h.supervisor.apply(r.childId, { grantId: wrong }),
    (e: unknown) => e instanceof StoreError && e.code === "GRANT_MISMATCH",
  );
  assert.equal(existsSync(join(h.workspace, "src", "new.ts")), false);
  assert.equal(
    h.actions().filter((a) => a.capabilityId === "worktree.apply").length,
    0,
  );

  const grantId = h.approve(diff);
  const applied = await h.supervisor.apply(r.childId, { grantId });
  assert.equal(applied.applied, true);
  assert.match(
    readFileSync(join(h.workspace, "src", "new.ts"), "utf8"),
    /^export const added = 1;\n/u,
  );
  assert.match(
    readFileSync(join(h.workspace, "src", "helper.ts"), "utf8"),
    /return 43/u,
  );
  assert.deepEqual(
    h
      .actions()
      .filter((a) => a.capabilityId === "worktree.apply")
      .map((a) => a.state),
    ["proposed", "approved", "running", "completed"],
  );
  assert.equal(
    h.fence.current().grantIds.includes(grantId),
    false,
    "once-grant leaves live authority",
  );
  assert.equal(h.live(), 0, "applied worktree is removed");
  await assert.rejects(
    h.supervisor.apply(r.childId, { grantId }),
    SubagentError,
  );
});

test("subagent.diff truncates large patches; subagent.discard drops the worktree", async (t) => {
  const big = "x".repeat(300_000);
  const h = await harness(t, ({ turn }) =>
    turn === 0
      ? call("write", { path: "big.txt", content: `${big}\n` })
      : say("wrote big.txt"),
  );
  const { results } = await h.spawn({
    tasks: [{ prompt: "big", mode: "write" }],
  });
  const childId = results[0]!.childId;
  const diff = await h.supervisor.diff({ childId });
  assert.equal(diff.truncated, true);
  assert.ok(Buffer.byteLength(diff.patch) <= 262_144);
  assert.ok(diff.bytes > 300_000);
  assert.equal(h.live(), 1);
  await h.supervisor.discard({ childId });
  assert.equal(h.live(), 0);
  await assert.rejects(
    h.supervisor.diff({ childId }),
    (e: unknown) =>
      e instanceof SubagentError && e.code === "CHILD_NOT_APPLICABLE",
  );
});

test("oversize child diff is rejected and its worktree is removed", async (t) => {
  const h = await harness(t, ({ turn }) =>
    turn === 0
      ? call("write", { path: "big.txt", content: "é".repeat(524_289) })
      : say("done"),
  );
  const { results } = await h.spawn({
    tasks: [{ prompt: "big", mode: "write" }],
  });
  assert.equal(results[0]!.status, "failed");
  if (results[0]!.status === "failed") {
    assert.equal(results[0]!.reason, "ENGINE_ERROR");
    assert.equal(results[0]!.message, "child patch exceeds the byte limit");
  }
  assert.equal(h.live(), 0);
  assert.equal(existsSync(join(h.workspace, "big.txt")), false);
});

test("subagent.diff redacts bare password assignments on added and removed lines", async (t) => {
  const longPassword = `${"a".repeat(513)} private long tail`;
  const escapedPassword = String.raw`PASS="prefix\" private escaped tail"`;
  const h = await harness(t, ({ turn }) =>
    turn === 0
      ? call("write", {
          path: "settings.txt",
          content: `DB_PASS="new database value"\nPASS=newpass\nPASS="${longPassword}"\n${escapedPassword}\nPASS='unfinished private value\ncompass=north\n`,
        })
      : say("done"),
  );
  writeFileSync(
    join(h.workspace, "settings.txt"),
    "DB_PASS=olddbvalue\nPASS='old pass value'\n",
  );
  execFileSync("git", ["-C", h.workspace, "add", "-A"]);
  execFileSync("git", [
    "-C",
    h.workspace,
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@t",
    "commit",
    "-qm",
    "fixture",
  ]);
  const { results } = await h.spawn({
    tasks: [{ prompt: "settings", mode: "write" }],
  });
  const diff = await h.supervisor.diff({ childId: results[0]!.childId });
  for (const value of [
    "new database value",
    "newpass",
    "olddbvalue",
    "old pass value",
    "private long tail",
    "private escaped tail",
    "unfinished private value",
  ])
    assert.ok(!diff.patch.includes(value), value);
  assert.match(diff.patch, /\+DB_PASS=\[REDACTED\]/);
  assert.match(diff.patch, /-PASS=\[REDACTED\]/);
  assert.ok(diff.patch.includes("compass=north"));
});

for (const stale of ["dirty", "committed"])
  test(`stale ${stale} supervisor apply returns APPLY_CONFLICT and retries with a fresh grant`, async (t) => {
    const h = await harness(t, ({ turn }) =>
      turn === 0
        ? call("write", {
            path: "src/helper.ts",
            content: "export const result = 99;\n",
          })
        : say("done"),
    );
    const file = join(h.workspace, "src/helper.ts");
    const original = readFileSync(file, "utf8");
    const base = execFileSync("git", ["-C", h.workspace, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
    const { results } = await h.spawn({
      tasks: [{ prompt: "edit", mode: "write" }],
    });
    const childId = results[0]!.childId;
    const diff = await h.supervisor.diff({ childId });
    const grantId = h.approve(diff);
    writeFileSync(file, "parent changed\n");
    if (stale === "committed") {
      execFileSync("git", ["-C", h.workspace, "add", "-A"]);
      execFileSync("git", [
        "-C",
        h.workspace,
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@t",
        "commit",
        "-qm",
        "parent",
      ]);
    }
    await assert.rejects(h.supervisor.apply(childId, { grantId }), {
      code: "APPLY_CONFLICT",
    });
    assert.equal(readFileSync(file, "utf8"), "parent changed\n");
    assert.equal(
      h.actions().filter((a) => a.capabilityId === "worktree.apply").length,
      0,
    );
    h.supervisor.confirmApplyGrant(grantId, {
      actionId: diff.actionId,
      argumentsDigest: (await h.worktrees.diff(diff.worktreeId))
        .argumentsDigest,
    });
    if (stale === "committed")
      execFileSync("git", [
        "-C",
        h.workspace,
        "checkout",
        base,
        "--",
        "src/helper.ts",
      ]);
    else writeFileSync(file, original);
    if (stale === "committed")
      execFileSync("git", [
        "-C",
        h.workspace,
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@t",
        "commit",
        "-qm",
        "restore",
      ]);
    const fresh = h.approve(diff);
    assert.equal(
      (await h.supervisor.apply(childId, { grantId: fresh })).applied,
      true,
    );
    assert.equal(readFileSync(file, "utf8"), "export const result = 99;\n");
  });

test("write child cannot change a parent-workspace file before apply: no shell, fs confined to the worktree", async (t) => {
  const target = (workspace: string) => join(workspace, "src", "main.ts");
  let parentFile = "";
  const h = await harness(t, ({ task, turn }) => {
    if (turn > 0) return say("done");
    if (task.includes("shell"))
      return call("bash", {
        command: `node -e "require('fs').writeFileSync(process.argv[1], 'pwned')" "${parentFile}"`,
      });
    if (task.includes("absolute"))
      return call("write", { path: parentFile, content: "pwned" });
    return call("edit", {
      path: "../../../../workspace/src/main.ts",
      edits: [{ oldText: "helper()", newText: "pwned()" }],
    });
  });
  parentFile = target(h.workspace);
  const before = readFileSync(parentFile, "utf8");
  const { results } = await h.spawn({
    tasks: [
      { prompt: "shell", mode: "write" },
      { prompt: "absolute", mode: "write" },
      { prompt: "relative", mode: "write" },
    ],
  });
  assert.deepEqual(
    results.map((r) => (r.status === "failed" ? r.reason : r.status)),
    ["CAPABILITY_DENIED", "PATH_OUTSIDE_WORKSPACE", "PATH_OUTSIDE_WORKSPACE"],
  );
  assert.equal(readFileSync(parentFile, "utf8"), before);
  assert.equal(h.live(), 0, "failed write children leave no worktree");
  await assert.rejects(
    h.spawn({
      tasks: [{ prompt: "x", mode: "write", capabilities: ["shell.run"] }],
    }),
    (e: unknown) =>
      e instanceof SubagentError && e.code === "CAPABILITY_DENIED",
  );
});

test("two write children claiming one path: the second gets FILE_CLAIM_CONFLICT; claims release at end", async (t) => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let firstWrote!: () => void;
  const wrote = new Promise<void>((r) => (firstWrote = r));
  const h = await harness(t, async ({ task, turn, signal }) => {
    if (task.includes("first")) {
      if (turn === 0)
        return call("write", { path: "src/shared.ts", content: "first\n" });
      firstWrote();
      await until(signal, gate);
      return say("first done");
    }
    await wrote;
    return turn === 0
      ? call("write", { path: "SRC/Shared.ts", content: "second\n" })
      : say("second done");
  });
  const { results } = await (async () => {
    const out = h.spawn({
      tasks: [
        { prompt: "first", mode: "write" },
        { prompt: "second", mode: "write" },
      ],
    });
    // Let the second child hit the claim while the first still holds it.
    while (!h.events().some((e) => e.kind === "child.failed"))
      await new Promise((r) => setTimeout(r, 10));
    release();
    return out;
  })();
  assert.equal(results[0]!.status, "completed");
  assert.equal(results[1]!.status, "failed");
  if (results[1]!.status === "failed")
    assert.equal(results[1]!.reason, "FILE_CLAIM_CONFLICT");
  const claims = h.store
    .list("w-demo")
    .records.filter(({ kind }) => kind === "fileClaim")
    .map(({ record }) => record as Record<string, unknown>);
  assert.equal(claims.filter((c) => c.releasedAt === null).length, 1);
  assert.equal(
    claims.filter((c) => c.releasedAt !== null).length,
    1,
    "claim released at child end",
  );
  // Released: a new writer can claim the same path.
  h.supervisor.claim("later-child", "src/shared.ts");
});

test("a crashed owner's claim does not block the next writer; start releases stale claims", async (t) => {
  const claim = (
    store: ReturnType<typeof Store.open>,
    workspaceId: string,
    owner: string,
  ) =>
    store.append(
      {
        kind: "fileClaim",
        record: {
          schemaVersion: 1,
          recordId: `claim-${owner}`,
          createdAt: new Date().toISOString(),
          scopeId: "w-demo",
          sourceIds: ["rec-run"],
          workspaceId,
          path: "src/shared.ts",
          ownerChildId: owner,
          revision: "A",
          releasedAt: null,
        },
      },
      {
        sessionId: "s1",
        configRevision: "cfg-0",
        profileRevision: "profile1",
        policyRevision: "policy1",
        resolveReference: () => true,
      },
    );
  const h = await harness(
    t,
    ({ turn }) =>
      turn === 0
        ? call("write", { path: "src/shared.ts", content: "next\n" })
        : say("wrote it"),
    {
      beforeStart: ({ store, workspaceId }) =>
        claim(store, workspaceId, "crashed-before-start"),
    },
  );
  const heads = () =>
    h.store
      .list("w-demo")
      .records.filter(({ kind }) => kind === "fileClaim")
      .map(({ record }) => record as Record<string, unknown>);
  assert.ok(
    heads().some(
      (c) => c.ownerChildId === "crashed-before-start" && c.releasedAt !== null,
    ),
    "start releases a claim left by a crashed run",
  );
  // A claim whose owner died after start (no release record) is not live either.
  claim(h.store, h.workspaceId, "dead-after-start");
  const { results } = await h.spawn({
    tasks: [{ prompt: "write shared", mode: "write" }],
  });
  assert.equal(results[0]!.status, "completed", JSON.stringify(results[0]));
});

test("worktrees never outlive their child: crash, empty result and start-up sweep", async (t) => {
  let orphan = "";
  const h = await harness(
    t,
    ({ turn }) => (turn === 0 ? say("nothing") : say("x")),
    {
      tools: {
        "code.index": () => {
          throw new Error("host fault while building child tools");
        },
      },
      beforeStart: async ({ worktrees, workspaceId }) => {
        orphan = (
          await worktrees.create({ workspaceId, childId: "dead-child" })
        ).worktreeId;
      },
    },
  );
  assert.ok(
    h.supervisor.swept.removed.includes(orphan),
    "start sweeps orphans",
  );
  assert.equal(h.live(), 0);
  // Completed with no changes: nothing to review, the worktree goes.
  const { results } = await h.spawn({
    tasks: [{ prompt: "noop", mode: "write", capabilities: ["fs.write"] }],
  });
  assert.equal(results[0]!.status, "completed");
  assert.equal(h.live(), 0, "an empty write child keeps no worktree");
  await assert.rejects(
    h.supervisor.diff({ childId: results[0]!.childId }),
    SubagentError,
  );
  // Host fault after the worktree exists: the fault propagates, the worktree does not survive.
  await assert.rejects(
    h.spawn({ tasks: [{ prompt: "crash", mode: "write" }] }),
    /host fault while building child tools/u,
  );
  assert.equal(h.live(), 0, "a crashed write child's worktree is discarded");
});
