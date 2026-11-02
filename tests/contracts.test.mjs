import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  CONTRACT_VERSION,
  PROTOCOL_VERSION,
  TRANSPORT_LIMITS,
  PI_REVISION,
  FOUNDATION,
  ContractError,
  validateRecord,
  validateCommand,
  validateEvent,
  validateHandshake,
  validateCursor,
} from "@splyce/pi/contracts";

const fixture = (name) =>
  JSON.parse(
    readFileSync(
      new URL(`./fixtures/contracts/${name}.json`, import.meta.url),
      "utf8",
    ),
  );
const records = fixture("records");
const referenceIds = new Set(fixture("references"));
const context = {
  scopeId: "w-demo",
  sessionId: "s1",
  configRevision: "cfg1",
  profileRevision: "profile1",
  policyRevision: "policy1",
  lastDurableSeq: 12,
  maxInlineBytes: 4096,
  resolveReference: (id, scopeId) =>
    scopeId === "w-demo" && referenceIds.has(id),
};
const copy = (value) => structuredClone(value);
const rejects = (call) =>
  assert.throws(
    call,
    (error) =>
      error instanceof ContractError &&
      typeof error.code === "string" &&
      error.code.length > 0,
  );
const command = (op, payload) => ({
  protocolVersion: 1,
  correlationId: "request1",
  sessionId: "s1",
  scopeId: "w-demo",
  expectedConfigRevision: "cfg1",
  expectedProfileRevision: "profile1",
  expectedPolicyRevision: "policy1",
  op,
  payload,
});
const event = (fields = {}) => ({
  schemaVersion: 1,
  protocolVersion: 1,
  recordId: "rec-event",
  eventId: "event1",
  createdAt: "2026-10-26T00:00:00.000Z",
  sourceIds: ["e1"],
  scopeId: "w-demo",
  sessionId: "s1",
  seq: 12,
  durable: true,
  kind: "turn.started",
  payload: { runId: "r1", turnId: "turn1" },
  ...fields,
});

test("TD-01: public package exports the frozen versions and pinned Pi revision", () => {
  assert.equal(CONTRACT_VERSION, 1);
  assert.equal(PROTOCOL_VERSION, 1);
  assert.equal(PI_REVISION, "d5b3de22d0e24a3e9c38a9410d3329b099717283");
  assert.deepEqual(FOUNDATION, {
    entryMode: "sdk-host",
    disabledBuiltinExtensions: ["llama.cpp", "codemode", "tool-search", "mcp"],
  });
});

test("TD-01: transport defaults are exact and immutable", () => {
  assert.deepEqual(TRANSPORT_LIMITS, {
    maxInlineBytes: 65536,
    maxEncodedFrameBytes: 262144,
    pendingQueueMaxFrames: 1024,
    pendingQueueMaxBytes: 8388608,
    transientCoalesceWindowMs: 16,
    rendererMaxFrames: 256,
    rendererMaxBytes: 4194304,
  });
  assert.ok(Object.isFrozen(TRANSPORT_LIMITS));
  assert.throws(() => {
    TRANSPORT_LIMITS.maxEncodedFrameBytes = 1;
  }, TypeError);
  assert.equal(TRANSPORT_LIMITS.maxEncodedFrameBytes, 262144);
});

for (const { op, payload } of fixture("commands")) {
  test(`TD-01: command ${op} accepts fixed payload and rejects added authority`, () => {
    const input = command(op, payload);
    const before = copy(input);
    assert.deepEqual(validateCommand(input, context), before);
    assert.deepEqual(input, before);
    rejects(() =>
      validateCommand(
        command(op, { ...payload, grantExpansion: true }),
        context,
      ),
    );
    const optionalFields = {
      "session.start": ["piSessionId", "initialPrompt"],
      "session.prompt": ["contextArtifactIds"],
      "session.cancel": ["reason"],
    };
    for (const key of Object.keys(payload)) {
      if (optionalFields[op]?.includes(key)) continue;
      const invalid = copy(input);
      delete invalid.payload[key];
      rejects(() => validateCommand(invalid, context));
    }
  });
}

for (const [kind, original] of Object.entries(records)) {
  test(`TD-01: ${kind} preserves JSON data and rejects broken durable metadata`, () => {
    const input = JSON.parse(JSON.stringify(original));
    input.optionalNote = { label: "preserve me", nested: [1, true, null] };
    const before = copy(input);
    assert.deepEqual(validateRecord(kind, input, context), before);
    assert.deepEqual(input, before);
    assert.deepEqual(
      JSON.parse(JSON.stringify(validateRecord(kind, input, context))),
      before,
    );
    for (const field of Object.keys(original).filter(
      (key) => key !== "optionalNote",
    )) {
      const invalid = copy(original);
      delete invalid[field];
      rejects(() => validateRecord(kind, invalid, context));
    }
    for (const patch of [
      { schemaVersion: 2 },
      { scopeId: "other-workspace" },
      { sourceIds: ["missing-source"] },
      { createdAt: "2026-02-30T00:00:00.000Z" },
      { createdAt: "2026-10-26T01:00:00+01:00" },
    ]) {
      rejects(() => validateRecord(kind, { ...original, ...patch }, context));
    }
  });
}

test("TD-01: record states, references and numeric bounds fail closed", () => {
  rejects(() => validateRecord("unknown", records.run, context));
  for (const [kind, value] of Object.entries(records)) {
    if ("state" in value)
      rejects(() =>
        validateRecord(kind, { ...value, state: "unknown-state" }, context),
      );
  }
  for (const byteLength of [
    -1,
    0.5,
    Number.NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
  ])
    rejects(() =>
      validateRecord("artifact", { ...records.artifact, byteLength }, context),
    );
  for (const [kind, patch] of [
    ["run", { taskArtifactId: "missing" }],
    ["action", { argumentsArtifactId: "missing" }],
    ["outcome", { resultArtifactId: "missing" }],
    ["memoryObservation", { claimArtifactId: "missing" }],
    ["profileSnapshot", { limitsArtifactId: "missing" }],
    ["configurationTransition", { changedValuesArtifactId: "missing" }],
    ["action", { targetScopeId: "other-workspace" }],
    ["providerRole", { locality: "hosted", qualificationRef: null }],
    ["providerRole", { limits: { tokens: Infinity } }],
  ])
    rejects(() =>
      validateRecord(kind, { ...records[kind], ...patch }, context),
    );
  assert.deepEqual(validateRecord("run", records.run, context), records.run);
});

test("TD-01: optional record data cannot smuggle raw credentials or absolute paths", () => {
  for (const extra of [
    { apiKey: "fixture-secret" },
    { password: "fixture-secret" },
    { nested: { accessToken: "fixture-secret" } },
    { headers: { "x-api-key": "fixture-secret" } },
    { headers: { "Proxy-Authorization": "fixture-secret" } },
    { path: "C:\\private\\fixture.txt" },
    { path: '"C:\\private\\fixture.txt"' },
    { path: "path=C:\\private\\fixture.txt" },
    { path: "/private/fixture.txt" },
    { nested: { path: "\\\\server\\share\\fixture.txt" } },
  ])
    rejects(() =>
      validateRecord("run", { ...records.run, optionalData: extra }, context),
    );
});

test("TD-01: hydrated artifact references are checked again after authorization changes", () => {
  const hydrated = JSON.parse(JSON.stringify(records.memoryObservation));
  assert.deepEqual(
    validateRecord("memoryObservation", hydrated, context),
    hydrated,
  );
  const revoked = {
    ...context,
    resolveReference: (id, scopeId) =>
      id !== "e1" && context.resolveReference(id, scopeId),
  };
  rejects(() => validateRecord("memoryObservation", hydrated, revoked));
  assert.deepEqual(
    validateRecord("memoryObservation", hydrated, context),
    hydrated,
  );
});

test("TD-01: approval identity remains scoped and cannot expand renderer authority", () => {
  const approval = command("approval.respond", {
    approvalRequestId: "approval1",
    runId: "r1",
    actionId: "a1",
    decision: "approve",
  });
  assert.deepEqual(validateCommand(approval, context), approval);
  assert.deepEqual(
    validateCommand(
      { ...approval, payload: { ...approval.payload, decision: "deny" } },
      context,
    ).payload.decision,
    "deny",
  );
  for (const patch of [
    { decision: "allow" },
    { rememberDecision: true },
    { grantIds: ["grant1"] },
    { path: "src/main.ts" },
    { approvalRequestId: "missing" },
  ])
    rejects(() =>
      validateCommand(
        { ...approval, payload: { ...approval.payload, ...patch } },
        context,
      ),
    );
  for (const key of ["approvalRequestId", "runId", "actionId"]) {
    const invalid = copy(approval);
    delete invalid.payload[key];
    rejects(() => validateCommand(invalid, context));
  }
});

test("TD-01: commands reject unknown operation, stale identity and revision", () => {
  const restart = command("engine.restart", {});
  assert.deepEqual(validateCommand(restart, context), restart);
  for (const patch of [
    { protocolVersion: 2 },
    { op: "execute.arbitrary" },
    { scopeId: "other" },
    { sessionId: "other" },
    { expectedConfigRevision: "stale" },
    { expectedProfileRevision: "stale" },
    { expectedPolicyRevision: "stale" },
    { payload: { surprise: true } },
  ])
    rejects(() => validateCommand({ ...restart, ...patch }, context));
  const selection = command("workspace.select", { selectionRef: "selection1" });
  assert.deepEqual(validateCommand(selection, context), selection);
  rejects(() =>
    validateCommand(
      command("workspace.select", { path: "C:\\private" }),
      context,
    ),
  );
  rejects(() =>
    validateCommand(
      command("workspace.select", { selectionRef: "missing" }),
      context,
    ),
  );
});

test("TD-01: replay cursor rejects gaps and recovers from the known durable position", () => {
  for (const value of [0, 10, 12]) {
    assert.equal(validateCursor(value, context), value);
    const subscribe = command("session.subscribe", { afterSeq: value });
    assert.deepEqual(validateCommand(subscribe, context), subscribe);
  }
  for (const value of [
    -1,
    13,
    0.5,
    Infinity,
    NaN,
    Number.MAX_SAFE_INTEGER + 1,
    "12",
    null,
  ]) {
    rejects(() => validateCursor(value, context));
    rejects(() =>
      validateCommand(
        command("session.subscribe", { afterSeq: value }),
        context,
      ),
    );
  }
  assert.equal(validateCursor(12, context), 12);
});

for (const fields of fixture("events")) {
  test(`TD-01: event ${fields.kind} preserves correlation, payload and sequence`, () => {
    const input = event(fields);
    assert.deepEqual(validateEvent(input, context), input);
    assert.deepEqual(
      validateEvent(JSON.parse(JSON.stringify(input)), context),
      input,
    );
    for (const key of Object.keys(input.payload)) {
      const invalid = copy(input);
      invalid.payload[key] = null;
      rejects(() => validateEvent(invalid, context));
    }
    rejects(() =>
      validateEvent(
        { ...input, payload: { ...input.payload, surprise: true } },
        context,
      ),
    );
  });
}

test("TD-01: historical records remain readable after configuration/profile changes", () => {
  const advanced = {
    ...context,
    configRevision: "cfg2",
    profileRevision: "profile2",
  };
  for (const [kind, value] of Object.entries(records))
    assert.deepEqual(validateRecord(kind, value, advanced), value);
  assert.equal(
    validateRecord(
      "configurationTransition",
      records.configurationTransition,
      advanced,
    ).state,
    "applied",
  );
  rejects(() => validateCommand(command("engine.restart", {}), advanced));
});

test("TD-01: stream fragments preserve whitespace and code verbatim", () => {
  for (const kind of ["turn.stream_delta", "turn.thought_delta"])
    for (const delta of [
      "",
      " ",
      "\n",
      "/",
      "C:\\fixture\\example.ts",
      "\t  return x / y;\n",
    ])
      assert.equal(
        validateEvent(
          event({ kind, durable: false, payload: { runId: "r1", delta } }),
          context,
        ).payload.delta,
        delta,
      );
});

test("TD-01: event-specific scope/session and replay cursors reject mismatches", () => {
  for (const [kind, patch] of [
    ["approval.requested", { targetScope: "other-workspace" }],
    ["session.tree_updated", { sessionId: "other-session" }],
    ["stream.resync", { fromSeq: 13 }],
    ["run.reconnect_snapshot", { lastDurableSeq: 13 }],
  ]) {
    const fields = fixture("events").find((value) => value.kind === kind);
    rejects(() =>
      validateEvent(
        event({ ...fields, payload: { ...fields.payload, ...patch } }),
        context,
      ),
    );
  }
});

test("TD-01: events reject invalid identities, payload variants and unknown messages", () => {
  for (const patch of [
    { schemaVersion: 2 },
    { protocolVersion: 2 },
    { kind: "unknown.required" },
    { scopeId: "other" },
    { sessionId: "other" },
    { seq: 0 },
    { seq: -1 },
    { seq: NaN },
    { seq: Infinity },
    { seq: 0.5 },
    { seq: Number.MAX_SAFE_INTEGER + 1 },
    { sourceIds: ["missing"] },
    { payloadArtifactId: "e1" },
    { durable: false },
  ])
    rejects(() => validateEvent(event(patch), context));
  for (const key of [
    "recordId",
    "eventId",
    "sessionId",
    "scopeId",
    "seq",
    "kind",
    "payload",
  ]) {
    const input = event();
    delete input[key];
    rejects(() => validateEvent(input, context));
  }
  const referenced = event({ payloadArtifactId: "e1" });
  delete referenced.payload;
  assert.deepEqual(validateEvent(referenced, context), referenced);
  rejects(() =>
    validateEvent({ ...referenced, payloadArtifactId: "missing" }, context),
  );
  rejects(() =>
    validateEvent(event({ payload: { turnId: "turn1" } }), context),
  );
  for (const kind of ["turn.tool_outcome", "approval.requested"]) {
    const fields = fixture("events").find(
      (candidate) => candidate.kind === kind,
    );
    rejects(() => validateEvent(event({ ...fields, durable: false }), context));
  }
});

test("TD-01: bounded inline events use UTF-8 bytes and accept exact boundary", () => {
  const input = event({
    kind: "turn.stream_delta",
    durable: false,
    payload: { runId: "r1", delta: "😀".repeat(40) },
  });
  const byteLength = Buffer.byteLength(JSON.stringify(input.payload), "utf8");
  assert.ok(byteLength > JSON.stringify(input.payload).length);
  assert.deepEqual(
    validateEvent(input, { ...context, maxInlineBytes: byteLength }),
    input,
  );
  rejects(() =>
    validateEvent(input, { ...context, maxInlineBytes: byteLength - 1 }),
  );
});

test("TD-01: frozen handshake accepts unavailable but requires all readiness guards", () => {
  const input = fixture("handshake");
  assert.deepEqual(validateHandshake(input), input);
  const ready = {
    ...input,
    readiness: { state: "ready", policy: true, store: true, receipts: true },
  };
  assert.deepEqual(validateHandshake(ready), ready);
  for (const field of [
    "protocolVersion",
    "schemaVersion",
    "engineProtocolVersion",
    "bridgeProtocolVersion",
  ])
    rejects(() => validateHandshake({ ...input, [field]: 2 }));
  for (const field of ["policy", "store", "receipts"])
    rejects(() =>
      validateHandshake({
        ...ready,
        readiness: { ...ready.readiness, [field]: false },
      }),
    );
  for (const patch of [
    { piRevision: "unknown" },
    { entryMode: "rpc" },
    { disabledBuiltinExtensions: ["mcp"] },
    {
      disabledBuiltinExtensions: [...input.disabledBuiltinExtensions, "extra"],
    },
    { readiness: { state: "ready" } },
  ])
    rejects(() => validateHandshake({ ...input, ...patch }));
});
