// Exercise the same built extension dispatcher modules shipped with the engine.
import assert from "node:assert/strict";
import test from "node:test";
import { createEventBus } from "../vendor/pi/packages/coding-agent/dist/core/event-bus.js";
import {
  createExtensionRuntime,
  loadExtensionFromFactory,
} from "../vendor/pi/packages/coding-agent/dist/core/extensions/loader.js";
import { ExtensionRunner } from "../vendor/pi/packages/coding-agent/dist/core/extensions/runner.js";
import { SessionManager } from "../vendor/pi/packages/coding-agent/dist/core/session-manager.js";

const message = { role: "user", content: "fixture text", timestamp: 0 };
const routes = [
  [
    "emit",
    "session_start",
    (runner) => runner.emit({ type: "session_start", reason: "new" }),
  ],
  [
    "emitMessageEnd",
    "message_end",
    (runner) => runner.emitMessageEnd({ type: "message_end", message }),
  ],
  [
    "emitBoundary",
    "turn_end",
    (runner) =>
      runner.emitBoundary(
        { type: "turn_end", turnIndex: 0, message, toolResults: [] },
        () => ({ messages: [] }),
      ),
  ],
  [
    "emitBeforeAgentStart",
    "before_agent_start",
    (runner) =>
      runner.emitBeforeAgentStart(
        { messageType: "user", prompt: "fixture prompt" },
        { cwd: process.cwd() },
      ),
  ],
];

async function fixture(event, action) {
  const runtime = createExtensionRuntime();
  let afterAppend = false;
  const extension = await loadExtensionFromFactory(
    (pi) => {
      pi.on(event, async () => {
        await pi.appendEntry("fixture-entry", { value: "fixture" });
        afterAppend = true;
      });
    },
    process.cwd(),
    createEventBus(),
    runtime,
  );
  runtime.appendEntry = action;
  // These dispatches never consult the model registry or construct a ModelRuntime.
  const runner = new ExtensionRunner(
    [extension],
    runtime,
    process.cwd(),
    SessionManager.inMemory(),
    {},
  );
  const reports = [];
  runner.onError((error) => reports.push(error));
  return { runner, reports, afterAppend: () => afterAppend };
}

for (const code of [
  "PERSIST_REDACTION_UNAVAILABLE",
  "PERSIST_ENTRY_TOO_LARGE",
]) {
  for (const [name, event, dispatch] of routes) {
    test(
      `${name} awaits append and rejects ${code} without false success or raw reports`,
      { timeout: 10000 },
      async () => {
        const entered = Promise.withResolvers();
        const release = Promise.withResolvers();
        const f = await fixture(event, async () => {
          entered.resolve();
          await release.promise;
          throw Object.assign(new Error("synthetic-private-cause"), {
            code,
            cause: "synthetic-private-cause",
          });
        });
        const pending = dispatch(f.runner);
        let settled = false;
        void pending.then(
          () => {
            settled = true;
          },
          () => {
            settled = true;
          },
        );
        await entered.promise;
        await Promise.resolve();
        assert.equal(
          settled,
          false,
          "the actual runner must remain pending during the append",
        );
        assert.equal(f.afterAppend(), false);
        release.resolve();
        await assert.rejects(
          pending,
          (error) =>
            error.code === code &&
            error.message === code &&
            error.cause === undefined &&
            !error.stack.includes("synthetic-private-cause"),
        );
        assert.equal(
          f.afterAppend(),
          false,
          "failed persistence must not reach the handler success continuation",
        );
        assert.deepEqual(
          f.reports,
          [],
          "typed persistence errors must escape before reporting raw extension data",
        );
      },
    );
  }
}

test("ordinary extension errors retain reporting and best-effort completion", async () => {
  for (const [, event, dispatch] of routes) {
    const f = await fixture(event, async () => {
      throw new Error("ordinary fixture failure");
    });
    await dispatch(f.runner);
    assert.equal(f.reports.length, 1);
    assert.equal(f.reports[0].error, "ordinary fixture failure");
    assert.equal(f.afterAppend(), false);
  }
});
