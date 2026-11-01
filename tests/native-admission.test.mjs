import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import {
  bindSplyceToolAdmission,
  runToolCall,
} from "@earendil-works/pi-agent-core";
import {
  NativePolicy,
  actionArgumentsDigest,
} from "../packages/splyce-pi/dist/policy.js";
import { Store } from "../packages/splyce-pi/dist/store.js";
import { admitAndGrant } from "./fixtures/native-grants.mjs";
import { NestedToolCallRunner } from "../vendor/pi/packages/coding-agent/dist/core/nested-tool-calls.js";

const records = JSON.parse(
  await readFile(
    new URL("./fixtures/contracts/records.json", import.meta.url),
    "utf8",
  ),
);
const assistant = {
  role: "assistant",
  content: [],
  api: "openai-completions",
  provider: "fixture",
  model: "fixture",
  timestamp: 0,
  stopReason: "toolUse",
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
};

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "splyce-admission-"));
  const path = join(dir, "store.db");
  const canary = join(dir, "fixture.txt");
  await writeFile(canary, "unchanged");
  const store = Store.open(path);
  t.after(async () => {
    if (!store.closed) store.close();
    await rm(dir, { recursive: true, force: true });
  });
  const fixtureRefs = new Set([
    "s1",
    "b1",
    "w-demo",
    "snapshot1",
    "e1",
    "grant1",
    "p1",
    "binding1",
    "cap1",
    "args1",
  ]);
  const caller = {
    sessionId: "s1",
    configRevision: "cfg1",
    profileRevision: "profile1",
    policyRevision: "policy1",
    resolveReference(id, scope) {
      return (
        (scope === "w-demo" || fixtureRefs.has(scope)) &&
        (fixtureRefs.has(id) ||
          store
            .list(scope)
            .records.some(
              ({ record }) =>
                record.recordId === id ||
                record.runId === id ||
                record.actionId === id,
            ))
      );
    },
  };
  const args = { text: "changed" };
  const granted = admitAndGrant(store, caller, fixtureRefs, records, {
    actionId: "a1",
    argumentsDigest: actionArgumentsDigest(args),
  });
  let run = granted.run;
  store.append({ kind: "run", record: run }, caller);
  const ownership = store.acquireWorkspace(granted.workspaceId, "s1");
  let active = { ...caller, grantIds: [granted.grantId], planMode: false };
  const policy = new NativePolicy(
    store,
    caller,
    () => active,
    granted.identity,
  );
  const permit = {
    toolCallId: "call-1",
    toolName: "fixture_write",
    actionId: "a1",
    runRecordId: "rec-run",
    grantId: granted.grantId,
    parentActionId: null,
    capabilityId: "cap1",
    capabilityVersion: "1",
    argumentsArtifactId: "args1",
    argumentsDigest: actionArgumentsDigest(args),
    targetScopeId: "w-demo",
    idempotencyKey: "effect-1",
    ownership,
    capability: "fs.write",
  };
  policy.authorize(permit);
  let after = 0;
  let executions = 0;
  let dispatchHistory;
  const tool = {
    name: permit.toolName,
    label: "Fixture write",
    description: "Write owned fixture",
    parameters: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
      additionalProperties: false,
    },
    async execute(_id, admittedArgs) {
      executions++;
      const fresh = Store.open(path);
      try {
        dispatchHistory = fresh
          .list("w-demo")
          .records.filter(({ kind }) => kind === "action")
          .map(({ record }) => record.state);
      } finally {
        fresh.close();
      }
      await writeFile(canary, admittedArgs.text);
      return { content: [{ type: "text", text: "written" }], details: {} };
    },
  };
  const unbind = bindSplyceToolAdmission(tool, policy);
  t.after(unbind);
  const context = { messages: [], tools: [tool] };
  const call = {
    type: "toolCall",
    id: permit.toolCallId,
    name: tool.name,
    arguments: args,
  };
  const options = {
    tools: [tool],
    assistantMessage: assistant,
    context,
    afterToolCall: async () => {
      after++;
    },
  };
  return {
    dir,
    path,
    canary,
    store,
    caller,
    ownership,
    policy,
    permit,
    workspaceId: granted.workspaceId,
    grantId: granted.grantId,
    identity: granted.identity,
    get run() {
      return run;
    },
    get grantIds() {
      return active.grantIds;
    },
    /** Mints a once grant for another action and adds it to the run and live grant set. */
    grant(actionId) {
      const grantId = granted.mint(actionId);
      run = {
        ...run,
        recordId: `rec-run-${actionId}`,
        grantIds: [...run.grantIds, grantId],
      };
      store.append({ kind: "run", record: run }, caller);
      active = { ...active, grantIds: [...active.grantIds, grantId] };
      return grantId;
    },
    tool,
    unbind,
    call,
    options,
    setActive(value) {
      active = { ...active, ...value };
    },
    get executions() {
      return executions;
    },
    get completions() {
      return after;
    },
    get dispatchHistory() {
      return dispatchHistory;
    },
  };
}

test("native Pi tool effect follows durable decision/intent and precedes durable outcome", async (t) => {
  const f = await fixture(t);
  const result = await runToolCall(f.call, f.options);
  assert.equal(result.isError, false);
  assert.equal(await readFile(f.canary, "utf8"), "changed");
  assert.deepEqual(
    f.dispatchHistory,
    ["proposed", "approved", "running"],
    "physical effect requires independently readable durable decision and intent",
  );
  const reopen = Store.open(f.path);
  try {
    assert.deepEqual(
      reopen
        .list("w-demo")
        .records.filter(({ kind }) => kind !== "run")
        .map(({ kind, record }) => [kind, record.state ?? record.effectState]),
      [
        ["action", "proposed"],
        ["action", "approved"],
        ["action", "running"],
        ["outcome", "observed-success"],
        ["action", "completed"],
      ],
    );
  } finally {
    reopen.close();
  }
  assert.equal(f.completions, 1);
  await assert.rejects(runToolCall(f.call, f.options), {
    code: "ACTION_REQUIRES_RECONCILIATION",
  });
  assert.equal(
    f.executions,
    1,
    "replaying a completed or unresolved intent never repeats the effect",
  );
});

test("native preparation denies changed validated arguments before extension hooks", async (t) => {
  const f = await fixture(t);
  let hooks = 0;
  let error;
  try {
    await runToolCall(
      { ...f.call, arguments: { text: "different" } },
      {
        ...f.options,
        beforeToolCall: async () => {
          hooks++;
          await writeFile(f.canary, "hook");
        },
      },
    );
  } catch (caught) {
    error = caught;
  }
  assert.equal(
    await readFile(f.canary, "utf8"),
    "unchanged",
    "native preparation must precede extension effects",
  );
  assert.equal(error?.code, "ARGUMENTS_CHANGED");
  assert.equal(hooks, 0);
  assert.equal(f.executions, 0);
});

test("missing native preparation fails closed before argument callbacks or hooks", async (t) => {
  const f = await fixture(t);
  f.unbind();
  let callbacks = 0;
  f.tool.prepareArguments = (args) => {
    callbacks++;
    return args;
  };
  const unbind = bindSplyceToolAdmission(f.tool, {
    check: f.policy.check.bind(f.policy),
    finish: f.policy.finish.bind(f.policy),
    discard: f.policy.discard.bind(f.policy),
    execute: f.policy.execute.bind(f.policy),
  });
  t.after(unbind);
  await assert.rejects(
    runToolCall(f.call, {
      ...f.options,
      beforeToolCall: async () => {
        callbacks++;
      },
    }),
    { message: "SPLYCE_ADMISSION_PREPARE_REQUIRED" },
  );
  assert.equal(callbacks, 0);
  assert.equal(await readFile(f.canary, "utf8"), "unchanged");
});

test("native adapter prepares only schema-validated arguments then runs real policy", async (t) => {
  const f = await fixture(t);
  f.unbind();
  const order = [];
  const unbind = bindSplyceToolAdmission(f.tool, {
    check(_id, name, signal) {
      f.policy.check(f.permit.toolCallId, name, signal);
    },
    reserve(id, name, signal) {
      f.policy.authorize({
        ...f.permit,
        toolCallId: id,
        actionId: `action-${id}`,
        grantId: f.grant(`action-${id}`),
        idempotencyKey: `effect-${id}`,
      });
      f.policy.reserve(id, name, signal);
    },
    async prepare(id, name, args, parent, signal) {
      order.push("prepare");
      assert.deepEqual(args, { text: "changed" });
      assert.notEqual(args, f.call.arguments);
      await f.policy.prepare(id, name, args, parent, signal);
      assert.equal(
        f.store.list("w-demo").records.at(-1).record.state,
        "proposed",
        "preparation commits no intent or effect",
      );
    },
    finish: f.policy.finish.bind(f.policy),
    discard: f.policy.discard.bind(f.policy),
    execute: f.policy.execute.bind(f.policy),
  });
  t.after(unbind);
  const invalid = await runToolCall(
    { ...f.call, id: "invalid", arguments: {} },
    {
      ...f.options,
      beforeToolCall: async () => {
        order.push("hook");
      },
    },
  );
  assert.equal(invalid.isError, true);
  assert.deepEqual(order, []);
  assert.equal(await readFile(f.canary, "utf8"), "unchanged");
  const result = await runToolCall(
    { ...f.call, id: "dynamic" },
    {
      ...f.options,
      beforeToolCall: async () => {
        order.push("hook");
      },
    },
  );
  assert.equal(result.isError, false);
  assert.deepEqual(order, ["prepare", "hook"]);
  assert.deepEqual(f.dispatchHistory, [
    "proposed",
    "denied",
    "proposed",
    "approved",
    "running",
  ]);
  assert.equal(await readFile(f.canary, "utf8"), "changed");
});

test("cancellation before preparation reserves the call ID before extension hooks", async (t) => {
  const f = await fixture(t);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    runToolCall(f.call, { ...f.options, signal: controller.signal }),
    { code: "CANCELED" },
  );
  let hooks = 0;
  await assert.rejects(
    runToolCall(f.call, {
      ...f.options,
      beforeToolCall: async () => {
        hooks++;
        await writeFile(f.canary, "hook-after-abort");
      },
    }),
    { code: "ACTION_REQUIRES_RECONCILIATION" },
  );
  assert.equal(
    await readFile(f.canary, "utf8"),
    "unchanged",
    "canceled call reservation must precede extension effects",
  );
  assert.equal(hooks, 0);
  assert.equal(f.executions, 0);
});

for (const interruption of ["blocked", "aborted"]) {
  test(`${interruption} preparation requires a fresh tool-call ID`, async (t) => {
    const f = await fixture(t);
    const controller = new AbortController();
    const result = await runToolCall(f.call, {
      ...f.options,
      signal: controller.signal,
      beforeToolCall: async () => {
        if (interruption === "aborted") controller.abort();
        return { block: true };
      },
    });
    assert.equal(result.isError, true);
    assert.deepEqual(
      f.store
        .list("w-demo")
        .records.slice(1)
        .map(({ record }) => record.state),
      ["proposed", interruption === "aborted" ? "canceled" : "denied"],
    );
    await assert.rejects(runToolCall(f.call, f.options), {
      code: "ACTION_REQUIRES_RECONCILIATION",
    });
    assert.equal(await readFile(f.canary, "utf8"), "unchanged");
    assert.equal(f.executions, 0);
    f.policy.authorize({
      ...f.permit,
      toolCallId: "fresh",
      actionId: "fresh-action",
      grantId: f.grant("fresh-action"),
      idempotencyKey: "fresh-effect",
    });
    assert.equal(
      (await runToolCall({ ...f.call, id: "fresh" }, f.options)).isError,
      false,
    );
    assert.equal(await readFile(f.canary, "utf8"), "changed");
  });
}

test("cancellation during native preparation reaches no extension hook or effect", async (t) => {
  const f = await fixture(t);
  f.unbind();
  const controller = new AbortController();
  const unbind = bindSplyceToolAdmission(f.tool, {
    check: f.policy.check.bind(f.policy),
    reserve: f.policy.reserve.bind(f.policy),
    async prepare(...args) {
      await f.policy.prepare(...args);
      controller.abort();
    },
    finish: f.policy.finish.bind(f.policy),
    discard: f.policy.discard.bind(f.policy),
    execute: f.policy.execute.bind(f.policy),
  });
  t.after(unbind);
  const result = await runToolCall(f.call, {
    ...f.options,
    signal: controller.signal,
    beforeToolCall: async () => {
      await writeFile(f.canary, "hook");
    },
  });
  assert.equal(
    await readFile(f.canary, "utf8"),
    "unchanged",
    "canceled native preparation must precede extension effects",
  );
  assert.equal(result.isError, true);
  assert.equal(f.executions, 0);
  assert.deepEqual(
    f.store
      .list("w-demo")
      .records.slice(1)
      .map(({ record }) => record.state),
    ["proposed", "canceled"],
  );
});

for (const change of [
  "revoked",
  "planMode",
  "config",
  "ownership",
  "arguments",
]) {
  test(`native final dispatch rejects ${change} after asynchronous preparation`, async (t) => {
    const f = await fixture(t);
    const options = {
      ...f.options,
      beforeToolCall: async ({ args }) => {
        await Promise.resolve();
        if (change === "revoked") f.setActive({ grantIds: [] });
        if (change === "planMode") f.setActive({ planMode: true });
        if (change === "config") f.setActive({ configRevision: "cfg2" });
        if (change === "ownership")
          f.store.renewWorkspace(f.workspaceId, "s1", f.ownership.epoch);
        if (change === "arguments") args.text = "different";
      },
    };
    let error;
    try {
      await runToolCall(f.call, options);
    } catch (caught) {
      error = caught;
    }
    assert.equal(
      await readFile(f.canary, "utf8"),
      "unchanged",
      "denied native dispatch must preserve physical bytes",
    );
    assert.ok(error, "native denial must reject");
    assert.equal(f.executions, 0);
    assert.equal(f.completions, 0);
  });
}

test("actual pre-effect SQLite commit failure blocks physical dispatch", async (t) => {
  const f = await fixture(t);
  f.store.db.exec(
    "CREATE TRIGGER refuse_intent BEFORE INSERT ON records WHEN NEW.kind = 'action' AND json_extract(NEW.payload, '$.state') = 'running' BEGIN SELECT RAISE(ABORT, 'fixture'); END;",
  );
  await assert.rejects(runToolCall(f.call, f.options));
  assert.equal(
    await readFile(f.canary, "utf8"),
    "unchanged",
    "failed intent must prevent physical bytes changing",
  );
  assert.equal(f.executions, 0);
  assert.equal(f.completions, 0);
  assert.equal(
    f.store.list("w-demo").records.length,
    2,
    "failed batch leaves only the proposal",
  );
});

test("terminal run record revokes a permit bound to its older running record", async (t) => {
  const f = await fixture(t);
  f.store.append(
    {
      kind: "run",
      record: { ...f.run, recordId: "run-terminal", state: "completed" },
    },
    f.caller,
  );
  await assert.rejects(runToolCall(f.call, f.options), {
    code: "POLICY_DENIED",
  });
  assert.equal(await readFile(f.canary, "utf8"), "unchanged");
  assert.equal(f.executions, 0);
});

test("terminal parent cannot authorize a nested action through its old intent", async (t) => {
  const f = await fixture(t);
  await runToolCall(f.call, f.options);
  await writeFile(f.canary, "after-parent");
  // Isolate parent state from the earlier rejection of consumed grants.
  f.policy.authorize({
    ...f.permit,
    toolCallId: "terminal-parent",
    grantId: f.grant(f.permit.actionId),
  });
  assert.doesNotThrow(
    () => f.policy.check("terminal-parent", f.permit.toolName, undefined),
    "the terminal-parent fixture has a currently valid Store grant",
  );
  f.policy.authorize({
    ...f.permit,
    toolCallId: "child",
    actionId: "child-action",
    grantId: f.grant("child-action"),
    idempotencyKey: "child-effect",
    parentActionId: "a1",
  });
  await assert.rejects(
    runToolCall(
      { ...f.call, id: "child" },
      { ...f.options, parentToolCallId: "terminal-parent" },
    ),
    {
      code: "PARENT_NOT_RUNNING",
    },
  );
  assert.equal(await readFile(f.canary, "utf8"), "after-parent");
  assert.equal(f.executions, 1);
});

test("post-effect SQLite failure exposes no completion and cannot replay", async (t) => {
  const f = await fixture(t);
  f.store.db.exec(
    "CREATE TRIGGER refuse_outcome BEFORE INSERT ON records WHEN NEW.kind = 'outcome' BEGIN SELECT RAISE(ABORT, 'fixture'); END;",
  );
  await assert.rejects(runToolCall(f.call, f.options));
  assert.equal(await readFile(f.canary, "utf8"), "changed");
  assert.equal(
    f.completions,
    0,
    "outcome failure cannot reach Pi completion hook",
  );
  assert.deepEqual(
    f.store
      .list("w-demo")
      .records.filter(({ kind }) => kind === "action")
      .map(({ record }) => record.state),
    ["proposed", "approved", "running"],
  );
  await assert.rejects(runToolCall(f.call, f.options), {
    code: "ACTION_REQUIRES_RECONCILIATION",
  });
  assert.equal(f.executions, 1);
});

test("real nested runner uses the same current native admission", async (t) => {
  const f = await fixture(t);
  f.policy.authorize({
    ...f.permit,
    toolCallId: "parent/1",
    actionId: "nested",
    idempotencyKey: "nested-effect",
    parentActionId: "a1",
  });
  f.setActive({ grantIds: [] });
  const events = [];
  const runner = new NestedToolCallRunner({
    getTools: () => [f.tool],
    isSequential: () => false,
    emit: async (event) => {
      events.push(event.type);
    },
    runToolCall: (call, parentToolCallId, signal, onUpdate) =>
      runToolCall(call, { ...f.options, parentToolCallId, signal, onUpdate }),
  });
  await assert.rejects(runner.execute("parent", f.tool.name, f.call.arguments));
  assert.equal(
    await readFile(f.canary, "utf8"),
    "unchanged",
    "denied nested effect must preserve physical bytes",
  );
  assert.equal(f.executions, 0);
  assert.equal(events.includes("tool_execution_end"), false);
});

test("real nested execution joins the running native parent action", async (t) => {
  const f = await fixture(t);
  f.policy.authorize({
    ...f.permit,
    toolCallId: `${f.call.id}/1`,
    actionId: "child-action",
    grantId: f.grant("child-action"),
    idempotencyKey: "child-effect",
    parentActionId: f.permit.actionId,
  });
  const runner = new NestedToolCallRunner({
    getTools: () => [f.tool],
    isSequential: () => false,
    emit: async () => {},
    runToolCall: (call, parentToolCallId, signal, onUpdate) =>
      runToolCall(call, { ...f.options, parentToolCallId, signal, onUpdate }),
  });
  const write = f.tool.execute;
  f.tool.execute = async (id, args) =>
    id === f.call.id
      ? (await runner.execute(id, f.tool.name, args)).result
      : write(id, args);
  const result = await runToolCall(f.call, f.options);
  assert.equal(result.isError, false);
  assert.equal(await readFile(f.canary, "utf8"), "changed");
  const actions = f.store
    .list("w-demo")
    .records.filter(({ kind }) => kind === "action");
  assert.deepEqual(
    actions.map(({ record }) => [
      record.actionId,
      record.parentActionId,
      record.state,
    ]),
    [
      ["a1", null, "proposed"],
      ["a1", null, "approved"],
      ["a1", null, "running"],
      ["child-action", "a1", "proposed"],
      ["child-action", "a1", "approved"],
      ["child-action", "a1", "running"],
      ["child-action", "a1", "completed"],
      ["a1", null, "completed"],
    ],
  );
});

for (const mismatch of [
  "missing",
  "unknown",
  "action",
  "run",
  "scope",
  "workspace",
  "epoch",
  "root",
]) {
  test(`native preparation rejects ${mismatch} parent before extension hooks`, async (t) => {
    const f = await fixture(t);
    await runToolCall(f.call, f.options);
    await writeFile(f.canary, "unchanged");
    f.policy.authorize({
      ...f.permit,
      toolCallId: "child",
      actionId: "child-action",
      grantId: f.grant("child-action"),
      idempotencyKey: "child-effect",
      parentActionId: mismatch === "root" ? null : f.permit.actionId,
    });
    if (!["missing", "unknown", "root"].includes(mismatch)) {
      f.policy.authorize({
        ...f.permit,
        toolCallId: "foreign",
        ...(mismatch === "action" ? { actionId: "foreign-action" } : {}),
        ...(mismatch === "run" ? { runRecordId: "foreign-run" } : {}),
        ...(mismatch === "scope" ? { targetScopeId: "foreign-scope" } : {}),
        ownership: {
          ...f.ownership,
          ...(mismatch === "workspace"
            ? { workspaceId: "foreign-workspace" }
            : {}),
          ...(mismatch === "epoch" ? { epoch: f.ownership.epoch + 1 } : {}),
        },
      });
    }
    let rejected;
    try {
      await runToolCall(
        { ...f.call, id: "child" },
        {
          ...f.options,
          ...(mismatch === "missing"
            ? {}
            : {
                parentToolCallId: mismatch === "root" ? f.call.id : "foreign",
              }),
          beforeToolCall: async () => {
            await writeFile(f.canary, "hook");
          },
        },
      );
    } catch (error) {
      rejected = error;
    }
    assert.equal(
      await readFile(f.canary, "utf8"),
      "unchanged",
      "invalid native parent must precede extension effects",
    );
    assert.equal(rejected?.code, "INVALID_PARENT");
    assert.equal(f.executions, 1);
  });
}

test("process death after durable intent reopens unresolved and never replays", async (t) => {
  const f = await fixture(t);
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(new URL("./native-admission-child.mjs", import.meta.url)),
      f.dir,
      JSON.stringify(f.permit),
    ],
    { stdio: "pipe", windowsHide: true },
  );
  let output = "";
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });
  const exit = new Promise((resolve) => child.once("exit", resolve));
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  });
  const deadline = Date.now() + 15000;
  while (true) {
    try {
      await readFile(join(f.dir, "intent-ready"));
      break;
    } catch {}
    assert.equal(child.exitCode, null, `child exited before intent: ${output}`);
    assert.ok(Date.now() < deadline, `child intent timeout: ${output}`);
    await delay(25);
  }
  assert.equal(child.kill("SIGKILL"), true);
  await exit;
  const reopened = Store.open(f.path);
  try {
    assert.deepEqual(
      reopened
        .list("w-demo")
        .records.filter(({ kind }) => kind === "action")
        .map(({ record }) => record.state),
      ["proposed", "approved", "running"],
    );
    assert.equal(
      reopened.list("w-demo").records.some(({ kind }) => kind === "outcome"),
      false,
    );
  } finally {
    reopened.close();
  }
  await assert.rejects(runToolCall(f.call, f.options), {
    code: "ACTION_REQUIRES_RECONCILIATION",
  });
  assert.equal(await readFile(f.canary, "utf8"), "unchanged");
  assert.equal(f.executions, 0);
});

test("removing native preparation, cancellation reservation, authority or intent commit fails physical assertions", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "splyce-admission-mutation-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const loader = join(dir, "mutation.mjs");
  await writeFile(
    loader,
    `import { registerHooks } from 'node:module';
registerHooks({load(url, context, next) {
  const result = next(url, context);
  if (process.env.SPLYCE_ADMISSION_MUTATION.startsWith('preparation')) {
    if (!url.endsWith('/agent/dist/agent-loop.js')) return result;
    const source = String(result.source);
    const start = source.indexOf('    await requireSplyceToolAdmission(tool).prepare(');
    const end = source.indexOf(');', start);
    if (start < 0 || end < 0) throw new Error('preparation mutation target missing');
    return {...result, source: source.slice(0, start) + (process.env.SPLYCE_ADMISSION_MUTATION === 'preparation-child' ? '    if (toolCall.id !== \"child\") ' + source.slice(start, end + 2) : '') + source.slice(end + 2)};
  }
  if (process.env.SPLYCE_ADMISSION_MUTATION === 'reservation-fence' && url.endsWith('/splyce-pi/dist/store.js')) {
    const source = String(result.source);
    const start = source.indexOf('            if (expectedActionReservation !== undefined) {');
    const end = source.indexOf('            if (workspaceAdmission !== undefined) {', start);
    if (start < 0 || end < 0) throw new Error('reservation fence mutation target missing');
    return {...result, source: source.slice(0, start) + source.slice(end)};
  }
  if (process.env.SPLYCE_ADMISSION_MUTATION === 'reservation-fence' || !url.endsWith('/splyce-pi/dist/policy.js')) return result;
  let source = String(result.source);
  if (process.env.SPLYCE_ADMISSION_MUTATION === 'reservation') {
    const start = source.indexOf('        if (phase === "prepare"');
    const end = source.indexOf('        if (signal?.aborted)', start);
    if (start < 0 || end < 0) throw new Error('reservation mutation target missing');
    source = source.slice(0, start) + source.slice(end);
    const fence = 'this.store.appendBatch([{ kind: "action", record: proposal }], this.caller, {';
    const pos = source.indexOf(fence);
    const close = source.indexOf('            }, {', pos);
    if (pos < 0 || close < 0) throw new Error('reservation fence missing');
    source = source.slice(0, pos) + source.slice(pos, pos + fence.length - 1) + 'undefined' + source.slice(close + 13);
  } else if (process.env.SPLYCE_ADMISSION_MUTATION === 'discard') {
    const start = source.indexOf('    discard(toolCallId, reason) {');
    const end = source.indexOf('    async execute(', start);
    if (start < 0 || end < 0) throw new Error('discard mutation target missing');
    source = source.slice(0, start) + '    discard() {}\\n' + source.slice(end);
  } else if (process.env.SPLYCE_ADMISSION_MUTATION === 'cancel-terminal') {
    const start = source.indexOf('    discard(toolCallId, reason) {');
    const target = '        if (proposal)';
    const pos = source.indexOf(target, start);
    if (start < 0 || pos < 0) throw new Error('cancel terminal mutation target missing');
    source = source.slice(0, pos) + source.slice(pos).replace(target, '        if (proposal && reason !== "canceled")');
  } else if (process.env.SPLYCE_ADMISSION_MUTATION === 'execution') {
    const target = '        if (!preparedDigest)\\n            throw new AdmissionError("PREPARATION_REQUIRED");';
    if (!source.includes(target)) throw new Error('execution mutation target missing');
    source = source.replace(target, '');
    source = source.replace('preparedDigest !== permit.argumentsDigest', 'false');
  } else if (process.env.SPLYCE_ADMISSION_MUTATION === 'authority') {
    const start = source.indexOf('    check(toolCallId, toolName, signal, phase) {');
    const end = source.indexOf('    reserve(', start);
    if (start < 0 || end < 0) throw new Error('authority mutation target missing');
    source = source.slice(0, start) + '    check() {}\\n' + source.slice(end);
  } else {
    const start = source.indexOf('this.store.consumeOnceGrant(', source.indexOf('    async execute('));
    if (start < 0) throw new Error('intent mutation target missing');
    let depth = 1, end = start + 'this.store.consumeOnceGrant('.length;
    for (; depth && end < source.length; end++) {
      if (source[end] === '(') depth++;
      if (source[end] === ')') depth--;
    }
    if (depth) throw new Error('intent mutation not closed');
    source = source.slice(0, start) + '({seqs: []})' + source.slice(end);
  }
  return {...result, source};
}});`,
  );
  const environment = Object.fromEntries(
    ["SystemRoot", "WINDIR", "TEMP", "TMP", "PATH", "PATHEXT"]
      .filter((key) => process.env[key])
      .map((key) => [key, process.env[key]]),
  );
  for (const [mutation, pattern, observation] of [
    [
      "preparation",
      "native preparation denies changed validated arguments",
      "native preparation must precede extension effects",
    ],
    [
      "preparation-child",
      "native preparation rejects missing parent",
      "invalid native parent must precede extension effects",
    ],
    [
      "reservation",
      "canceled ID cannot run argument preparation",
      "canceled argument callback must preserve physical bytes",
    ],
    [
      "discard",
      "blocked or failed hooks never leave an executable native preparation",
      "unfinished hook must prevent physical effect",
    ],
    [
      "cancel-terminal",
      "reopened canceled reservation refuses callbacks",
      "canceled terminal must be durable before reopen",
    ],
    [
      "execution",
      "direct execution requires native preparation",
      "unprepared dispatch must preserve physical bytes",
    ],
    [
      "reservation-fence",
      "changed reservation cannot dispatch after hook",
      "changed reservation must prevent physical effect",
    ],
    [
      "authority",
      "native final dispatch rejects revoked",
      "denied native dispatch must preserve physical bytes",
    ],
    [
      "intent",
      "actual pre-effect SQLite commit failure",
      "failed intent must prevent physical bytes changing",
    ],
  ]) {
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        pathToFileURL(loader).href,
        "--test",
        "--test-name-pattern",
        pattern,
        fileURLToPath(import.meta.url),
      ],
      {
        encoding: "utf8",
        windowsHide: true,
        timeout: 30000,
        env: { ...environment, SPLYCE_ADMISSION_MUTATION: mutation },
      },
    );
    assert.notEqual(result.status, 0, `${mutation} removal must fail`);
    assert.ok(
      (result.stdout + result.stderr).includes(observation),
      `${mutation} must fail its physical assertion: ${result.stdout}${result.stderr}`,
    );
  }
});
test("reserved IDs and unprepared execution cannot reach physical callbacks", async (t) => {
  const f = await fixture(t);
  f.policy.reserve(f.call.id, f.call.name, undefined);
  await f.policy.prepare(
    f.call.id,
    f.call.name,
    f.call.arguments,
    undefined,
    undefined,
  );
  f.tool.prepareArguments = (args) => {
    throw new Error("PREPARATION_CALLBACK_RAN");
  };
  await assert.rejects(runToolCall(f.call, f.options), {
    code: "ACTION_REQUIRES_RECONCILIATION",
  });
  const other = await fixture(t);
  await assert.rejects(
    other.policy.execute(
      other.call.id,
      other.call.name,
      other.call.arguments,
      async () => {
        await writeFile(other.canary, "effect");
        return { isError: false };
      },
      undefined,
    ),
    { code: "PREPARATION_REQUIRED" },
  );
  assert.equal(await readFile(other.canary, "utf8"), "unchanged");
});

for (const outcome of ["completed", "uncertain"]) {
  test(`reopened ${outcome} action is rejected before argument preparation`, async (t) => {
    const f = await fixture(t);
    if (outcome === "uncertain") {
      f.store.db.exec(
        "CREATE TRIGGER refuse_outcome BEFORE INSERT ON records WHEN NEW.kind = 'outcome' BEGIN SELECT RAISE(ABORT, 'fixture'); END;",
      );
      await assert.rejects(runToolCall(f.call, f.options));
    } else {
      await runToolCall(f.call, f.options);
    }
    await writeFile(f.canary, "before-replay");
    f.unbind();
    const reopened = Store.open(f.path);

    const policy = new NativePolicy(
      reopened,
      f.caller,
      () => ({
        ...f.caller,
        grantIds: [f.grantId],
        planMode: false,
      }),
      f.identity,
    );
    policy.authorize(f.permit);
    const unbind = bindSplyceToolAdmission(f.tool, policy);
    t.after(unbind);
    f.tool.prepareArguments = (args) => {
      throw new Error("PREPARATION_CALLBACK_RAN");
    };
    await assert.rejects(runToolCall(f.call, f.options), {
      code: "ACTION_REQUIRES_RECONCILIATION",
    });
    assert.equal(await readFile(f.canary, "utf8"), "before-replay");
    assert.equal(f.executions, 1);
    reopened.close();
  });
}

test("canceled ID cannot run argument preparation and fresh ID recovers", async (t) => {
  const f = await fixture(t);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    runToolCall(f.call, { ...f.options, signal: controller.signal }),
    { code: "CANCELED" },
  );
  let calls = 0;
  f.tool.prepareArguments = (args) => {
    calls++;
    writeFileSync(f.canary, "callback");
    return args;
  };
  await assert.rejects(runToolCall(f.call, f.options), {
    code: "ACTION_REQUIRES_RECONCILIATION",
  });
  assert.equal(
    await readFile(f.canary, "utf8"),
    "unchanged",
    "canceled argument callback must preserve physical bytes",
  );
  assert.equal(calls, 0);
  f.policy.authorize({
    ...f.permit,
    toolCallId: "new",
    actionId: "new-action",
    grantId: f.grant("new-action"),
    idempotencyKey: "new-effect",
  });
  assert.equal(
    (await runToolCall({ ...f.call, id: "new" }, f.options)).isError,
    false,
  );
  assert.equal(calls, 1);
  assert.equal(await readFile(f.canary, "utf8"), "changed");
});

test("direct execution requires native preparation", async (t) => {
  const f = await fixture(t);
  f.policy.reserve(f.call.id, f.call.name, undefined);
  let error;
  try {
    await f.policy.execute(
      f.call.id,
      f.call.name,
      f.call.arguments,
      async () => {
        await writeFile(f.canary, "effect");
        return { isError: false };
      },
      undefined,
    );
  } catch (caught) {
    error = caught;
  }
  assert.equal(
    await readFile(f.canary, "utf8"),
    "unchanged",
    "unprepared dispatch must preserve physical bytes",
  );
  assert.equal(error?.code, "PREPARATION_REQUIRED");
});

test("blocked or failed hooks never leave an executable native preparation", async (t) => {
  for (const mode of ["blocked", "failed", "canceled"]) {
    const f = await fixture(t);
    const controller = new AbortController();
    const result = await runToolCall(f.call, {
      ...f.options,
      signal: controller.signal,
      beforeToolCall: () => {
        if (mode === "failed") throw new Error("fixture");
        if (mode === "canceled") controller.abort();
        if (mode === "blocked") return { block: true };
      },
    });
    assert.equal(result.isError, true);
    let error;
    try {
      f.policy.finish(f.call.id, f.call.name, f.call.arguments, undefined);
      await f.policy.execute(
        f.call.id,
        f.call.name,
        f.call.arguments,
        async () => {
          await writeFile(f.canary, "effect");
          return { isError: false };
        },
        undefined,
      );
    } catch (caught) {
      error = caught;
    }
    assert.equal(
      await readFile(f.canary, "utf8"),
      "unchanged",
      "unfinished hook must prevent physical effect",
    );
    assert.equal(error?.code, "PREPARATION_REQUIRED");
  }
});

test("another policy cannot reuse an in-flight identity before argument callbacks", async (t) => {
  const f = await fixture(t);
  const secondStore = Store.open(f.path);
  const other = new NativePolicy(
    secondStore,
    f.caller,
    () => ({
      ...f.caller,
      grantIds: [f.grantId],
      planMode: false,
    }),
    f.identity,
  );
  other.authorize(f.permit);
  const tool = {
    ...f.tool,
    prepareArguments(args) {
      writeFileSync(f.canary, "callback");
      return args;
    },
  };
  const unbind = bindSplyceToolAdmission(tool, other);
  let release;
  let reached;
  const entered = new Promise((resolve) => {
    reached = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const first = runToolCall(f.call, {
    ...f.options,
    beforeToolCall: async () => {
      reached();
      await gate;
      return { block: true };
    },
  });
  try {
    await entered;
    await assert.rejects(runToolCall(f.call, { ...f.options, tools: [tool] }), {
      code: "ACTION_REQUIRES_RECONCILIATION",
    });
    assert.equal(
      await readFile(f.canary, "utf8"),
      "unchanged",
      "shared reservation must precede argument callbacks",
    );
  } finally {
    release();
    await first;
    unbind();
    secondStore.close();
  }
});

test("changed reservation cannot dispatch after hook", async (t) => {
  const f = await fixture(t);
  const second = Store.open(f.path);
  try {
    let error;
    let outcome;
    try {
      outcome = await runToolCall(f.call, {
        ...f.options,
        beforeToolCall: async () => {
          const proposal = second
            .list("w-demo")
            .records.find(
              ({ kind, record }) =>
                kind === "action" && record.state === "proposed",
            ).record;
          second.append(
            {
              kind: "action",
              record: {
                ...proposal,
                recordId: "competing-terminal",
                state: "canceled",
              },
            },
            f.caller,
          );
        },
      });
    } catch (caught) {
      error = caught;
    }
    assert.equal(
      await readFile(f.canary, "utf8"),
      "unchanged",
      "changed reservation must prevent physical effect",
    );
    assert.equal(
      error?.code,
      "ACTION_REQUIRES_RECONCILIATION",
      JSON.stringify(outcome),
    );
  } finally {
    second.close();
  }
});

test("reservation commit failure prevents argument callbacks", async (t) => {
  const f = await fixture(t);
  let callbacks = 0;
  f.store.db.exec(
    "CREATE TRIGGER refuse_proposal BEFORE INSERT ON records WHEN NEW.kind = 'action' BEGIN SELECT RAISE(ABORT, 'fixture'); END;",
  );
  f.tool.prepareArguments = (args) => {
    callbacks++;
    writeFileSync(f.canary, "callback");
    return args;
  };
  await assert.rejects(runToolCall(f.call, f.options), {
    name: "StoreError",
    code: "STORE_SQLITE_ERROR",
    message: "fixture",
  });
  assert.equal(await readFile(f.canary, "utf8"), "unchanged");
  assert.equal(f.executions, 0);
  assert.equal(callbacks, 0);
  assert.deepEqual(
    f.store.list("w-demo").records.filter(({ kind }) => kind === "action"),
    [],
  );
  const reopened = Store.open(f.path);
  try {
    assert.deepEqual(
      reopened.list("w-demo").records.filter(({ kind }) => kind === "action"),
      [],
    );
  } finally {
    reopened.close();
  }
});

for (const terminal of ["proposed", "canceled"]) {
  test(`reopened ${terminal} reservation refuses callbacks`, async (t) => {
    const f = await fixture(t);
    if (terminal === "proposed")
      f.policy.reserve(f.call.id, f.call.name, undefined);
    else {
      const controller = new AbortController();
      await runToolCall(f.call, {
        ...f.options,
        signal: controller.signal,
        beforeToolCall: () => {
          controller.abort();
        },
      });
    }
    const expectedStates =
      terminal === "canceled" ? ["proposed", "canceled"] : ["proposed"];
    assert.deepEqual(
      f.store
        .list("w-demo")
        .records.filter(({ kind }) => kind === "action")
        .map(({ record }) => record.state),
      expectedStates,
      terminal === "canceled"
        ? "canceled terminal must be durable before reopen"
        : "proposal must be durable before reopen",
    );
    f.unbind();
    const second = Store.open(f.path);
    try {
      assert.deepEqual(
        second
          .list("w-demo")
          .records.filter(({ kind }) => kind === "action")
          .map(({ record }) => record.state),
        expectedStates,
        "durable history must survive reopen",
      );
      const policy = new NativePolicy(
        second,
        f.caller,
        () => ({
          ...f.caller,
          grantIds: f.grantIds,
          planMode: false,
        }),
        f.identity,
      );
      policy.authorize(f.permit);
      const unbind = bindSplyceToolAdmission(f.tool, policy);
      try {
        f.tool.prepareArguments = (args) => {
          writeFileSync(f.canary, "callback");
          return args;
        };
        await assert.rejects(runToolCall(f.call, f.options), {
          code: "ACTION_REQUIRES_RECONCILIATION",
        });
        assert.equal(await readFile(f.canary, "utf8"), "unchanged");
        assert.deepEqual(
          second
            .list("w-demo")
            .records.filter(({ kind }) => kind === "action")
            .map(({ record }) => record.state),
          expectedStates,
        );
        policy.authorize({
          ...f.permit,
          toolCallId: "fresh-reopened",
          actionId: "fresh-reopened-action",
          grantId: f.grant("fresh-reopened-action"),
          idempotencyKey: "fresh-reopened-effect",
        });
        assert.equal(
          (await runToolCall({ ...f.call, id: "fresh-reopened" }, f.options))
            .isError,
          false,
        );
        assert.equal(await readFile(f.canary, "utf8"), "changed");
      } finally {
        unbind();
      }
    } finally {
      second.close();
    }
  });
}

test("terminal reservation write failure remains conservatively fenced", async (t) => {
  const f = await fixture(t);
  f.store.db.exec(
    "CREATE TRIGGER refuse_terminal BEFORE INSERT ON records WHEN NEW.kind = 'action' AND json_extract(NEW.payload, '$.state') = 'denied' BEGIN SELECT RAISE(ABORT, 'fixture'); END;",
  );
  await assert.rejects(
    runToolCall(f.call, {
      ...f.options,
      beforeToolCall: () => ({ block: true }),
    }),
  );
  assert.equal(await readFile(f.canary, "utf8"), "unchanged");
  const reopened = Store.open(f.path);
  try {
    const policy = new NativePolicy(
      reopened,
      f.caller,
      () => ({
        ...f.caller,
        grantIds: [f.grantId],
        planMode: false,
      }),
      f.identity,
    );
    policy.authorize(f.permit);
    assert.throws(() => policy.reserve(f.call.id, f.call.name, undefined), {
      code: "ACTION_REQUIRES_RECONCILIATION",
    });
  } finally {
    reopened.close();
  }
});

test("process death after proposal leaves durable replay fence", async (t) => {
  const f = await fixture(t);
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(new URL("./native-admission-child.mjs", import.meta.url)),
      f.dir,
      JSON.stringify(f.permit),
      "proposal",
    ],
    { stdio: ["ignore", "pipe", "pipe", "ipc"], windowsHide: true },
  );
  const exit = new Promise((resolve) => child.once("exit", resolve));
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("proposal child timeout")),
      15000,
    );
    child.once("message", (message) => {
      clearTimeout(timer);
      message === "proposal-ready"
        ? resolve()
        : reject(new Error("unexpected child message"));
    });
    child.once("exit", () => {
      clearTimeout(timer);
      reject(new Error("proposal child exited before marker"));
    });
  });
  assert.equal(
    await readFile(join(f.dir, "proposal-ready"), "utf8"),
    "durable",
  );
  assert.equal(child.kill("SIGKILL"), true);
  await exit;
  const reopened = Store.open(f.path);
  try {
    assert.deepEqual(
      reopened
        .list("w-demo")
        .records.filter(({ kind }) => kind === "action")
        .map(({ record }) => record.state),
      ["proposed"],
    );
    const policy = new NativePolicy(
      reopened,
      f.caller,
      () => ({
        ...f.caller,
        grantIds: [f.grantId],
        planMode: false,
      }),
      f.identity,
    );
    policy.authorize(f.permit);
    assert.throws(() => policy.reserve(f.call.id, f.call.name, undefined), {
      code: "ACTION_REQUIRES_RECONCILIATION",
    });
    assert.equal(await readFile(f.canary, "utf8"), "unchanged");
  } finally {
    reopened.close();
  }
});
