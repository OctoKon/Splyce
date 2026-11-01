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

test("redaction rejects invalid input without sending", async () => {
  const p = peer();
  for (const text of [null, "\ud800"]) {
    await assert.rejects(p.control.redact(text), {
      code: "PERSIST_REDACTION_UNAVAILABLE",
    });
  }
  assert.equal(p.messages.length, 0);
});

test("oversized persistence entries fail locally without closing the channel", async () => {
  const p = peer();
  for (const text of ["é".repeat(524289), "\n".repeat(140000)])
    await assert.rejects(p.control.redact(text), {
      code: "PERSIST_ENTRY_TOO_LARGE",
      message: "Persistence entry too large",
    });
  assert.equal(p.messages.length, 0);
  p.bus.on("request", (frame) =>
    p.reply(frame, { text: "clean", redactedCount: 0 }),
  );
  assert.deepEqual(await p.control.redact("small"), {
    text: "clean",
    redactedCount: 0,
  });
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

test("credential status sends only its canonical target and returns only presence", async () => {
  for (const present of [true, false]) {
    const p = peer();
    p.bus.on("request", (frame) => p.reply(frame, { present }));
    assert.deepEqual(
      await p.control.credentialStatus({ target: binding().target }),
      { present },
    );
    assert.deepEqual(
      p.messages.map(({ native }) => [native.method, native.params]),
      [["credential.status", { target: binding().target }]],
    );
  }
});

test("credential status denies malformed targets and extra authority fields locally", async () => {
  const p = peer();
  for (const params of [
    null,
    [],
    {},
    { target: null },
    { target: "wrong" },
    { target: binding().target.toUpperCase() },
    { target: `other-credential:v1:${"a".repeat(64)}` },
    { target: binding().target, scopeId: "scope" },
  ]) {
    await assert.rejects(p.control.credentialStatus(params), {
      code: "CREDENTIAL_UNAVAILABLE",
      message: "Credential unavailable",
    });
  }
  assert.equal(p.messages.length, 0);
});

test("credential status rejects malformed and mismatched reply shapes", async () => {
  for (const value of [
    {},
    { secret: null },
    { text: "clean", redactedCount: 0 },
    { present: null },
    { present: 1 },
    { present: "true" },
    { present: true, target: binding().target },
  ]) {
    const p = peer();
    const request = p.control.credentialStatus({ target: binding().target });
    await tick();
    assert.throws(() => p.reply(p.messages[0], value), {
      code: "CREDENTIAL_UNAVAILABLE",
    });
    await assert.rejects(request, { code: "CREDENTIAL_UNAVAILABLE" });
  }
  const p = peer();
  const request = p.control.redact("input");
  await tick();
  assert.throws(() => p.reply(p.messages[0], { present: true }));
  await assert.rejects(request, { code: "PERSIST_REDACTION_UNAVAILABLE" });
});

test("credential status releases slots on abort timeout and shutdown and fences late results", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const p = peer();
  const params = { target: binding().target };
  const aborter = new AbortController();
  const first = p.control.credentialStatus(params, aborter.signal);
  await tick();
  aborter.abort();
  await assert.rejects(first, { code: "CREDENTIAL_UNAVAILABLE" });
  p.reply(p.messages[0], { present: true });
  const timed = p.control.credentialStatus(params);
  await tick();
  t.mock.timers.tick(10000);
  await assert.rejects(timed, { code: "CREDENTIAL_UNAVAILABLE" });
  p.reply(p.messages[1], { present: true });
  const calls = Array.from({ length: 8 }, () =>
    p.control.credentialStatus(params),
  );
  await tick();
  await assert.rejects(p.control.credentialStatus(params), {
    code: "CREDENTIAL_UNAVAILABLE",
  });
  assert.equal(p.messages.length, 10);
  p.control.shutdown();
  await Promise.all(
    calls.map((call) =>
      assert.rejects(call, { code: "CREDENTIAL_UNAVAILABLE" }),
    ),
  );
  for (const frame of p.messages.slice(2)) p.reply(frame, { present: true });
  await assert.rejects(p.control.credentialStatus(params), {
    code: "CREDENTIAL_UNAVAILABLE",
  });
});

test("credential status fences a reply followed by abort or shutdown before continuation", async () => {
  for (const shutdown of [false, true]) {
    const p = peer();
    const aborter = new AbortController();
    const request = p.control.credentialStatus(
      { target: binding().target },
      aborter.signal,
    );
    await tick();
    p.reply(p.messages[0], { present: true });
    if (shutdown) p.control.shutdown();
    else aborter.abort();
    await assert.rejects(request, { code: "CREDENTIAL_UNAVAILABLE" });
  }
});

test("credential status hides transport errors and remote denial without a missing fallback", async () => {
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
  await assert.rejects(
    p.control.credentialStatus({ target: binding().target }),
    {
      code: "CREDENTIAL_UNAVAILABLE",
      message: "Credential unavailable",
    },
  );
  const failed = new NativeControl(async () => {
    throw new Error("sensitive");
  });
  await assert.rejects(failed.credentialStatus({ target: binding().target }), {
    code: "CREDENTIAL_UNAVAILABLE",
    message: "Credential unavailable",
  });
});

test("shell cancel uses its own lifetime and requires a terminal cleanup acknowledgment", async () => {
  const p = peer(),
    controller = new AbortController();
  const methods = [];
  let cancelFrame, nextPoll;
  p.bus.on("request", (frame) => {
    const { method } = frame.native;
    methods.push(method);
    if (method === "shell.start") p.reply(frame, { state: "pending" });
    if (method === "shell.cancel") {
      cancelFrame = frame;
      p.reply(frame, { state: "pending" });
    }
    if (method === "shell.poll" && cancelFrame) nextPoll = frame;
    else if (method === "shell.poll") p.reply(frame, { state: "pending" });
    if (method === "credential.status") p.reply(frame, { present: false });
  });
  const running = p.control.shell(
    {
      command: "fixture",
      actionId: "a",
      sessionId: "s",
      workspaceId: "w",
      ownershipEpoch: 1,
      timeoutMs: 1000,
    },
    controller.signal,
    () => {},
  );
  await tick();
  await p.control.credentialStatus({ target: binding().target });
  controller.abort();
  while (!nextPoll) await new Promise((r) => setTimeout(r, 2));
  let settled = false;
  running.then(() => {
    settled = true;
  });
  await tick();
  assert.equal(settled, false);
  p.reply(nextPoll, {
    state: "done",
    status: "aborted",
    code: 1,
    bytes: 0,
    stdoutBytes: 0,
    offset: 0,
    data: "",
    last: true,
  });
  assert.equal((await running).status, "aborted");
  assert.equal(methods.filter((x) => x === "shell.cancel").length, 1);
});
test("lost shell acceptance and cleanup acknowledgment remain uncertain", async () => {
  const p = peer();
  let attempts = 0;
  p.bus.on("request", (frame) => {
    ++attempts;
    if (frame.native.method === "shell.start")
      throw new Error("lost acknowledgment");
    p.control.accept({
      native: {
        id: frame.native.id,
        ok: false,
        error: { code: "SHELL_CLEANUP_UNCERTAIN" },
      },
    });
  });
  await assert.rejects(
    p.control.shell(
      {
        command: "fixture",
        actionId: "a",
        sessionId: "s",
        workspaceId: "w",
        ownershipEpoch: 1,
        timeoutMs: 1000,
      },
      undefined,
      () => {},
    ),
    { code: "SHELL_CLEANUP_UNCERTAIN" },
  );
  assert.ok(attempts >= 3);
});

test("a verified terminal page preserves cleanup proof if the rest of the output is lost", async () => {
  const p = peer();
  let reads = 0;
  p.bus.on("request", (frame) => {
    if (frame.native.method !== "shell.poll")
      return p.reply(frame, { state: "pending" });
    if (++reads === 1)
      return p.reply(frame, {
        state: "done",
        status: "exit",
        code: 0,
        bytes: 2,
        stdoutBytes: 2,
        offset: 0,
        data: "61",
        last: false,
      });
    p.control.shutdown();
  });
  const result = await p.control.shell(
    {
      actionId: "a",
      sessionId: "s",
      workspaceId: "w",
      ownershipEpoch: 1,
      command: "fixture",
      timeoutMs: 1000,
    },
    undefined,
    () => {},
  );
  assert.equal(result.status, "resultUnavailable");
  assert.equal(result.stdout + result.stderr, "");
});
