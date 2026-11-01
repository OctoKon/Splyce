import assert from "node:assert/strict";
import test from "node:test";
import {
  connectionState,
  handshake,
  invoke,
  ackCursor,
  getCursor,
  subscribe,
  engine,
} from "../apps/desktop/src/stores/engine.ts";

test("TD-08: connectionState starts strictly 'disconnected'", () => {
  let observedState = "";
  const unsub = connectionState.subscribe((state) => {
    observedState = state;
  });
  unsub();
  assert.equal(observedState, "disconnected");
});

test("TD-08: handshake throws TAURI_IPC_UNAVAILABLE when native bridge is absent", async () => {
  await assert.rejects(
    async () => {
      await handshake();
    },
    { message: /TAURI_IPC_UNAVAILABLE/ },
  );

  let observed = "";
  const unsub = connectionState.subscribe((state) => {
    observed = state;
  });
  unsub();
  assert.equal(observed, "unavailable");
});

test("TD-08: invoke throws when native bridge is absent and does not fabricate success", async () => {
  const context = {
    sessionId: "ses_1",
    scopeId: "w-demo",
    expectedConfigRevision: "cfg1",
    expectedProfileRevision: "prof1",
    expectedPolicyRevision: "pol1",
  };

  await assert.rejects(
    async () => {
      await invoke("session.cancel", {}, context);
    },
    { message: /TAURI_IPC_UNAVAILABLE/ },
  );
});

test("TD-08: per-session cursor isolation", async () => {
  assert.equal(getCursor("ses_alpha"), 0);
  assert.equal(getCursor("ses_beta"), 0);

  await ackCursor("ses_alpha", 5);
  await ackCursor("ses_beta", 12);

  assert.equal(getCursor("ses_alpha"), 5);
  assert.equal(getCursor("ses_beta"), 12);

  // Monotonic: smaller seq does not regress cursor
  await ackCursor("ses_alpha", 3);
  assert.equal(getCursor("ses_alpha"), 5);
});

test("TD-18: disposing a subscription never cancels engine work", async () => {
  const calls = [];
  globalThis.window = {
    __TAURI_INTERNALS__: {
      invoke: async (cmd, args) => {
        calls.push([cmd, args]);
        return null;
      },
      transformCallback: () => 0,
    },
  };
  try {
    const dispose = await subscribe("ses_dispose", 0);
    dispose();
    // A subscription ends with its channel; unsubscribing must not reach the
    // engine as a cancel (cancel always means cancel).
    assert.deepEqual(
      calls.map(([cmd]) => cmd),
      ["subscribe"],
    );
  } finally {
    delete globalThis.window;
  }
});
