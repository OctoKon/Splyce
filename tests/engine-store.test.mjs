import assert from "node:assert/strict";
import test from "node:test";
import {
  CONTRACT_VERSION,
  FOUNDATION,
  PI_REVISION,
  PROTOCOL_VERSION,
} from "@splyce/pi/contracts";
import {
  connectionState,
  portAvailability,
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

test("TD-08: engine exit during handshake remains disconnected after late success or failure", async () => {
  const verified = {
    protocolVersion: PROTOCOL_VERSION,
    schemaVersion: CONTRACT_VERSION,
    engineProtocolVersion: PROTOCOL_VERSION,
    bridgeProtocolVersion: PROTOCOL_VERSION,
    piRevision: PI_REVISION,
    entryMode: FOUNDATION.entryMode,
    disabledBuiltinExtensions: [...FOUNDATION.disabledBuiltinExtensions],
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

  for (const outcome of ["success", "failure"]) {
    let deliverLifecycle;
    let settle;
    let entered;
    const invoked = new Promise((resolve) => {
      entered = resolve;
    });
    const response = new Promise((resolve, reject) => {
      settle = outcome === "success" ? resolve : reject;
    });
    globalThis.window = {
      __TAURI_INTERNALS__: {
        transformCallback: (callback) => {
          deliverLifecycle = callback;
          return 1;
        },
        invoke: (command, args) => {
          assert.equal(command, "handshake");
          assert.ok(args.onLifecycle);
          entered();
          return response;
        },
      },
    };
    const states = [];
    const unsubscribe = connectionState.subscribe((state) =>
      states.push(state),
    );
    try {
      const pending = handshake();
      await invoked;
      assert.equal(states.at(-1), "connecting");
      deliverLifecycle({
        index: 0,
        message: {
          protocolVersion: PROTOCOL_VERSION,
          kind: "engine_exited",
          expected: false,
          exitCode: 1,
          cleanupComplete: true,
        },
      });
      assert.equal(states.at(-1), "disconnected");
      settle(
        outcome === "success" ? verified : new Error("engine unavailable"),
      );
      if (outcome === "success") {
        assert.deepEqual(await pending, verified);
      } else {
        await assert.rejects(pending, /engine unavailable/);
      }
      assert.equal(states.at(-1), "disconnected");
      assert.deepEqual(states.slice(-2), ["connecting", "disconnected"]);
    } finally {
      unsubscribe();
      delete globalThis.window;
    }
  }
});

test("generation port controls renderer readiness and can recover", async () => {
  const verified = {
    protocolVersion: PROTOCOL_VERSION,
    schemaVersion: CONTRACT_VERSION,
    engineProtocolVersion: PROTOCOL_VERSION,
    bridgeProtocolVersion: PROTOCOL_VERSION,
    piRevision: PI_REVISION,
    entryMode: FOUNDATION.entryMode,
    disabledBuiltinExtensions: [...FOUNDATION.disabledBuiltinExtensions],
    readiness: {
      state: "ready",
      policy: true,
      store: true,
      receipts: true,
      ports: {
        generation: false,
        provider: false,
        workspace: false,
        modules: false,
      },
    },
  };
  globalThis.window = {
    __TAURI_INTERNALS__: {
      transformCallback: () => 1,
      invoke: async () => verified,
    },
  };
  let current;
  const unsubscribe = connectionState.subscribe((state) => {
    current = state;
  });
  try {
    assert.equal((await handshake()).readiness.state, "ready");
    assert.equal(current, "unavailable");
    verified.readiness.ports.generation = true;
    await handshake();
    assert.equal(current, "unavailable");
    verified.readiness.ports.provider = true;
    verified.readiness.ports.workspace = true;
    await handshake();
    assert.equal(current, "ready");
  } finally {
    unsubscribe();
    delete globalThis.window;
  }
});

test("status ports update from subscription and late events cannot resurrect an exited engine", async () => {
  const ports = {
    generation: false,
    provider: false,
    workspace: false,
    modules: false,
  };
  const verified = {
    protocolVersion: PROTOCOL_VERSION,
    schemaVersion: CONTRACT_VERSION,
    engineProtocolVersion: PROTOCOL_VERSION,
    bridgeProtocolVersion: PROTOCOL_VERSION,
    piRevision: PI_REVISION,
    entryMode: FOUNDATION.entryMode,
    disabledBuiltinExtensions: [...FOUNDATION.disabledBuiltinExtensions],
    readiness: {
      state: "ready",
      policy: true,
      store: true,
      receipts: true,
      ports,
    },
  };
  const callbacks = [];
  globalThis.window = {
    __TAURI_INTERNALS__: {
      transformCallback: (callback) => {
        callbacks.push(callback);
        return callbacks.length;
      },
      invoke: async (cmd) => (cmd === "handshake" ? verified : null),
    },
  };
  let current, latest;
  const offState = connectionState.subscribe((state) => {
    current = state;
  });
  const offPorts = portAvailability.subscribe((value) => {
    latest = value;
  });
  try {
    await handshake();
    assert.equal(current, "unavailable");
    assert.deepEqual(latest, ports);
    await subscribe("status-session");
    let index = 0;
    const emit = (payload) =>
      callbacks[1]({
        index: index++,
        message: {
          protocolVersion: PROTOCOL_VERSION,
          kind: "engine.status",
          payload,
        },
      });
    const enabled = {
      ...ports,
      generation: true,
      provider: true,
      workspace: true,
    };
    emit({ state: "ready", activeWorkers: 0, ports: enabled });
    assert.equal(current, "ready");
    assert.deepEqual(latest, enabled);
    emit({ state: "ready", activeWorkers: 0, ports });
    assert.equal(current, "unavailable");
    callbacks[0]({
      index: 0,
      message: {
        protocolVersion: PROTOCOL_VERSION,
        kind: "engine_exited",
        expected: false,
        exitCode: 1,
        cleanupComplete: true,
      },
    });
    assert.equal(current, "disconnected");
    assert.equal(latest, null);
    emit({ state: "ready", activeWorkers: 0, ports: enabled });
    assert.equal(current, "disconnected");
    assert.equal(latest, null);
  } finally {
    offState();
    offPorts();
    delete globalThis.window;
  }
});

test("malformed live port status fails closed without consumer delivery", async () => {
  const ports = {
    generation: true,
    provider: true,
    workspace: true,
    modules: true,
  };
  const verified = {
    protocolVersion: PROTOCOL_VERSION,
    schemaVersion: CONTRACT_VERSION,
    engineProtocolVersion: PROTOCOL_VERSION,
    bridgeProtocolVersion: PROTOCOL_VERSION,
    piRevision: PI_REVISION,
    entryMode: FOUNDATION.entryMode,
    disabledBuiltinExtensions: [...FOUNDATION.disabledBuiltinExtensions],
    readiness: {
      state: "ready",
      policy: true,
      store: true,
      receipts: true,
      ports,
    },
  };
  for (const [version, invalid] of [
    [PROTOCOL_VERSION, { generation: true, provider: true, workspace: true }],
    [PROTOCOL_VERSION, { ...ports, extra: true }],
    [PROTOCOL_VERSION, { ...ports, generation: "true" }],
    [PROTOCOL_VERSION, undefined],
    [999, ports],
    [999, { ...ports, extra: true }],
    [1, ports],
    [1, { ...ports, generation: "true" }],
    [undefined, ports],
    [undefined, undefined],
  ]) {
    const callbacks = [];
    globalThis.window = {
      __TAURI_INTERNALS__: {
        transformCallback: (callback) => {
          callbacks.push(callback);
          return callbacks.length;
        },
        invoke: async (cmd) => (cmd === "handshake" ? verified : null),
      },
    };
    let current, latest;
    const received = [];
    const offState = connectionState.subscribe((value) => {
      current = value;
    });
    const offPorts = portAvailability.subscribe((value) => {
      latest = value;
    });
    const offEvents = engine.onEvent((event) => received.push(event));
    try {
      await handshake();
      const dispose = await subscribe("invalid-status");
      let index = 0;
      const emit = (value, protocolVersion = PROTOCOL_VERSION) =>
        callbacks[1]({
          index: index++,
          message: {
            ...(protocolVersion === null ? {} : { protocolVersion }),
            kind: "engine.status",
            payload: { state: "ready", activeWorkers: 0, ports: value },
          },
        });
      emit(invalid, version === undefined ? null : version);
      assert.equal(current, "error");
      assert.equal(latest, null);
      assert.deepEqual(received, []);
      emit(ports);
      assert.equal(current, "error");
      assert.equal(latest, null);
      assert.deepEqual(received, []);
      dispose();
    } finally {
      offState();
      offPorts();
      offEvents();
      delete globalThis.window;
    }
  }
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
