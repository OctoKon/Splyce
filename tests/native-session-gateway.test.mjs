import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import {
  encodeFrame,
  readFrames,
  runHost,
} from "../packages/splyce-pi/src/engine-host.mjs";

const request = (id, method, params = {}) => ({ id, method, params });
const command = {
  protocolVersion: 2,
  correlationId: "req",
  sessionId: "session",
  scopeId: "scope",
  expectedConfigRevision: "cfg",
  expectedProfileRevision: "profile",
  expectedPolicyRevision: "policy",
  op: "session.prompt",
  payload: { text: "hello" },
};
const event = { sessionId: "session", scopeId: "scope", kind: "turn.started" };
function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function fixture(overrides = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  const frames = [];
  let notify = () => {};
  const host = {
    assertCurrent() {},
    onSessionEvents(fn) {
      notify = fn;
      return () => {};
    },
    async preparePrompt() {
      return { accepted: true, runId: "run", turnId: "turn" };
    },
    async subscribeSession(sessionId, afterSeq) {
      return { sessionId, scopeId: "scope", afterSeq };
    },
    async unsubscribeSession() {},
    async drainSessionEvents() {
      return { frames: [event], morePending: false };
    },
    async cancelSession() {
      return { canceled: true };
    },
    async shutdown() {},
    ...overrides,
  };
  const running = runHost(input, output, () => host).finally(() =>
    output.end(),
  );
  const reading = (async () => {
    for await (const frame of readFrames(output)) frames.push(frame);
  })();
  const send = (id, method, params) =>
    input.write(encodeFrame(request(id, method, params)));
  const waitFor = async (predicate) => {
    for (let i = 0; i < 100; i++) {
      if (predicate()) return;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error("frame timeout");
  };
  const stop = async () => {
    send("stop", "shutdown", {});
    await running;
    await reading;
  };
  return {
    frames,
    send,
    waitFor,
    stop,
    notify: (id) => notify(id),
    running,
    reading,
  };
}

test("prompt ack precedes background completion and cancel waits for cleanup", async () => {
  const background = deferred();
  const cleanup = deferred();
  let canceled = false;
  const f = fixture({
    async preparePrompt() {
      void background.promise;
      return { accepted: true, runId: "run", turnId: "turn" };
    },
    async cancelSession() {
      await cleanup.promise;
      canceled = true;
      return { canceled: true };
    },
  });
  f.send("native-bootstrap", "native.bootstrap", { appDataDir: "ignored" });
  f.send("prompt", "send", command);
  await f.waitFor(() => f.frames.some((x) => x.id === "prompt"));
  assert.deepEqual(f.frames.find((x) => x.id === "prompt").value, {
    accepted: true,
    runId: "run",
    turnId: "turn",
  });
  f.send("cancel", "cancel", { sessionId: "session", reason: null });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(
    f.frames.some((x) => x.id === "cancel"),
    false,
  );
  cleanup.resolve();
  background.resolve();
  await f.waitFor(() => f.frames.some((x) => x.id === "cancel"));
  assert.equal(canceled, true);
  await f.stop();
});

test("approval responses reach native authority and preserve denial", async () => {
  const observed = [];
  const f = fixture({
    respondApproval(value) {
      observed.push(value);
      if (value.payload.approvalRequestId !== "pending")
        throw new Error("stale approval");
      return { accepted: true };
    },
  });
  const approval = {
    ...command,
    op: "approval.respond",
    payload: {
      approvalRequestId: "pending",
      runId: "run",
      actionId: "action",
      decision: "deny",
    },
  };
  f.send("native-bootstrap", "native.bootstrap", { appDataDir: "ignored" });
  f.send("decision", "send", approval);
  await f.waitFor(() => f.frames.some((frame) => frame.id === "decision"));
  assert.deepEqual(f.frames.find((frame) => frame.id === "decision").value, {
    accepted: true,
  });
  assert.deepEqual(observed, [approval]);
  f.send("stale", "send", {
    ...approval,
    payload: { ...approval.payload, approvalRequestId: "expired" },
  });
  await f.waitFor(() => f.frames.some((frame) => frame.id === "stale"));
  assert.equal(f.frames.find((frame) => frame.id === "stale").ok, false);
  await f.stop();
});

test("subscribe ack precedes replay and notifications drain only subscribed sessions", async () => {
  let drains = 0;
  const f = fixture({
    async drainSessionEvents() {
      drains++;
      return { frames: [event], morePending: false };
    },
  });
  f.send("native-bootstrap", "native.bootstrap", { appDataDir: "ignored" });
  await f.waitFor(() => f.frames.length === 1);
  f.notify("session");
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(drains, 0);
  f.send("sub", "subscribe", { sessionId: "session", afterSeq: 0 });
  await f.waitFor(() => f.frames.some((x) => x.event));
  assert.ok(
    f.frames.findIndex((x) => x.id === "sub") <
      f.frames.findIndex((x) => x.event),
  );
  assert.deepEqual(
    f.frames.find((x) => x.event),
    { event },
  );
  await f.stop();
});

test("invalid commands and stale revisions cannot reach prompt admission", async () => {
  let admissions = 0;
  const f = fixture({
    assertCurrent() {
      throw Object.assign(new Error(), { code: "STALE_REVISION" });
    },
    async preparePrompt() {
      admissions++;
    },
  });
  f.send("native-bootstrap", "native.bootstrap", { appDataDir: "ignored" });
  f.send("invalid", "send", { ...command, extra: true });
  f.send("stale", "send", command);
  await f.waitFor(() => f.frames.some((x) => x.id === "stale"));
  assert.equal(f.frames.find((x) => x.id === "invalid").ok, false);
  assert.equal(
    f.frames.find((x) => x.id === "stale").error.code,
    "STALE_REVISION",
  );
  assert.equal(admissions, 0);
  await f.stop();
});

test("shutdown waits for factory cleanup before acknowledging", async () => {
  const cleanup = deferred();
  const f = fixture({ shutdown: () => cleanup.promise });
  f.send("native-bootstrap", "native.bootstrap", { appDataDir: "ignored" });
  await f.waitFor(() => f.frames.length === 1);
  f.send("stop", "shutdown", {});
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(
    f.frames.some((x) => x.id === "stop"),
    false,
  );
  cleanup.resolve();
  await f.running;
  await f.reading;
  assert.equal(f.frames.find((x) => x.id === "stop").value.state, "stopped");
});

test("event drain failures terminate the framed host", async () => {
  const f = fixture({
    async drainSessionEvents() {
      throw new Error("private error");
    },
  });
  const rejected = assert.rejects(f.running, /private error/);
  f.send("native-bootstrap", "native.bootstrap", { appDataDir: "ignored" });
  f.send("sub", "subscribe", { sessionId: "session", afterSeq: 0 });
  await rejected;
  await f.reading;
  assert.equal(JSON.stringify(f.frames).includes("private error"), false);
});

test("output write failure shuts down and runs host cleanup", async () => {
  const input = new PassThrough();
  let cleaned = false;
  const output = new Writable({
    write(_chunk, _encoding, callback) {
      callback(new Error("output unavailable"));
    },
  });
  const running = runHost(input, output, () => ({
    async shutdown() {
      cleaned = true;
    },
  }));
  const rejected = assert.rejects(running);
  input.write(
    encodeFrame(
      request("native-bootstrap", "native.bootstrap", {
        appDataDir: "ignored",
      }),
    ),
  );
  await rejected;
  assert.equal(cleaned, true);
});
