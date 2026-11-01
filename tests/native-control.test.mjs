import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { NativeControl } from "../packages/splyce-pi/src/native-control.mjs";

const binding = (scopeId = "scope") => ({
  scopeId,
  target: `splyce-credential:v1:${"a".repeat(64)}`,
  actionId: "action",
  profileRevision: "p1",
  connectionRevision: "c1",
});
function peer() {
  const bus = new EventEmitter();
  const messages = [];
  const control = new NativeControl(async (frame) => {
    messages.push(frame);
    bus.emit("request", frame);
  });
  const reply = (frame, value = {}) =>
    control.accept({ native: { id: frame.native.id, ok: true, value } });
  return { bus, control, messages, reply };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));

test("redaction sends the exact request and returns the exact result", async () => {
  const p = peer();
  p.bus.on("request", (frame) =>
    p.reply(frame, { text: "clean", redactedCount: 1 }),
  );
  assert.deepEqual(await p.control.redact("input"), {
    text: "clean",
    redactedCount: 1,
  });
  assert.deepEqual(p.messages[0].native.method, "credential.redact");
  assert.deepEqual(p.messages[0].native.params, { text: "input" });
});

test("redaction rejects invalid input and encoded frames without sending", async () => {
  const p = peer();
  for (const text of [
    null,
    "\ud800",
    "é".repeat(524289),
    "\n".repeat(140000),
  ]) {
    await assert.rejects(p.control.redact(text), {
      code: "PERSIST_REDACTION_UNAVAILABLE",
    });
  }
  assert.equal(p.messages.length, 0);
});

test("redaction fails closed on malformed and oversized replies", async () => {
  for (const value of [
    {},
    { text: "clean", redactedCount: 0, extra: true },
    { text: 1, redactedCount: 0 },
    { text: "\ud800", redactedCount: 0 },
    { text: "clean", redactedCount: -1 },
    { text: "clean", redactedCount: 1.5 },
    { text: "clean", redactedCount: Number.MAX_SAFE_INTEGER + 1 },
    { text: "\n".repeat(140000), redactedCount: 0 },
  ]) {
    const p = peer();
    const request = p.control.redact("input");
    await tick();
    assert.throws(() => p.reply(p.messages[0], value));
    await assert.rejects(request, { code: "PERSIST_REDACTION_UNAVAILABLE" });
  }
});

test("redaction releases slots on abort, timeout and shutdown and ignores late delivery", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const p = peer();
  const aborter = new AbortController();
  const aborted = p.control.redact("first", aborter.signal);
  await tick();
  aborter.abort();
  await assert.rejects(aborted, { code: "PERSIST_REDACTION_UNAVAILABLE" });
  p.reply(p.messages[0], { text: "late", redactedCount: 0 });
  const timed = p.control.redact("second");
  await tick();
  t.mock.timers.tick(10000);
  await assert.rejects(timed, { code: "PERSIST_REDACTION_UNAVAILABLE" });
  p.reply(p.messages[1], { text: "late", redactedCount: 0 });
  const calls = Array.from({ length: 8 }, () => p.control.redact("next"));
  await tick();
  await assert.rejects(p.control.redact("overflow"), {
    code: "PERSIST_REDACTION_UNAVAILABLE",
  });
  p.control.shutdown();
  await Promise.all(
    calls.map((call) =>
      assert.rejects(call, { code: "PERSIST_REDACTION_UNAVAILABLE" }),
    ),
  );
  await assert.rejects(p.control.redact("closed"), {
    code: "PERSIST_REDACTION_UNAVAILABLE",
  });
});

test("redaction hides remote denial and transport failures", async () => {
  const p = peer();
  p.bus.on("request", (frame) =>
    p.control.accept({
      native: {
        id: frame.native.id,
        ok: false,
        error: { code: "PERSIST_REDACTION_UNAVAILABLE" },
      },
    }),
  );
  await assert.rejects(p.control.redact("input"), {
    message: "Persistence redaction unavailable",
    code: "PERSIST_REDACTION_UNAVAILABLE",
  });
  const failed = new NativeControl(async () => {
    throw new Error("sensitive");
  });
  await assert.rejects(failed.redact("input"), {
    message: "Persistence redaction unavailable",
    code: "PERSIST_REDACTION_UNAVAILABLE",
  });
});

test("redaction rejects a reply followed by shutdown before its continuation", async () => {
  const p = peer();
  const request = p.control.redact("input");
  await tick();
  p.reply(p.messages[0], { text: "clean", redactedCount: 0 });
  p.control.shutdown();
  await assert.rejects(request, { code: "PERSIST_REDACTION_UNAVAILABLE" });
});

test("redaction rejects an error belonging to the generation protocol", async () => {
  const p = peer();
  const request = p.control.redact("input");
  await tick();
  assert.throws(() =>
    p.control.accept({
      native: {
        id: p.messages[0].native.id,
        ok: false,
        error: { code: "CREDENTIAL_UNAVAILABLE" },
      },
    }),
  );
  await assert.rejects(request, { code: "PERSIST_REDACTION_UNAVAILABLE" });
});

test("private peer receives exact bindings and enforces one read and close", async () => {
  const p = peer();
  p.bus.on("request", (frame) =>
    p.reply(
      frame,
      frame.native.method === "credential.read" ? { secret: "fixture" } : {},
    ),
  );
  const handle = await p.control.open(binding());
  assert.equal(await handle.read(), "fixture");
  await assert.rejects(handle.read(), { code: "CREDENTIAL_UNAVAILABLE" });
  await handle.close();
  assert.deepEqual(
    p.messages.map(({ native }) => [native.method, native.params]),
    [
      ["credential.scope.open", binding()],
      ["credential.read", binding()],
      ["credential.scope.close", { scopeId: "scope" }],
    ],
  );
});

test("invalid bindings, abort, late reply, EOF and pending cap fail closed", async () => {
  const p = peer();
  await assert.rejects(p.control.open({ ...binding(), target: "wrong" }));
  await assert.rejects(
    p.control.open({ ...binding(), actionId: "bad/action" }),
  );
  assert.equal(p.messages.length, 0);
  const aborter = new AbortController();
  const opening = p.control.open(binding(), aborter.signal);
  await tick();
  const first = p.messages[0];
  aborter.abort();
  await assert.rejects(opening);
  p.reply(first);
  const calls = Array.from({ length: 7 }, (_, i) =>
    p.control.open(binding(`s${i}`)),
  );
  await tick();
  await assert.rejects(p.control.open(binding("overflow")));
  p.control.shutdown();
  await Promise.all(calls.map((call) => assert.rejects(call)));
});

test("malformed and unsolicited replies shut down pending operations", async () => {
  for (const alter of [
    (frame) => ({ ...frame, extra: true }),
    (frame) => ({ native: { ...frame.native, id: "unsolicited" } }),
    (frame) => ({ native: { ...frame.native, value: { extra: true } } }),
  ]) {
    const p = peer();
    const opening = p.control.open(binding());
    await tick();
    const frame = {
      native: { id: p.messages[0].native.id, ok: true, value: {} },
    };
    assert.throws(() => p.control.accept(alter(frame)), {
      code: "CREDENTIAL_UNAVAILABLE",
    });
    await assert.rejects(opening);
  }
});

test("write failure and remote denial do not expose remote data", async () => {
  const p = peer();
  p.bus.on("request", (frame) =>
    p.control.accept({
      native: {
        id: frame.native.id,
        ok: false,
        error: { code: "CREDENTIAL_UNAVAILABLE" },
      },
    }),
  );
  await assert.rejects(p.control.open(binding()), {
    message: "Credential unavailable",
  });
  const failed = new NativeControl(async () => {
    throw new Error("sensitive");
  });
  await assert.rejects(failed.open(binding()), {
    message: "Credential unavailable",
  });
});

test("closing eight pending reads cancels them and sends every close", async () => {
  const p = peer();
  p.bus.on("request", (frame) => {
    if (frame.native.method !== "credential.read") p.reply(frame);
  });
  const handles = await Promise.all(
    Array.from({ length: 8 }, (_, i) => p.control.open(binding(`s${i}`))),
  );
  const reads = handles.map((handle) => handle.read());
  await tick();
  const readFrames = p.messages.filter(
    ({ native }) => native.method === "credential.read",
  );
  const closes = handles.map((handle) => handle.close());
  await Promise.all(reads.map((read) => assert.rejects(read)));
  await Promise.all(closes);
  assert.equal(
    p.messages.filter(
      ({ native }) => native.method === "credential.scope.close",
    ).length,
    8,
  );
  for (const frame of readFrames) p.reply(frame, { secret: "late" });
});

test("close before a queued read continuation prevents returning its secret", async () => {
  const p = peer();
  p.bus.on("request", (frame) => {
    if (frame.native.method !== "credential.read") p.reply(frame);
  });
  const handle = await p.control.open(binding());
  const read = handle.read();
  await tick();
  p.reply(p.messages.at(-1), { secret: "private" });
  const close = handle.close();
  await assert.rejects(read);
  await close;
});

test("failed cleanup signals a bounded fatal error and invalidates the control", async () => {
  const bus = new EventEmitter();
  let fatal;
  const control = new NativeControl(
    async (frame) => bus.emit("request", frame),
    (error) => {
      fatal = error;
    },
  );
  bus.on("request", (frame) =>
    control.accept(
      frame.native.method === "credential.scope.close"
        ? {
            native: {
              id: frame.native.id,
              ok: false,
              error: { code: "CREDENTIAL_UNAVAILABLE" },
            },
          }
        : { native: { id: frame.native.id, ok: true, value: {} } },
    ),
  );
  const handle = await control.open(binding());
  await assert.rejects(handle.close(), { message: "Credential unavailable" });
  assert.equal(fatal?.message, "Credential unavailable");
  await assert.rejects(control.open(binding("next")));
  await assert.rejects(handle.close());
});

test("oversized or control-containing secret replies terminate the channel", async () => {
  for (const secret of ["a".repeat(2561), "invalid\nsecret"]) {
    const p = peer();
    p.bus.on("request", (frame) => {
      if (frame.native.method === "credential.scope.open") p.reply(frame);
    });
    const handle = await p.control.open(binding());
    const read = handle.read();
    await tick();
    assert.throws(() => p.reply(p.messages.at(-1), { secret }));
    await assert.rejects(read);
  }
});

test("pending calls expire and cleanup failure terminates the control", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let fatal;
  const control = new NativeControl(
    async () => {},
    (error) => {
      fatal = error;
    },
  );
  const opening = control.open(binding());
  await Promise.resolve();
  t.mock.timers.tick(10_000);
  await assert.rejects(opening);
  await Promise.resolve();
  t.mock.timers.tick(10_000);
  await Promise.resolve();
  assert.equal(fatal?.code, "CREDENTIAL_UNAVAILABLE");
});
