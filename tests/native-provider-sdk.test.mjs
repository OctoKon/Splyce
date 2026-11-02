import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import test from "node:test";
import { runNativeOpenAIChat } from "../vendor/pi/packages/ai/dist/api/native-openai-chat.js";
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
const secret = `fixture-${crypto.randomUUID()}+/"`;
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
    context: {
      messages: [{ role: "user", content: "hello", timestamp: 0 }],
      tools: [],
    },
    options: {
      model: { maxTokens: 1024, compat: { maxTokensField: "max_tokens" } },
    },
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
    assert.equal(
      req.headers.authorization === `Bearer ${secret}`,
      true,
      "native credential attached",
    );
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
        res.write(sse(options.text ?? "hello", !options.noTerminal));
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
    if (frame.native.method === "credential.scope.close") {
      assert.equal(
        store.list("w-demo").records.filter((r) => r.kind === "outcome").length,
        0,
      );
      await options.close?.();
    }
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

function sse(text, terminal = true) {
  const chunk = (delta, finish_reason = null) =>
    `data: ${JSON.stringify({
      id: "chat-fixture",
      object: "chat.completion.chunk",
      created: 0,
      model: "fixture-model",
      choices: [{ index: 0, delta, finish_reason }],
    })}\n\n`;
  return (
    (Array.isArray(text) ? text : [text])
      .map((content, index) =>
        chunk({ ...(index === 0 ? { role: "assistant" } : {}), content }),
      )
      .join("") + (terminal ? chunk({}, "stop") + "data: [DONE]\n\n" : "")
  );
}
function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function run(f, events, onEvent = () => {}) {
  const snapshot = f.owner.semantic(f.scope);
  assert.ok(Object.isFrozen(snapshot.context.messages));
  return runNativeOpenAIChat({
    port: f.owner.port,
    scope: f.scope,
    model: {
      api: snapshot.apiFamily,
      id: snapshot.model,
      name: "Fixture model",
      provider: "openai",
      baseUrl: f.url.slice(0, -"/chat/completions".length),
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 8192,
      maxTokens: 1024,
      ...snapshot.options.model,
    },
    context: snapshot.context,
    onEvent: async (event) => {
      // This private owner bridge receives the actual SDK event before publication.
      f.owner.observe(f.scope, event);
      assert.equal(
        f.store.list("w-demo").records.filter((r) => r.kind === "outcome")
          .length,
        0,
      );
      assert.equal(f.resolver.redact(secret).includes(secret), false);
      events.push(structuredClone(event));
      await onEvent(event);
    },
  });
}
const outcomes = (f) =>
  f.store.list("w-demo").records.filter((r) => r.kind === "outcome");

test("actual SDK terminal and reader cancel precede native credential close and durable success", async (t) => {
  const closing = deferred(),
    release = deferred(),
    disconnected = deferred(),
    cancelEntered = deferred(),
    cancelRelease = deferred();
  let cancelCompleted = false;
  const physicalFetch = globalThis.fetch;
  globalThis.fetch = async (...args) => {
    const response = await physicalFetch(...args);
    const body = response.body;
    const observedBody = new Proxy(body, {
      get(target, property) {
        if (property === "getReader")
          return (...args) => {
            const reader = target.getReader(...args);
            return new Proxy(reader, {
              get(active, key) {
                if (key === "cancel")
                  return async (...args) => {
                    cancelEntered.resolve();
                    await cancelRelease.promise;
                    const result = await active.cancel(...args);
                    cancelCompleted = true;
                    return result;
                  };
                const value = Reflect.get(active, key, active);
                return typeof value === "function" ? value.bind(active) : value;
              },
            });
          };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    return new Proxy(response, {
      get(target, property) {
        if (property === "body") return observedBody;
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  };
  t.after(() => {
    globalThis.fetch = physicalFetch;
    cancelRelease.resolve();
    release.resolve();
  });
  const f = await fixture(t, {
    finish: (res) => {
      res.once("close", disconnected.resolve);
    },
    close: async () => {
      assert.equal(
        cancelCompleted,
        true,
        "physical reader cancellation must settle before credential close",
      );
      closing.resolve();
      await release.promise;
    },
  });
  const events = [];
  const operation = run(f, events);
  await cancelEntered.promise;
  assert.equal(cancelCompleted, false);
  assert.equal(f.frames.includes("credential.scope.close"), false);
  assert.equal(outcomes(f).length, 0);
  cancelRelease.resolve();
  await closing.promise;
  assert.equal(events.filter((e) => e.type === "done").length, 1);
  assert.equal(outcomes(f).length, 0);
  release.resolve();
  const result = await operation;
  await disconnected.promise;
  assert.equal(result.stopReason, "stop");
  assert.deepEqual(
    result.content.map((p) => p.text),
    ["hello"],
  );
  assert.equal(f.received, 1);
  assert.deepEqual(JSON.parse(f.bodies[0]).messages, [
    { role: "user", content: "hello" },
  ]);
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
  assert.equal(outcomes(f)[0].record.effectState, "observed-success");
  assert.equal(f.resolver.redact(secret).includes(secret), true);
});

test("actual SDK uses the original native semantic snapshot after caller mutation", async (t) => {
  const f = await fixture(t);
  f.semantic.context.messages[0].content = "changed by caller";
  f.semantic.context.messages[0].timestamp = 999;
  f.semantic.options.model.maxTokens = 7;
  f.semantic.options.model.compat.maxTokensField = "max_completion_tokens";
  f.semantic.model = "changed-model";
  const snapshot = f.owner.semantic(f.scope);
  assert.deepEqual(snapshot.context.messages, [
    { role: "user", content: "hello", timestamp: 0 },
  ]);
  assert.deepEqual(snapshot.options, {
    model: { maxTokens: 1024, compat: { maxTokensField: "max_tokens" } },
  });
  assert.equal(snapshot.model, "fixture-model");
  const events = [];
  const result = await run(f, events);
  const wire = JSON.parse(f.bodies[0]);
  assert.deepEqual(wire.messages, [{ role: "user", content: "hello" }]);
  assert.equal(wire.model, "fixture-model");
  assert.equal(wire.max_tokens, 1024);
  assert.equal(wire.max_completion_tokens, undefined);
  assert.equal(wire.stream, true);
  assert.equal(result.content[0].text, "hello");
  assert.equal(outcomes(f)[0].record.effectState, "observed-success");
});

test("actual SDK stream abort without provider terminal cannot record success", async (t) => {
  const f = await fixture(t, { noTerminal: true, finish: () => {} });
  const events = [];
  await assert.rejects(
    run(f, events, (event) => {
      if (event.type === "text_delta") f.controller.abort();
    }),
    { message: "Native OpenAI request failed" },
  );
  assert.equal(f.received, 1);
  assert.equal(
    events.some((e) => e.type === "done"),
    false,
  );
  assert.ok(outcomes(f).length > 0);
  assert.equal(
    outcomes(f).some((r) => r.record.effectState === "observed-success"),
    false,
  );
  assert.equal(f.frames.at(-1), "credential.scope.close");
});

const encodings = {
  raw: { encode: (s) => s, decode: (s) => s },
  base64: {
    encode: (s) => Buffer.from(s).toString("base64"),
    decode: (s) => Buffer.from(s, "base64").toString(),
  },
  base64url: {
    encode: (s) => Buffer.from(s).toString("base64url"),
    decode: (s) => Buffer.from(s, "base64url").toString(),
  },
  url: { encode: encodeURIComponent, decode: decodeURIComponent },
  json: {
    encode: (s) => JSON.stringify(s).slice(1, -1),
    decode: (s) => JSON.parse(`"${s}"`),
  },
};
for (const [name, encoding] of Object.entries(encodings)) {
  test(`genuine resolver and actual SDK keep ${name} credential fixture unrecoverable`, async (t) => {
    const encoded = encoding.encode(secret);
    const sentinel = "harmless sentinel";
    const midpoint = Math.floor(encoded.length / 2);
    const f = await fixture(t, {
      text: [
        sentinel + " ",
        encoded.slice(0, midpoint),
        encoded.slice(midpoint),
        " end sentinel",
      ],
    });
    const events = [];
    let rawProbe, variantProbe;
    const result = await run(f, events, () => {
      rawProbe = f.resolver.redact(secret) !== secret;
      variantProbe = f.resolver.redact(encoded) !== encoded;
    });
    assert.equal(
      rawProbe,
      true,
      "genuine resolver must redact the raw fixture while leased",
    );
    if (name !== "raw")
      assert.equal(
        variantProbe,
        true,
        "genuine resolver must redact the encoded fixture while leased",
      );
    const outputs = events.flatMap((value) => {
      const strings = [];
      const visit = (item) => {
        if (typeof item === "string") strings.push(item);
        else if (item && typeof item === "object")
          Object.values(item).forEach(visit);
      };
      visit(value);
      return strings;
    });
    const recovered = outputs.some((output) => {
      try {
        return encoding.decode(output).includes(secret);
      } catch {
        return false;
      }
    });
    assert.equal(
      recovered,
      false,
      "encoded fixture recovered from observer output",
    );
    const observedText = events
      .filter((event) => event.type === "text_delta")
      .map((event) => event.delta)
      .join("");
    const finalText = result.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("");
    for (const text of [observedText, finalText]) {
      assert.equal(
        text.startsWith(sentinel),
        true,
        "harmless prefix must survive",
      );
      assert.equal(
        text.endsWith("end sentinel"),
        true,
        "harmless suffix must survive",
      );
      assert.equal(
        text.includes(encoded),
        false,
        "encoded fixture recovered from ordered text",
      );
      let reconstructed = text;
      try {
        reconstructed = encoding.decode(
          text.slice(sentinel.length + 1, -" end sentinel".length),
        );
      } catch {}
      assert.equal(
        reconstructed.includes(secret),
        false,
        "encoded fixture recovered after ordered decoding",
      );
    }
    const resultRecovered = result.content.some((part) => {
      try {
        return (
          typeof part.text === "string" &&
          encoding.decode(part.text).includes(secret)
        );
      } catch {
        return false;
      }
    });
    assert.equal(
      resultRecovered,
      false,
      "encoded fixture recovered from result",
    );
    assert.equal(outcomes(f)[0].record.effectState, "observed-success");
  });
}
