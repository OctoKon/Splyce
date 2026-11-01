import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import test from "node:test";
import { NativeProviderRequests } from "../packages/splyce-pi/dist/native-provider.js";
import { NativeCredentialResolver } from "../packages/splyce-pi/dist/credential-resolver.js";
import {
  NativePolicy,
  actionArgumentsDigest,
} from "../packages/splyce-pi/dist/policy.js";
import { NativeControl } from "../packages/splyce-pi/src/native-control.mjs";
import { Store } from "../packages/splyce-pi/dist/store.js";
const records = JSON.parse(
  await readFile(
    new URL("./fixtures/contracts/records.json", import.meta.url),
    "utf8",
  ),
);
const secret = "synthetic-provider-fixture-value";
const target = `splyce-credential:v1:${"a".repeat(64)}`;
async function fixture(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), "splyce-provider-"));
  const path = join(dir, "store.db");
  const store = Store.open(path);
  const caller = {
    sessionId: "s1",
    configRevision: "cfg1",
    profileRevision: "profile1",
    policyRevision: "policy1",
    resolveReference: () => true,
  };
  const args = { model: "fixture-model", stream: true, messages: [] };
  const semantic = {
    schema: "splyce-provider-request-v1",
    apiFamily: "openai-completions",
    endpointRef: "endpoint",
    model: "fixture-model",
    context: { messages: [], tools: [] },
    options: {},
  };
  const controller = new AbortController();
  let connection = {
    ...records.providerConnection,
    providerConnectionId: "connection",
    apiFamily: "openai-completions",
    revision: "revision1",
    endpointRef: "endpoint",
  };
  let received = 0;
  const history = [];
  const bodies = [];
  const server = createServer((req, res) => {
    received++;
    const independent = Store.open(path);
    history.push(
      independent
        .list("w-demo")
        .records.map(({ kind, record }) => [
          kind,
          record.state ?? record.effectState,
        ]),
    );
    independent.close();
    assert.equal(req.headers.authorization, `Bearer ${secret}`);
    assert.equal(req.headers["x-api-key"], undefined);
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      bodies.push(Buffer.concat(chunks).toString("utf8"));
      options.received?.(req, res);
      if (options.withholdHeaders) return;
      if (options.redirect) {
        res.writeHead(302, { location: "/elsewhere" });
        res.end();
      } else {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("data: fixture\n\n");
        if (options.finish) options.finish(res);
        else res.end();
      }
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}/chat/completions`;
  const observeIdentity = () => {
    const stat = statSync(dir, { bigint: true });
    assert.ok(stat.isDirectory());
    return { volumeSerial: String(stat.dev), fileId: String(stat.ino) };
  };
  const workspace = store.admitWorkspace(
    { canonicalPath: dir, ...observeIdentity() },
    caller,
  );
  const origin = new URL(url).origin;
  const grant = store.mintGrant(
    {
      workspaceId: workspace.workspaceId,
      sessionId: caller.sessionId,
      capability: "net.provider",
      scope: "session",
      origin: options.grantOrigin ?? origin,
    },
    caller,
  );
  store.append(
    {
      kind: "run",
      record: {
        ...records.run,
        workspaceId: workspace.workspaceId,
        grantIds: [grant.grantId],
      },
    },
    caller,
  );
  const active = { ...caller, grantIds: [grant.grantId], planMode: false };
  const identity = {
    observe(workspaceId) {
      assert.equal(workspaceId, workspace.workspaceId);
      return observeIdentity();
    },
  };
  const policy = new NativePolicy(store, caller, () => active, identity);
  const permit = {
    toolCallId: "call-1",
    toolName: "provider_request",
    actionId: "a1",
    runRecordId: "rec-run",
    grantId: grant.grantId,
    parentActionId: null,
    capabilityId: "cap1",
    capabilityVersion: "1",
    argumentsArtifactId: "args1",
    argumentsDigest: actionArgumentsDigest(semantic),
    targetScopeId: "w-demo",
    idempotencyKey: "request-1",
    ownership: store.acquireWorkspace(workspace.workspaceId, caller.sessionId),
    capability: "net.provider",
    origin,
  };
  policy.authorize(permit);
  const frames = [];
  let control;
  control = new NativeControl(async (frame) => {
    frames.push(frame.native.method);
    if (frame.native.method === "credential.read") await options.read?.();
    if (frame.native.method === "credential.scope.close" && options.failClose) {
      control.accept({
        native: {
          id: frame.native.id,
          ok: false,
          error: { code: "CREDENTIAL_UNAVAILABLE" },
        },
      });
      return;
    }
    control.accept({
      native: {
        id: frame.native.id,
        ok: true,
        value: frame.native.method === "credential.read" ? { secret } : {},
      },
    });
  });
  let owner;
  const resolver = new NativeCredentialResolver({
    env: {},
    readCredentialStore: (target, request) =>
      owner.readCredentialStore(target, request),
  });
  resolver.register({
    providerConnectionId: "connection",
    connectionRevision: "revision1",
    endpointRef: "endpoint",
    egressPolicyRef: "egress",
    source: { kind: "credentialStore", target },
  });
  owner = new NativeProviderRequests(policy, resolver, control);
  const binding = {
    permit,
    args: semantic,
    request: {
      providerConnectionId: "connection",
      connectionRevision: "revision1",
      endpointRef: "endpoint",
      egressPolicyRef: "egress",
      actionId: "a1",
      signal: controller.signal,
    },
    connection,
    currentConnection: () => connection,
    admittedUrl: url,
    modelId: "fixture-model",
    api: "openai-completions",
    maxRequestBytes: 4096,
    headersTimeoutMs: options.headersTimeoutMs ?? 1000,
    profileRevision: "profile1",
    credentialTarget: target,
    allowLocalLoopback: true,
  };
  t.after(async () => {
    control.shutdown();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    store.close();
    await rm(dir, { recursive: true, force: true });
  });
  const scope = options.deferScope ? undefined : owner.createScope(binding);
  return {
    owner,
    resolver,
    store,
    scope,
    binding,
    frames,
    history,
    bodies,
    controller,
    url,
    args,
    semantic,
    done: () =>
      owner.observe(scope, {
        type: "done",
        reason: "stop",
        message: {
          api: "openai-completions",
          model: "fixture-model",
          stopReason: "stop",
        },
      }),
    get received() {
      return received;
    },
    revoke() {
      store.revokeGrant(grant.grantId, caller);
      assert.deepEqual(active.grantIds, [grant.grantId]);
    },
    change() {
      connection = { ...connection, revision: "revision2" };
    },
    fetch: (request) =>
      request.fetch(url, {
        method: "POST",
        body: JSON.stringify(args),
        headers: { "x-api-key": "untrusted" },
      }),
  };
}

test("native lease spans durable intent, physical SSE consumption and scope cleanup", async (t) => {
  const f = await fixture(t);
  const result = await f.owner.port.withRequest(f.scope, async (request) => {
    assert.deepEqual(
      Object.keys(request).sort(),
      ["apiKey", "fetch", "maxRetries", "redact", "signal", "transport"].sort(),
    );
    const response = await f.fetch(request);
    assert.equal(
      f.store.list("w-demo").records.filter((r) => r.kind === "outcome").length,
      0,
    );
    assert.equal(f.frames.includes("credential.scope.close"), false);
    assert.equal(request.redact(secret), "[REDACTED]");
    const text = await response.text();
    f.done();
    return text;
  });
  assert.deepEqual(Object.keys(f.owner.port), ["withRequest"]);
  assert.equal(result, "data: fixture\n\n");
  assert.equal(f.received, 1);
  assert.deepEqual(JSON.parse(f.bodies[0]), f.args);
  assert.deepEqual(f.history[0].slice(-3), [
    ["action", "proposed"],
    ["action", "approved"],
    ["action", "running"],
  ]);
  assert.deepEqual(f.frames, [
    "credential.scope.open",
    "credential.read",
    "credential.scope.close",
  ]);
  assert.equal(
    f.store.list("w-demo").records.find((r) => r.kind === "outcome").record
      .effectState,
    "observed-success",
  );
  assert.equal(f.resolver.redact(secret), secret);
  await assert.rejects(f.owner.port.withRequest(f.scope, async () => {}));
  await assert.rejects(f.owner.port.withRequest({}, async () => {}));
});
for (const change of ["revoke", "change", "cancel"])
  test(`${change} during credential read sends no request`, async (t) => {
    let enter, release;
    const entered = new Promise((r) => (enter = r)),
      gate = new Promise((r) => (release = r));
    const f = await fixture(t, {
      read: async () => {
        enter();
        await gate;
      },
    });
    const operation = f.owner.port.withRequest(f.scope, async (request) =>
      (await f.fetch(request)).text(),
    );
    const rejected = assert.rejects(operation);
    await entered;
    if (change === "cancel") f.controller.abort();
    else f[change]();
    release();
    await rejected;
    assert.equal(f.received, 0);
    assert.ok(f.frames.includes("credential.scope.close"));
  });
for (const wrong of ["url", "model", "body", "size"])
  test(`reject ${wrong} before physical send`, async (t) => {
    const f = await fixture(t);
    await assert.rejects(
      f.owner.port.withRequest(f.scope, async (request) =>
        request.fetch(wrong === "url" ? `${f.url}/wrong` : f.url, {
          method: "POST",
          body:
            wrong === "body"
              ? new ReadableStream()
              : JSON.stringify({
                  ...f.args,
                  ...(wrong === "model" ? { model: "other" } : {}),
                  ...(wrong === "size" ? { extra: "x".repeat(5000) } : {}),
                }),
        }),
      ),
    );
    assert.equal(f.received, 0);
  });
test("a second fetch and redirect never produce a second physical send", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.owner.port.withRequest(f.scope, async (request) => {
      await (await f.fetch(request)).text();
      await f.fetch(request);
    }),
  );
  assert.equal(f.received, 1);
  const redirected = await fixture(t, { redirect: true });
  await assert.rejects(
    redirected.owner.port.withRequest(redirected.scope, async (request) =>
      (await redirected.fetch(request)).text(),
    ),
  );
  assert.equal(redirected.received, 1);
});
test("callback errors are redacted while lease remains live", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.owner.port.withRequest(f.scope, async (request) => {
      await (await f.fetch(request)).text();
      throw new Error(`failed ${request.apiKey}`);
    }),
    { message: "failed [REDACTED]" },
  );
  assert.equal(f.resolver.redact(secret), secret);
  assert.ok(f.frames.includes("credential.scope.close"));
});
test("wrong admitted references and URL policies fail before credential reads", async (t) => {
  const f = await fixture(t);
  for (const patch of [
    { admittedUrl: f.url + "?token=x" },
    { admittedUrl: "http://example.com/chat" },
    { allowLocalLoopback: false },
    { modelId: "" },
    { maxRequestBytes: 0 },
    { request: { ...f.binding.request, endpointRef: "wrong" } },
  ])
    assert.throws(() => f.owner.createScope({ ...f.binding, ...patch }));
  assert.equal(f.frames.length, 0);
});

test("revocation between lease delivery and physical fetch sends nothing", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.owner.port.withRequest(f.scope, async (request) => {
      f.revoke();
      return (await f.fetch(request)).text();
    }),
  );
  assert.equal(f.received, 0);
});
test("returning an unconsumed response denies and cancels its stream before outcome", async (t) => {
  let onClose;
  const closed = new Promise((resolve) => {
    onClose = resolve;
  });
  const f = await fixture(t, {
    finish: (res) => {
      res.once("close", onClose);
    },
  });
  await assert.rejects(
    f.owner.port.withRequest(f.scope, (request) => f.fetch(request)),
    { code: "PROVIDER_RESPONSE_NOT_CONSUMED" },
  );
  await closed;
  assert.equal(f.received, 1);
  assert.equal(f.frames.at(-1), "credential.scope.close");
  assert.equal(
    f.store.list("w-demo").records.find((r) => r.kind === "outcome").record
      .effectState,
    "uncertain",
  );
});
test("a late consumer after abort remains redactable until settled and scope closed", async (t) => {
  const f = await fixture(t);
  let enter, release;
  const entered = new Promise((r) => (enter = r)),
    gate = new Promise((r) => (release = r));
  const operation = f.owner.port.withRequest(f.scope, async (request) => {
    await (await f.fetch(request)).text();
    enter();
    await gate;
    assert.equal(request.redact(secret), "[REDACTED]");
    throw new Error(secret);
  });
  const rejected = assert.rejects(
    operation,
    (e) => !String(e).includes(secret),
  );
  await entered;
  f.controller.abort();
  assert.equal(f.resolver.redact(secret), "[REDACTED]");
  assert.equal(
    f.store.list("w-demo").records.filter((r) => r.kind === "outcome").length,
    0,
  );
  release();
  await rejected;
  assert.equal(f.resolver.redact(secret), secret);
  assert.equal(f.frames.at(-1), "credential.scope.close");
});

test("adapter body getter is read once and only admitted bytes reach the server", async (t) => {
  const f = await fixture(t);
  let reads = 0;
  await f.owner.port.withRequest(f.scope, async (request) => {
    const response = await request.fetch(f.url, {
      method: "POST",
      get body() {
        reads++;
        if (reads > 1) {
          f.revoke();
          return JSON.stringify({ ...f.args, messages: ["different"] });
        }
        return JSON.stringify(f.args);
      },
    });
    const text = await response.text();
    f.done();
    return text;
  });
  assert.equal(reads, 1);
  assert.equal(f.received, 1);
  assert.deepEqual(JSON.parse(f.bodies[0]), f.args);
});
test("adapter getter revocation is fenced before physical send", async (t) => {
  const f = await fixture(t);
  let reads = 0;
  await assert.rejects(
    f.owner.port.withRequest(f.scope, async (request) =>
      request.fetch(f.url, {
        method: "POST",
        get body() {
          reads++;
          f.revoke();
          return JSON.stringify(f.args);
        },
      }),
    ),
  );
  assert.equal(reads, 1);
  assert.equal(f.received, 0);
});
test("consumer failure aborts a pending send whose server withholds response headers", async (t) => {
  let received, closed;
  const arrival = new Promise((resolve) => (received = resolve));
  const disconnected = new Promise((resolve) => (closed = resolve));
  const f = await fixture(t, {
    withholdHeaders: true,
    received: (_req, res) => {
      res.once("close", closed);
      received();
    },
  });
  let timer;
  const operation = f.owner.port.withRequest(f.scope, async (request) => {
    void f.fetch(request).catch(() => {});
    await arrival;
    throw new Error("fixture consumer failure");
  });
  try {
    await Promise.race([
      assert.rejects(operation, { message: "fixture consumer failure" }),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("native request cleanup did not settle")),
          1500,
        );
      }),
    ]);
    await disconnected;
    assert.equal(f.controller.signal.aborted, false);
    assert.equal(f.received, 1);
    assert.equal(f.frames.at(-1), "credential.scope.close");
    assert.equal(
      f.store.list("w-demo").records.filter((r) => r.kind === "outcome").length,
      1,
    );
    assert.deepEqual(JSON.parse(f.bodies[0]), f.args);
  } finally {
    clearTimeout(timer);
    f.controller.abort();
    await operation.catch(() => {});
  }
});

test("semantic native snapshot is frozen and is distinct from SDK HTTP JSON", async (t) => {
  const f = await fixture(t);
  const owned = f.owner.semantic(f.scope);
  assert.notEqual(owned, f.semantic);
  assert.ok(Object.isFrozen(owned));
  assert.ok(Object.isFrozen(owned.context));
  assert.ok(Object.isFrozen(owned.context.messages));
  assert.throws(() =>
    owned.context.messages.push({ role: "user", content: "changed" }),
  );
  f.semantic.options.temperature = 99;
  assert.deepEqual(owned.options, {});
  await f.owner.port.withRequest(f.scope, async (request) => {
    const text = await (await f.fetch(request)).text();
    f.done();
    assert.equal(f.owner.semantic(f.scope), owned);
    return text;
  });
  assert.deepEqual(JSON.parse(f.bodies[0]), f.args);
  assert.notDeepEqual(JSON.parse(f.bodies[0]), owned);
  assert.throws(() => f.owner.semantic(f.scope));
});
test("partial SSE cancellation without an adapter terminal event is uncertain", async (t) => {
  const f = await fixture(t, { finish: () => {} });
  await assert.rejects(
    f.owner.port.withRequest(f.scope, async (request) => {
      const reader = (await f.fetch(request)).body.getReader();
      await reader.read();
      await reader.cancel();
      return "partial";
    }),
  );
  assert.equal(
    f.store.list("w-demo").records.find((r) => r.kind === "outcome").record
      .effectState,
    "uncertain",
  );
});
test("validated adapter done followed by reader cancellation can succeed without HTTP EOF", async (t) => {
  const f = await fixture(t, {
    finish: (res) => {
      res.write("data: [DONE]\n\n");
    },
  });
  const value = await f.owner.port.withRequest(f.scope, async (request) => {
    const reader = (await f.fetch(request)).body.getReader();
    let data = "";
    while (!data.includes("data: [DONE]"))
      data += new TextDecoder().decode((await reader.read()).value);
    f.done();
    await reader.cancel();
    return "complete";
  });
  assert.equal(value, "complete");
  assert.equal(
    f.store.list("w-demo").records.find((r) => r.kind === "outcome").record
      .effectState,
    "observed-success",
  );
});
test("wrong opaque scope cannot provide another operation's completion", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.owner.port.withRequest(f.scope, async (request) => {
      await (await f.fetch(request)).text();
      assert.throws(() =>
        f.owner.observe(
          {},
          {
            type: "done",
            reason: "stop",
            message: {
              api: "openai-completions",
              model: "fixture-model",
              stopReason: "stop",
            },
          },
        ),
      );
    }),
  );
  assert.equal(
    f.store.list("w-demo").records.find((r) => r.kind === "outcome").record
      .effectState,
    "uncertain",
  );
});
for (const failure of ["adapterError", "consumerError", "cleanupError"])
  test(`${failure} after terminal completion cannot record success`, async (t) => {
    const f = await fixture(t, { failClose: failure === "cleanupError" });
    await assert.rejects(
      f.owner.port.withRequest(f.scope, async (request) => {
        await (await f.fetch(request)).text();
        f.done();
        if (failure === "adapterError")
          f.owner.observe(f.scope, { type: "error", reason: "error" });
        if (failure === "consumerError")
          throw new Error("consumer failed after done");
      }),
    );
    assert.equal(
      f.store.list("w-demo").records.find((r) => r.kind === "outcome").record
        .effectState,
      "uncertain",
    );
  });
test("explicit header deadline aborts an awaited send without external cancellation", async (t) => {
  let closed;
  const disconnected = new Promise((resolve) => (closed = resolve));
  const f = await fixture(t, {
    headersTimeoutMs: 40,
    withholdHeaders: true,
    received: (_req, res) => res.once("close", closed),
  });
  await assert.rejects(
    f.owner.port.withRequest(f.scope, async (request) =>
      (await f.fetch(request)).text(),
    ),
  );
  await disconnected;
  assert.equal(f.controller.signal.aborted, false);
  assert.equal(f.received, 1);
  assert.equal(f.frames.at(-1), "credential.scope.close");
  assert.equal(
    f.store.list("w-demo").records.find((r) => r.kind === "outcome").record
      .effectState,
    "uncertain",
  );
});

test("a Store-minted grant for another origin cannot reach credentials or the server", async (t) => {
  const f = await fixture(t, {
    grantOrigin: "https://other.invalid:443",
    deferScope: true,
  });
  let failure;
  try {
    const scope = f.owner.createScope(f.binding);
    await f.owner.port.withRequest(scope, async (request) =>
      (await f.fetch(request)).text(),
    );
  } catch (error) {
    failure = error;
  }
  assert.equal(f.received, 0);
  assert.equal(f.frames.length, 0);
  assert.equal(failure?.code, "GRANT_MISMATCH");
});
