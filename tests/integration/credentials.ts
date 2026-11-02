// TD-16 / C4 credentials — request-time admitted resolution, redaction and
// helper lifecycle against real child processes. Each test names the port
// invariant (provider-auth.ts) it guards.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";
import test from "node:test";
import {
  NativeCredentialResolver,
  type CredentialBinding,
  type HelperOutcome,
} from "../../packages/splyce-pi/dist/credential-resolver.js";
import {
  CredentialError,
  type CredentialRequest,
} from "../../packages/splyce-pi/dist/provider-auth.js";

const helperScript = fileURLToPath(
  new URL("../fixtures/credential-helper.mjs", import.meta.url),
);
const tmpRoot = mkdtempSync(join(tmpdir(), "td16-credentials-"));
test.after(() => rmSync(tmpRoot, { recursive: true, force: true }));
let n = 0;
const stateFile = () => join(tmpRoot, `state${String((n += 1))}`);
const spawnedPids = (file: string) =>
  existsSync(file)
    ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(Number)
    : [];
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const ENV_SECRET = "td16-env-secret-value";
const STORE_SECRET = "td16-store-secret-value";

const binding = (
  source: CredentialBinding["source"],
  over: Partial<CredentialBinding> = {},
): CredentialBinding => ({
  providerConnectionId: "conn-a",
  connectionRevision: "r1",
  endpointRef: "endpoint-a",
  egressPolicyRef: "egress-a",
  source,
  ...over,
});
const request = (over: Partial<CredentialRequest> = {}): CredentialRequest => ({
  providerConnectionId: "conn-a",
  connectionRevision: "r1",
  endpointRef: "endpoint-a",
  egressPolicyRef: "egress-a",
  actionId: "action-1",
  ...over,
});
const rejectsWith = (p: Promise<unknown>, code: string) =>
  assert.rejects(p, (e: unknown) => {
    assert.ok(e instanceof CredentialError);
    assert.equal(e.code, code);
    return true;
  });

const helperResolver = (
  mode: string,
  file: string,
  admit = true,
  outcomes: HelperOutcome[] = [],
  timeoutMs = 10_000,
) =>
  new NativeCredentialResolver({
    env: {},
    helpers: {
      "helper-ref": {
        file: process.execPath,
        args: [helperScript, mode, file],
        timeoutMs,
        maxOutputBytes: 4096,
      },
    },
    ...(admit
      ? {
          admitHelper: () =>
            Promise.resolve({
              intentId: "intent-1",
              outcome: (o: HelperOutcome) => {
                outcomes.push(o);
              },
            }),
        }
      : {}),
  });

test("I1: registering a helper reference spawns nothing and asks no decision", () => {
  const file = stateFile();
  let asked = 0;
  const resolver = new NativeCredentialResolver({
    env: {},
    helpers: {
      "helper-ref": {
        file: process.execPath,
        args: [helperScript, "ok", file],
      },
    },
    admitHelper: () => {
      asked += 1;
      return Promise.resolve(null);
    },
  });
  resolver.register(binding({ kind: "helper", commandRef: "helper-ref" }));
  assert.deepEqual(spawnedPids(file), []);
  assert.equal(asked, 0);
});

test("I2: resolve only for the bound endpoint/egress policy and current revision", async () => {
  const resolver = new NativeCredentialResolver({
    env: { TD16_KEY: ENV_SECRET },
  });
  resolver.register(binding({ kind: "env", name: "TD16_KEY" }));
  await rejectsWith(
    resolver.resolve(request({ endpointRef: "endpoint-b" })),
    "CREDENTIAL_DENIED_ENDPOINT",
  );
  await rejectsWith(
    resolver.resolve(request({ egressPolicyRef: "egress-b" })),
    "CREDENTIAL_DENIED_ENDPOINT",
  );
  await rejectsWith(
    resolver.resolve(request({ connectionRevision: "r0" })),
    "CREDENTIAL_STALE_REVISION",
  );
  // A re-registered (refreshed) connection makes the old revision stale.
  resolver.register(
    binding({ kind: "env", name: "TD16_KEY" }, { connectionRevision: "r2" }),
  );
  await rejectsWith(resolver.resolve(request()), "CREDENTIAL_STALE_REVISION");
  const lease = await resolver.resolve(request({ connectionRevision: "r2" }));
  assert.equal(await lease.use((s) => s), ENV_SECRET);
});

test("I3: secret is only visible inside use; lease, errors and JSON never carry it", async () => {
  let storeTarget = "";
  const resolver = new NativeCredentialResolver({
    env: {},
    readCredentialStore: (target) => {
      storeTarget = target;
      return Promise.resolve(STORE_SECRET);
    },
  });
  resolver.register(binding({ kind: "credentialStore", target: "splyce/a" }));
  const lease = await resolver.resolve(request());
  assert.equal(storeTarget, "splyce/a");
  for (const text of [
    JSON.stringify(lease),
    String(lease),
    inspect(lease, { showHidden: true, depth: 10 }),
    inspect(resolver, { showHidden: true, depth: 10 }),
    JSON.stringify(resolver),
  ])
    assert.ok(!text.includes(STORE_SECRET), text);
  assert.equal(await lease.use((s) => s.length), STORE_SECRET.length);
  const err = await resolver
    .resolve(request({ endpointRef: "endpoint-b" }))
    .catch((e: unknown) => e);
  assert.ok(err instanceof CredentialError);
  assert.ok(!inspect(err).includes(STORE_SECRET));
});

test("I3 redaction: every active secret is replaced; revoked ones are dropped from memory", async () => {
  const resolver = new NativeCredentialResolver({
    env: { TD16_KEY: ENV_SECRET },
    readCredentialStore: () => Promise.resolve(STORE_SECRET),
  });
  resolver.register(binding({ kind: "env", name: "TD16_KEY" }));
  resolver.register(
    binding(
      { kind: "credentialStore", target: "t" },
      { providerConnectionId: "conn-b" },
    ),
  );
  const a = await resolver.resolve(request());
  const b = await resolver.resolve(request({ providerConnectionId: "conn-b" }));
  const line = `Authorization: Bearer ${ENV_SECRET} x-api-key=${STORE_SECRET} again ${ENV_SECRET}`;
  const redacted = resolver.redact(line);
  assert.ok(!redacted.includes(ENV_SECRET) && !redacted.includes(STORE_SECRET));
  assert.equal(
    redacted,
    "Authorization: Bearer [REDACTED] x-api-key=[REDACTED] again [REDACTED]",
  );
  a.revoke();
  b.revoke();
  await rejectsWith(
    a.use((s) => s),
    "CREDENTIAL_REVOKED",
  );
  assert.equal(resolver.redact(line), line);
});

test("I4: missing auth throws and never selects another source, connection or credential", async () => {
  let storeReads = 0;
  const resolver = new NativeCredentialResolver({
    env: { OTHER_KEY: ENV_SECRET },
    readCredentialStore: () => {
      storeReads += 1;
      return Promise.resolve(undefined);
    },
  });
  resolver.register(binding({ kind: "env", name: "TD16_MISSING" }));
  resolver.register(
    binding(
      { kind: "env", name: "OTHER_KEY" },
      { providerConnectionId: "conn-b" },
    ),
  );
  resolver.register(
    binding(
      { kind: "credentialStore", target: "absent" },
      { providerConnectionId: "conn-c" },
    ),
  );
  await rejectsWith(resolver.resolve(request()), "CREDENTIAL_UNAVAILABLE");
  assert.equal(storeReads, 0);
  await rejectsWith(
    resolver.resolve(request({ providerConnectionId: "conn-c" })),
    "CREDENTIAL_UNAVAILABLE",
  );
  await rejectsWith(
    resolver.resolve(request({ providerConnectionId: "conn-unknown" })),
    "CREDENTIAL_UNAVAILABLE",
  );
  assert.equal(resolver.redact(ENV_SECRET), ENV_SECRET); // nothing was leased
});

test("I4: a failing helper is unavailable, never falls back, and its output is not reused", async () => {
  const file = stateFile();
  const outcomes: HelperOutcome[] = [];
  const resolver = helperResolver("fail", file, true, outcomes);
  resolver.register(binding({ kind: "helper", commandRef: "helper-ref" }));
  await rejectsWith(resolver.resolve(request()), "CREDENTIAL_UNAVAILABLE");
  assert.deepEqual(outcomes, [{ status: "failed", exitCode: 3 }]);
});

test("I5: helper without an admitHelper decision is never spawned", async () => {
  const file = stateFile();
  const resolver = helperResolver("ok", file, false);
  resolver.register(binding({ kind: "helper", commandRef: "helper-ref" }));
  await rejectsWith(
    resolver.resolve(request()),
    "CREDENTIAL_HELPER_NOT_ADMITTED",
  );
  assert.deepEqual(spawnedPids(file), []);
});

test("I5: denied or failing pre-spawn decision spawns nothing", async () => {
  const file = stateFile();
  for (const admitHelper of [
    () => Promise.resolve(null),
    () => Promise.reject(new Error("intent store unavailable")),
  ]) {
    const resolver = new NativeCredentialResolver({
      env: {},
      helpers: {
        "helper-ref": {
          file: process.execPath,
          args: [helperScript, "ok", file],
        },
      },
      admitHelper,
    });
    resolver.register(binding({ kind: "helper", commandRef: "helper-ref" }));
    await rejectsWith(
      resolver.resolve(request()),
      "CREDENTIAL_HELPER_NOT_ADMITTED",
    );
  }
  assert.deepEqual(spawnedPids(file), []);
});

test("I5: admitted helper runs once per resolve, outcome observed, output never cached", async () => {
  const file = stateFile();
  const outcomes: HelperOutcome[] = [];
  const seen: { request: CredentialRequest; commandRef: string }[] = [];
  const resolver = new NativeCredentialResolver({
    env: {},
    helpers: {
      "helper-ref": {
        file: process.execPath,
        args: [helperScript, "ok", file],
      },
    },
    admitHelper: (req, commandRef) => {
      seen.push({ request: req, commandRef });
      assert.equal(spawnedPids(file).length, seen.length - 1); // decided before spawn
      return Promise.resolve({
        intentId: `intent-${String(seen.length)}`,
        outcome: (o) => {
          outcomes.push(o);
        },
      });
    },
  });
  resolver.register(binding({ kind: "helper", commandRef: "helper-ref" }));
  for (let i = 0; i < 2; i += 1) {
    const lease = await resolver.resolve(request());
    assert.equal(await lease.use((s) => s), "td16-helper-secret");
  }
  const pids = spawnedPids(file);
  assert.equal(pids.length, 2);
  assert.ok(pids.every((pid) => !alive(pid)));
  assert.equal(seen[0]?.commandRef, "helper-ref");
  assert.deepEqual(outcomes, [
    { status: "succeeded", exitCode: 0 },
    { status: "succeeded", exitCode: 0 },
  ]);
  assert.ok(!JSON.stringify(outcomes).includes("td16-helper-secret"));
});

test("I5: helper output and time are bounded and the process is cleaned up", async () => {
  for (const [mode, status, timeoutMs] of [
    ["flood", "outputLimit", 10_000],
    ["hang", "timedOut", 500],
  ] as const) {
    const file = stateFile();
    const outcomes: HelperOutcome[] = [];
    const resolver = helperResolver(mode, file, true, outcomes, timeoutMs);
    resolver.register(binding({ kind: "helper", commandRef: "helper-ref" }));
    await rejectsWith(resolver.resolve(request()), "CREDENTIAL_UNAVAILABLE");
    assert.equal(outcomes[0]?.status, status);
    const [pid] = spawnedPids(file);
    assert.ok(pid !== undefined && !alive(pid));
  }
});

test("I6: abort before resolve rejects REVOKED without touching the source", async () => {
  let reads = 0;
  const resolver = new NativeCredentialResolver({
    env: {},
    readCredentialStore: () => {
      reads += 1;
      return Promise.resolve(STORE_SECRET);
    },
  });
  resolver.register(binding({ kind: "credentialStore", target: "t" }));
  await rejectsWith(
    resolver.resolve(request({ signal: AbortSignal.abort() })),
    "CREDENTIAL_REVOKED",
  );
  assert.equal(reads, 0);
});

test("I6: a late store result after abort is discarded, and abort revokes issued leases", async () => {
  let release: (v: string) => void = () => {};
  const resolver = new NativeCredentialResolver({
    env: { TD16_KEY: ENV_SECRET },
    readCredentialStore: () =>
      new Promise<string>((r) => {
        release = r;
      }),
  });
  resolver.register(binding({ kind: "credentialStore", target: "t" }));
  const controller = new AbortController();
  const pending = resolver.resolve(request({ signal: controller.signal }));
  controller.abort();
  release(STORE_SECRET);
  await rejectsWith(pending, "CREDENTIAL_REVOKED");
  assert.equal(resolver.redact(STORE_SECRET), STORE_SECRET); // never cached

  resolver.register(
    binding(
      { kind: "env", name: "TD16_KEY" },
      { providerConnectionId: "conn-b" },
    ),
  );
  const issuing = new AbortController();
  const lease = await resolver.resolve(
    request({ providerConnectionId: "conn-b", signal: issuing.signal }),
  );
  issuing.abort();
  await rejectsWith(
    lease.use((s) => s),
    "CREDENTIAL_REVOKED",
  );
  assert.equal(resolver.redact(ENV_SECRET), ENV_SECRET);
});

test("I6: abort during a running helper kills it, rejects REVOKED and records aborted", async () => {
  const file = stateFile();
  const outcomes: HelperOutcome[] = [];
  const resolver = helperResolver("hang", file, true, outcomes);
  resolver.register(binding({ kind: "helper", commandRef: "helper-ref" }));
  const controller = new AbortController();
  const pending = resolver.resolve(request({ signal: controller.signal }));
  while (spawnedPids(file).length === 0)
    await new Promise((r) => setTimeout(r, 20));
  controller.abort();
  await rejectsWith(pending, "CREDENTIAL_REVOKED");
  assert.deepEqual(outcomes, [{ status: "aborted", exitCode: null }]);
  const [pid] = spawnedPids(file);
  assert.ok(pid !== undefined && !alive(pid));
});

test("register rejects malformed references at the trust boundary", () => {
  const resolver = new NativeCredentialResolver({ env: {} });
  assert.throws(() => resolver.register(binding({ kind: "env", name: "" })));
  assert.throws(() =>
    resolver.register(
      binding({
        kind: "shell",
        cmd: "x",
      } as unknown as CredentialBinding["source"]),
    ),
  );
  assert.throws(() =>
    resolver.register(binding({ kind: "env", name: "K" }, { endpointRef: "" })),
  );
});

const deferred = <T>() => {
  let resolve: (v: T) => void = () => {};
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
};
const flush = () => new Promise((r) => setImmediate(r));

test("R1: a binding replaced while resolve awaits the source fails closed STALE and leases nothing", async () => {
  const read = deferred<string>();
  const resolver = new NativeCredentialResolver({
    env: {},
    readCredentialStore: () => read.promise,
  });
  resolver.register(binding({ kind: "credentialStore", target: "t" }));
  const pending = resolver.resolve(request());
  resolver.register(
    binding(
      { kind: "credentialStore", target: "t" },
      { connectionRevision: "r2" },
    ),
  );
  read.resolve(STORE_SECRET);
  await rejectsWith(pending, "CREDENTIAL_STALE_REVISION");
  assert.equal(resolver.redact(STORE_SECRET), STORE_SECRET); // never leased
});

test("R1: a binding replaced during the helper decision spawns nothing and fails STALE", async () => {
  const file = stateFile();
  const outcomes: HelperOutcome[] = [];
  const decision = deferred<void>();
  const resolver = new NativeCredentialResolver({
    env: {},
    helpers: {
      "helper-ref": {
        file: process.execPath,
        args: [helperScript, "ok", file],
      },
    },
    admitHelper: async () => {
      await decision.promise;
      return { intentId: "i", outcome: (o) => void outcomes.push(o) };
    },
  });
  resolver.register(binding({ kind: "helper", commandRef: "helper-ref" }));
  const pending = resolver.resolve(request());
  resolver.register(
    binding(
      { kind: "helper", commandRef: "helper-ref" },
      { connectionRevision: "r2" },
    ),
  );
  decision.resolve();
  await rejectsWith(pending, "CREDENTIAL_STALE_REVISION");
  assert.deepEqual(spawnedPids(file), []);
  assert.deepEqual(outcomes, [{ status: "aborted", exitCode: null }]);
});

test("R1: a lease is unusable once its binding is replaced, before or during use", async () => {
  const resolver = new NativeCredentialResolver({
    env: { TD16_KEY: ENV_SECRET },
  });
  resolver.register(binding({ kind: "env", name: "TD16_KEY" }));
  const before = await resolver.resolve(request());
  const during = await resolver.resolve(request());
  const gate = deferred<void>();
  const inFlight = during.use(async (s) => {
    await gate.promise;
    return s;
  });
  resolver.register(
    binding({ kind: "env", name: "TD16_KEY" }, { connectionRevision: "r2" }),
  );
  await rejectsWith(
    before.use((s) => s),
    "CREDENTIAL_STALE_REVISION",
  );
  gate.resolve();
  await rejectsWith(inFlight, "CREDENTIAL_STALE_REVISION");
  await rejectsWith(
    during.use((s) => s),
    "CREDENTIAL_REVOKED",
  );
});

test("R2: abort or revoke during use rejects REVOKED once, before the use ends, and drops late output", async () => {
  const resolver = new NativeCredentialResolver({
    env: { TD16_KEY: ENV_SECRET },
  });
  resolver.register(binding({ kind: "env", name: "TD16_KEY" }));
  for (const stop of ["abort", "revoke"] as const) {
    const controller = new AbortController();
    const lease = await resolver.resolve(
      request({ signal: controller.signal }),
    );
    const gate = deferred<void>();
    let settled = 0;
    const inFlight = lease
      .use(async (s) => {
        await gate.promise;
        return `late ${s}`;
      })
      .finally(() => {
        settled += 1;
      });
    if (stop === "abort") controller.abort();
    else lease.revoke();
    await rejectsWith(inFlight, "CREDENTIAL_REVOKED"); // gate still closed
    gate.resolve();
    await gate.promise;
    await flush();
    assert.equal(settled, 1);
  }
});

test("R3: a pending use keeps its secret redactable after revoke/rotation until it finishes", async () => {
  const env: Record<string, string> = { TD16_KEY: ENV_SECRET };
  const resolver = new NativeCredentialResolver({ env });
  resolver.register(binding({ kind: "env", name: "TD16_KEY" }));
  const a = await resolver.resolve(request());
  const b = await resolver.resolve(request());
  const gate = deferred<void>();
  const inFlight = a.use(async (s) => {
    await gate.promise;
    throw new Error(`late failure ${s}`);
  });
  b.revoke(); // releasing another lease of the same value
  a.revoke(); // and the pending use's own lease
  env.TD16_KEY = STORE_SECRET; // rotation to a newer lease
  resolver.register(
    binding({ kind: "env", name: "TD16_KEY" }, { connectionRevision: "r2" }),
  );
  const rotated = await resolver.resolve(request({ connectionRevision: "r2" }));
  rotated.revoke();
  await rejectsWith(inFlight, "CREDENTIAL_REVOKED");
  assert.equal(resolver.redact(`x ${ENV_SECRET}`), "x [REDACTED]");
  gate.resolve();
  await gate.promise;
  await flush();
  assert.equal(resolver.redact(ENV_SECRET), ENV_SECRET); // dropped once finished
});

test("R3: errors raised during a use are redacted, including their causes", async () => {
  const resolver = new NativeCredentialResolver({
    env: { TD16_KEY: ENV_SECRET },
  });
  resolver.register(binding({ kind: "env", name: "TD16_KEY" }));
  const lease = await resolver.resolve(request());
  const err = await lease
    .use((s) => {
      throw new Error(`upstream rejected ${s}`, {
        cause: new Error(`key ${s}`),
      });
    })
    .catch((e: unknown) => e);
  assert.ok(err instanceof Error);
  const text = inspect(err, { depth: 5 });
  assert.ok(!text.includes(ENV_SECRET), text);
  assert.equal(err.message, "upstream rejected [REDACTED]");
});

const deepChain = (s: string) => {
  let e = new Error(`level 0 ${s}`);
  for (let i = 1; i <= 12; i += 1)
    e = new Error(`level ${String(i)}`, { cause: e });
  return e;
};
const useErrors: Record<string, (s: string) => unknown> = {
  "AggregateError with the secret in .errors": (s) =>
    new AggregateError([new Error(s)], "many failed"),
  "a non-Error object cause": (s) => new Error("bad", { cause: { token: s } }),
  "an SDK-style headers property": (s) =>
    Object.assign(new Error("401"), {
      headers: { authorization: `Bearer ${s}` },
    }),
  "a 13-deep cause chain": deepChain,
  "a throwing toString": (s) => ({
    toString() {
      throw new Error(s);
    },
  }),
  "a throwing message getter": (s) =>
    Object.defineProperty(new Error("safe"), "message", {
      get() {
        throw new Error(s);
      },
    }),
  "a Proxy that throws on every access": (s) =>
    new Proxy(
      {},
      new Proxy(
        {},
        {
          get: () => () => {
            throw new Error(s);
          },
        },
      ),
    ),
};
for (const [name, make] of Object.entries(useErrors))
  test(`R3: a use error with ${name} becomes a fresh CredentialError that never carries the secret`, async () => {
    const resolver = new NativeCredentialResolver({
      env: { TD16_KEY: ENV_SECRET },
    });
    resolver.register(binding({ kind: "env", name: "TD16_KEY" }));
    const lease = await resolver.resolve(request());
    const err = await lease
      .use((s) => {
        throw make(s);
      })
      .catch((e: unknown) => e);
    lease.revoke(); // the redactor no longer knows the secret
    for (const text of [
      inspect(err, { depth: 20, showHidden: true }),
      JSON.stringify(err),
      JSON.stringify(
        Object.getOwnPropertyNames(err).map((k) => [
          k,
          String((err as Record<string, unknown>)[k]),
        ]),
      ),
    ])
      assert.ok(!text.includes(ENV_SECRET), text);
    assert.ok(err instanceof CredentialError);
    assert.equal(err.code, "CREDENTIAL_UNAVAILABLE");
    assert.equal(err.cause, undefined);
  });
