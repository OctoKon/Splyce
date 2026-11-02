import {
  validateModelsListRequest,
  validateModelsListResult,
} from "@splyce/pi/model-data";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  validatePageReadRequest,
  validatePageReadResult,
} from "@splyce/pi/page-data";
import {
  CONTRACT_VERSION,
  PROTOCOL_VERSION,
  PI_REVISION,
  FOUNDATION,
  TRANSPORT_LIMITS,
  BRIDGE_PROTOCOL_JSON,
  ContractError,
  validateRecord,
  validateCommand,
  validateEvent,
  validateHandshake,
  validateCursor,
  validateControlFrame,
  validatePermissionRead,
  validatePermissionSet,
  validatePermissionResult,
} from "@splyce/pi/contracts";

const fixture = (name) =>
  JSON.parse(
    readFileSync(
      new URL(`./fixtures/contracts/${name}.json`, import.meta.url),
      "utf8",
    ),
  );
const records = fixture("records");
for (const { op, request, result } of fixture("permission-modes")) {
  test(`permission contract: ${op} ${result.mode}`, () => {
    const validate =
      op === "permission.set" ? validatePermissionSet : validatePermissionRead;
    assert.deepEqual(validate(request, request.requestId), request);
    assert.deepEqual(validatePermissionResult(result, request), result);
    assert.throws(() => validate(request, "different-request"));
    for (const field of Object.keys(request)) {
      const missing = { ...request };
      delete missing[field];
      assert.throws(() => validate(missing, request.requestId));
      for (const value of [
        null,
        "",
        "bad/id",
        "bad\\id",
        "bad id",
        "bad\u0000id",
        "bad\u200bid",
        "λ".repeat(65),
        "\ud800",
        "x".repeat(129),
      ])
        assert.throws(() =>
          validate({ ...request, [field]: value }, request.requestId),
        );
    }
    for (const field of ["grantIds", "approvedBy", "path", "secret", "extra"]) {
      assert.throws(() =>
        validate({ ...request, [field]: "untrusted" }, request.requestId),
      );
      assert.throws(() =>
        validatePermissionResult({ ...result, [field]: "untrusted" }, request),
      );
    }
    for (const field of ["workspaceId", "sessionId"])
      assert.throws(() =>
        validatePermissionResult({ ...result, [field]: "other" }, request),
      );
    for (const mode of ["accept-edits", "plan", "unknown", null]) {
      assert.throws(() =>
        validatePermissionSet({ ...request, mode }, request.requestId),
      );
      assert.throws(() =>
        validatePermissionResult({ ...result, mode }, request),
      );
    }
    let read = false;
    const accessor = { ...request };
    Object.defineProperty(accessor, "mode", {
      enumerable: true,
      get() {
        read = true;
        return "bypass";
      },
    });
    assert.throws(() => validate(accessor, request.requestId));
    assert.equal(read, false);
  });
}
for (const { op, request, result } of fixture("page-reads")) {
  test(`page read contract: ${op}`, () => {
    assert.deepEqual(validatePageReadRequest(op, request), request);
    assert.deepEqual(validatePageReadResult(op, result), result);
    for (const field of ["path", "credentialRef", "secret"]) {
      assert.throws(
        () => validatePageReadRequest(op, { ...request, [field]: "private" }),
        { code: "PAGE_READ_INVALID" },
      );
      assert.throws(
        () => validatePageReadResult(op, { ...result, [field]: "private" }),
        { code: "PAGE_READ_INVALID" },
      );
    }
    if (op === "usage.read") {
      assert.throws(
        () => validatePageReadResult(op, { ...result, inputTokens: 0 }),
        { code: "PAGE_READ_INVALID" },
      );
      assert.throws(
        () => validatePageReadResult(op, { ...result, runCount: -1 }),
        { code: "PAGE_READ_INVALID" },
      );
    } else {
      const key = op === "sessions.list" ? "sessions" : "entries";
      const row = result[key][0];
      assert.throws(
        () => validatePageReadResult(op, { ...result, [key]: [row, row] }),
        { code: "PAGE_READ_INVALID" },
      );
      assert.throws(
        () =>
          validatePageReadResult(op, {
            ...result,
            [key]: [{ ...row, credentialRef: "private" }],
          }),
        { code: "PAGE_READ_INVALID" },
      );
      assert.throws(
        () =>
          validatePageReadResult(op, {
            ...result,
            [key]: [{ ...row, createdAt: "2026-02-29T00:00:00.000Z" }],
          }),
        { code: "PAGE_READ_INVALID" },
      );
    }
    if (op === "memory.search") {
      for (const query of ["", " ", "x\n", "Ã©".repeat(513)])
        assert.throws(
          () => validatePageReadRequest(op, { ...request, query }),
          { code: "PAGE_READ_INVALID" },
        );
    }
  });
}
test("model catalog contract rejects malformed and private data", () => {
  const { request, result } = fixture("models-list");
  assert.deepEqual(validateModelsListRequest(request), request);
  assert.deepEqual(validateModelsListResult(result), result);
  for (const value of [
    { ...request, profileId: "" },
    { ...request, extra: true },
  ])
    assert.throws(() => validateModelsListRequest(value), {
      code: "MODEL_CATALOG_INVALID",
    });
  const row = result.models[0];
  for (const models of [
    [row, row],
    [{ ...row, secret: "x" }],
    [{ ...row, modelId: "x\u200b" }],
    [{ ...row, modelId: "\ud800" }],
    [{ ...row, contextWindow: 0 }],
    [{ ...row, title: "x\n" }],
    Array(501).fill(row),
  ])
    assert.throws(() => validateModelsListResult({ ...result, models }), {
      code: "MODEL_CATALOG_INVALID",
    });
});
test("transport defaults are exact, immutable and shared with the native build spec", () => {
  assert.deepEqual(TRANSPORT_LIMITS, {
    maxInlineBytes: 65536,
    maxEncodedFrameBytes: 262144,
    pendingQueueMaxFrames: 1024,
    pendingQueueMaxBytes: 8388608,
    transientCoalesceWindowMs: 16,
    rendererMaxFrames: 256,
    rendererMaxBytes: 4194304,
  });
  assert.equal(Object.isFrozen(TRANSPORT_LIMITS), true);
  assert.throws(() => {
    TRANSPORT_LIMITS.maxEncodedFrameBytes = 1;
  }, TypeError);
  assert.equal(TRANSPORT_LIMITS.maxEncodedFrameBytes, 262144);
  assert.deepEqual(
    JSON.parse(BRIDGE_PROTOCOL_JSON).transportLimits,
    TRANSPORT_LIMITS,
  );
});
test("TD-01: native build spec comes from the shared operation definitions", () => {
  const spec = JSON.parse(BRIDGE_PROTOCOL_JSON);
  assert.equal(spec.protocolVersion, 2);
  assert.equal(spec.schemaVersion, 1);
  assert.equal(spec.piRevision, "d5b3de22d0e24a3e9c38a9410d3329b099717283");
  assert.deepEqual(
    Object.keys(spec.commands).sort(),
    fixture("commands")
      .map(({ op }) => op)
      .sort(),
  );
  assert.equal(spec.commands["approval.respond"].approvalRequestId, "ref");
  assert.equal(spec.commands["workspace.select"].selectionRef, "ref");
  assert.equal(spec.commands["session.subscribe"].afterSeq, "uint");
  assert.deepEqual(
    spec.eventKinds.slice().sort(),
    fixture("events")
      .map(({ kind }) => kind)
      .sort(),
  );
});
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

test("turn.started accepts an optional text prompt and rejects malformed prompt fields", () => {
  const base = fixture("events").find((value) => value.kind === "turn.started");
  const event = {
    schemaVersion: 1,
    protocolVersion: 2,
    recordId: "r1",
    eventId: "r1",
    createdAt: "2026-10-26T00:00:00.000Z",
    sourceIds: [],
    scopeId: "w-demo",
    sessionId: "s1",
    seq: 1,
    durable: true,
    ...base,
  };
  assert.doesNotThrow(() => validateEvent(event, context));
  assert.doesNotThrow(() =>
    validateEvent(
      {
        ...event,
        payload: { ...event.payload, userPrompt: "hello [redacted]" },
      },
      context,
    ),
  );
  for (const userPrompt of [null, 12, {}, ""])
    assert.throws(() =>
      validateEvent(
        { ...event, payload: { ...event.payload, userPrompt } },
        context,
      ),
    );
});
const rejects = (call) =>
  assert.throws(
    call,
    (error) =>
      error instanceof ContractError &&
      typeof error.code === "string" &&
      error.code.length > 0,
  );
const command = (op, payload) => ({
  protocolVersion: 2,
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
  protocolVersion: 2,
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
  assert.equal(PROTOCOL_VERSION, 2);
  assert.equal(PI_REVISION, "d5b3de22d0e24a3e9c38a9410d3329b099717283");
  assert.deepEqual(FOUNDATION, {
    entryMode: "sdk-host",
    disabledBuiltinExtensions: ["llama.cpp", "codemode", "tool-search", "mcp"],
  });
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

const boundProfileSnapshot = (modelId = "org/model:version") => ({
  ...copy(records.profileSnapshot),
  bindings: [
    {
      role: "chat",
      providerConnectionId: records.providerConnection.providerConnectionId,
      connectionRevision: records.providerConnection.revision,
      modelId,
    },
  ],
});

test("TD-26: profileSnapshot preserves namespace, slash, colon and Bedrock model references", () => {
  for (const modelId of [
    "anthropic",
    "anthropic/claude-sonnet-4-5",
    "openrouter/anthropic",
    "us.anthropic.claude-3-5-sonnet-20241022-v2:0",
    "arn:aws:bedrock:us-east-1:123456789012:foundation-model/anthropic.claude-v2:1",
    "æ¨¡åž‹/Ð¼Ð¾Ð´ÐµÐ»ÑŒ:Ã©",
    "x".repeat(256),
  ]) {
    const input = boundProfileSnapshot(modelId);
    assert.deepEqual(validateRecord("profileSnapshot", input, context), input);
  }
});

test("TD-26: legacy profileSnapshot bindings remain readable without a model reference", () => {
  const input = boundProfileSnapshot();
  delete input.bindings[0].modelId;
  assert.deepEqual(validateRecord("profileSnapshot", input, context), input);
});

for (const point of [
  0x0080, 0x0085, 0x009f, 0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x202a,
  0x2060, 0xfeff, 0x2028, 0x2029, 0x00ad, 0x061c, 0x180e, 0xe0001,
]) {
  const label = `U+${point.toString(16).toUpperCase().padStart(4, "0")}`;
  test(`TD-26: profileSnapshot independently rejects a model reference containing ${label}`, () => {
    const valid = boundProfileSnapshot();
    assert.deepEqual(validateRecord("profileSnapshot", valid, context), valid);
    const invalid = copy(valid);
    invalid.bindings[0].modelId = `org/model${String.fromCodePoint(point)}suffix:v1`;
    assert.throws(
      () => validateRecord("profileSnapshot", invalid, context),
      (error) =>
        error instanceof ContractError && error.code === "INVALID_SHAPE",
    );
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
    ["branchAnchor", { piSessionId: "missing" }],
    ["branchAnchor", { parentAnchorId: "missing" }],
    ["action", { targetScopeId: "other-workspace" }],
    ["providerRole", { locality: "hosted", qualificationRef: null }],
    ["providerRole", { limits: { tokens: Infinity } }],
  ])
    rejects(() =>
      validateRecord(kind, { ...records[kind], ...patch }, context),
    );
  assert.deepEqual(validateRecord("run", records.run, context), records.run);
});

test("event ledger records validate nested envelopes and matching durable metadata", () => {
  const original = records.event;
  for (const patch of [
    { seq: 0 },
    { sessionId: "other" },
    { recordId: "missing" },
    { eventId: "different" },
    { durable: false },
    { payload: { state: "ready", activeWorkers: -1 } },
    { sourceIds: ["missing"] },
  ]) {
    rejects(() =>
      validateRecord(
        "event",
        { ...original, envelope: { ...original.envelope, ...patch } },
        context,
      ),
    );
  }
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
    { protocolVersion: 1 },
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

test("TD-10: branch anchors hold opaque Pi identities, never raw paths", () => {
  const anchor = records.branchAnchor;
  assert.deepEqual(
    validateRecord(
      "branchAnchor",
      {
        ...anchor,
        parentAnchorId: null,
        forkPointEntryId: null,
        activeLeafEntryId: null,
        firstChildEntryId: "entry2",
      },
      context,
    ).firstChildEntryId,
    "entry2",
  );
  for (const field of [
    "branchAnchorId",
    "piSessionId",
    "forkPointEntryId",
    "firstChildEntryId",
    "activeLeafEntryId",
  ])
    for (const value of ["C:\\pi\\s1.jsonl", "/home/pi/s1.jsonl", " "])
      rejects(() =>
        validateRecord("branchAnchor", { ...anchor, [field]: value }, context),
      );
  for (const field of ["branchAnchorId", "piSessionId"])
    rejects(() =>
      validateRecord("branchAnchor", { ...anchor, [field]: null }, context),
    );
});

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
    { protocolVersion: 1 },
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
    payload: { runId: "r1", delta: "ðŸ˜€".repeat(40) },
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

test("shared inline default accepts 65536 UTF-8 payload bytes and rejects one extra", () => {
  const payload = { runId: "r1", delta: "ðŸ˜€" };
  const padding =
    TRANSPORT_LIMITS.maxInlineBytes -
    Buffer.byteLength(JSON.stringify(payload), "utf8");
  payload.delta += "x".repeat(padding);
  const input = event({ kind: "turn.stream_delta", durable: false, payload });
  const bounded = {
    ...context,
    maxInlineBytes: TRANSPORT_LIMITS.maxInlineBytes,
  };
  assert.equal(Buffer.byteLength(JSON.stringify(payload), "utf8"), 65536);
  assert.deepEqual(validateEvent(input, bounded), input);
  assert.throws(
    () =>
      validateEvent(
        { ...input, payload: { ...payload, delta: payload.delta + "x" } },
        bounded,
      ),
    (error) =>
      error instanceof ContractError && error.code === "FRAME_TOO_LARGE",
  );
  assert.deepEqual(validateEvent(input, bounded), input);
});

test("engine status ports use the same exact availability contract", () => {
  const ports = {
    generation: false,
    provider: false,
    workspace: false,
    modules: false,
  };
  const status = event({
    kind: "engine.status",
    payload: { state: "ready", activeWorkers: 0, ports },
  });
  assert.deepEqual(validateEvent(status, context), status);
  for (const invalid of [
    {},
    { ...ports, generation: 1 },
    { ...ports, extra: false },
  ])
    rejects(() =>
      validateEvent(
        { ...status, payload: { ...status.payload, ports: invalid } },
        context,
      ),
    );
  rejects(() => validateEvent({ ...status, protocolVersion: 1 }, context));
  assert.deepEqual(
    validateEvent(
      { ...status, payload: { state: "ready", activeWorkers: 0 } },
      context,
    ).payload,
    { state: "ready", activeWorkers: 0 },
  );
});

test("TD-01: frozen handshake accepts unavailable but requires all readiness guards", () => {
  const input = fixture("handshake");
  assert.deepEqual(validateHandshake(input), input);
  const ready = {
    ...input,
    readiness: {
      state: "ready",
      policy: true,
      store: true,
      receipts: true,
      ports: {
        generation: true,
        provider: true,
        workspace: true,
        modules: true,
      },
    },
  };
  assert.deepEqual(validateHandshake(ready), ready);
  for (const field of [
    "protocolVersion",
    "schemaVersion",
    "engineProtocolVersion",
    "bridgeProtocolVersion",
  ])
    rejects(() =>
      validateHandshake({
        ...input,
        [field]: field === "schemaVersion" ? 2 : 1,
      }),
    );
  for (const field of ["policy", "store", "receipts"])
    rejects(() =>
      validateHandshake({
        ...ready,
        readiness: { ...ready.readiness, [field]: false },
      }),
    );
  for (const ports of [
    {},
    { ...ready.readiness.ports, generation: "true" },
    { ...ready.readiness.ports, extra: false },
  ])
    rejects(() =>
      validateHandshake({ ...ready, readiness: { ...ready.readiness, ports } }),
    );
  rejects(() =>
    validateHandshake({
      ...input,
      readiness: { ...input.readiness, ports: ready.readiness.ports },
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

test("TD-01: turn.tool_outcome summary is optional, strict and bounded", () => {
  const base = fixture("events").find(
    (value) => value.kind === "turn.tool_outcome",
  );
  assert.equal(base.payload.summary, undefined);
  validateEvent(event(base), context);
  const withSummary = (summary) =>
    event({ ...base, payload: { ...base.payload, summary } });
  const cases = fixture("tool-outcome-summary");
  for (const summary of cases.valid)
    assert.deepEqual(
      validateEvent(withSummary(summary), context).payload.summary,
      summary,
    );
  for (const summary of cases.invalid)
    rejects(() => validateEvent(withSummary(summary), context));
  const preview = (length) => ({ preview: "p".repeat(length) });
  validateEvent(withSummary(preview(2048)), context);
  rejects(() => validateEvent(withSummary(preview(2049)), context));
  for (const bad of [null, [], "x", 1])
    rejects(() => validateEvent(withSummary(bad), context));
});

test("TD-15: stream.resync is an exact unsequenced control frame, never an event", () => {
  const control = {
    frame: "control",
    kind: "stream.resync",
    sessionId: "s1",
    fromSeq: 0,
  };
  assert.deepEqual(validateControlFrame(control), control);
  assert.equal(
    validateControlFrame({ ...control, fromSeq: Number.MAX_SAFE_INTEGER })
      .fromSeq,
    Number.MAX_SAFE_INTEGER,
  );
  for (const bad of [
    { ...control, seq: 1 },
    { ...control, extra: true },
    { ...control, frame: "data" },
    { ...control, kind: "stream.other" },
    { ...control, sessionId: "a b" },
    { ...control, fromSeq: -1 },
    { ...control, fromSeq: 1.5 },
    { ...control, fromSeq: Number.MAX_SAFE_INTEGER + 1 },
    { frame: "control", kind: "stream.resync", sessionId: "s1" },
  ])
    rejects(() => validateControlFrame(bad));
  // The old durable data shape is no longer an event kind.
  rejects(() =>
    validateEvent(
      event({ kind: "stream.resync", payload: { fromSeq: 0 } }),
      context,
    ),
  );
  assert.equal(
    JSON.parse(BRIDGE_PROTOCOL_JSON).eventKinds.includes("stream.resync"),
    false,
  );
});

test("TD-70: child.* payloads are strict at every level and status matches the kind", () => {
  const find = (kind) => fixture("events").find((value) => value.kind === kind);
  const valid = event(find("child.completed"));
  assert.deepEqual(validateEvent(valid, context), valid);
  const patched = (mutate) => {
    const input = copy(valid);
    mutate(input.payload);
    return input;
  };
  for (const mutate of [
    (p) => (p.budget.extra = 1),
    (p) => (p.budget.used = -1),
    (p) => delete p.budget.limit,
    (p) => (p.citations[0].extra = 1),
    (p) => (p.citations[0].line = 0),
    (p) => (p.citations = ["src/main.ts:3"]),
    (p) => delete p.citations[0].path,
    (p) => (p.diff.extra = 1),
    (p) => (p.diff.files[0].extra = 1),
    (p) => (p.diff.files[0].status = "renamed"),
    (p) => (p.diff = { files: "src/main.ts" }),
    (p) => (p.status = "running"),
    (p) => (p.reason = "BUDGET_TURNS"),
    (p) => (p.runId = "r1"),
    (p) => (p.parentRunId = "missing"),
  ])
    rejects(() => validateEvent(patched(mutate), context));
  for (const [kind, status] of [
    ["child.started", "completed"],
    ["child.progress", "failed"],
    ["child.cancelled", "running"],
  ]) {
    const fields = find(kind);
    rejects(() =>
      validateEvent(
        event({ ...fields, payload: { ...fields.payload, status } }),
        context,
      ),
    );
  }
  const failed = find("child.failed");
  const { reason: _reason, ...noReason } = failed.payload;
  rejects(() =>
    validateEvent(event({ ...failed, payload: noReason }), context),
  );
});
