/**
 * TD-08: Desktop Engine Store and Native Bridge
 *
 * Implements the renderer-to-engine IPC connection layer conforming to TD-02, TD-06,
 * and the frozen @splyce/pi/contracts shared schema (TD-01).
 *
 * Enforces:
 * - Initial state is "disconnected" until an explicit native handshake succeeds.
 * - Authoritative caller-provided context (no fabricated default scopes/revisions).
 * - Per-session cursor tracking and subscription disposal.
 * - Strict error throwing when native Tauri IPC is unavailable (no success fallback).
 * - Uses native @tauri-apps/api/core invoke with zero mock fallback.
 */

import {
  PROTOCOL_VERSION,
  type CommandOp,
  type CommandPayloads,
  type Handshake,
  type SplyceCommand,
  type SplyceEvent,
  validateHandshake,
} from "@splyce/pi/contracts";

export type EngineConnectionState =
  "disconnected" | "connecting" | "unavailable" | "ready" | "busy" | "error";

export type EventCallback = (event: SplyceEvent) => void;
export type Unsubscribe = () => void;

export interface CommandContext {
  sessionId: string;
  scopeId: string;
  expectedConfigRevision: string;
  expectedProfileRevision: string;
  expectedPolicyRevision: string;
  correlationId?: string;
}

export interface EngineStore {
  connectionState: {
    subscribe: (fn: (state: EngineConnectionState) => void) => Unsubscribe;
  };
  handshake: () => Promise<Handshake>;
  subscribe: (sessionId: string, afterSeq?: number) => Promise<Unsubscribe>;
  onEvent: (callback: EventCallback) => Unsubscribe;
  invoke: <O extends CommandOp>(
    op: O,
    payload: CommandPayloads[O],
    context: CommandContext,
  ) => Promise<unknown>;
  ackCursor: (sessionId: string, seq: number) => Promise<void>;
  getCursor: (sessionId: string) => number;
  resync: (context: CommandContext, fromSeq: number) => Promise<void>;
  dispatchEngineEvent: (event: SplyceEvent) => void;
}

// Internal reactive state
let currentState: EngineConnectionState = "disconnected";
let lastHandshake: Handshake | null = null;
const stateListeners = new Set<(state: EngineConnectionState) => void>();
const eventListeners = new Set<EventCallback>();
const sessionCursors = new Map<string, number>();
const activeSubscriptions = new Map<string, Unsubscribe>();

function notifyState(next: EngineConnectionState) {
  currentState = next;
  for (const listener of stateListeners) {
    listener(currentState);
  }
}

async function getTauriInvoke(): Promise<
  ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) | null
> {
  if (typeof window === "undefined") return null;
  try {
    // Dynamic import to satisfy @tauri-apps/api/core module resolution in packaged Tauri WebView
    const core = (await import("@tauri-apps/api/core" as string)) as {
      invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
    };
    return core.invoke;
  } catch {
    if (typeof window !== "undefined") {
      const win = window as unknown as {
        __TAURI_INTERNALS__?: {
          invoke?: (
            cmd: string,
            args?: Record<string, unknown>,
          ) => Promise<unknown>;
        };
        __TAURI__?: {
          core?: {
            invoke: (
              cmd: string,
              args?: Record<string, unknown>,
            ) => Promise<unknown>;
          };
        };
      };
      if (win.__TAURI_INTERNALS__?.invoke) {
        return win.__TAURI_INTERNALS__.invoke;
      }
      if (win.__TAURI__?.core?.invoke) {
        return win.__TAURI__.core.invoke;
      }
    }
    return null;
  }
}

/**
 * Readable connection state store (starts strictly 'disconnected')
 */
export const connectionState = {
  subscribe(fn: (state: EngineConnectionState) => void): Unsubscribe {
    fn(currentState);
    stateListeners.add(fn);
    return () => stateListeners.delete(fn);
  },
};

/**
 * Perform native handshake and establish verified readiness
 */
export async function handshake(): Promise<Handshake> {
  notifyState("connecting");
  const invokeTauri = await getTauriInvoke();
  if (!invokeTauri) {
    notifyState("unavailable");
    throw new Error("TAURI_IPC_UNAVAILABLE: Native backend bridge not found");
  }

  try {
    const raw = await invokeTauri("handshake", {
      protocolVersion: PROTOCOL_VERSION,
      schemaVersion: 1,
    });
    const verified = validateHandshake(raw);
    lastHandshake = verified;
    if (verified.readiness.state === "ready") {
      notifyState("ready");
    } else {
      notifyState("unavailable");
    }
    return verified;
  } catch (err) {
    notifyState("error");
    throw err;
  }
}

/**
 * Register a listener for incoming engine push events
 */
export function onEvent(callback: EventCallback): Unsubscribe {
  eventListeners.add(callback);
  return () => eventListeners.delete(callback);
}

/**
 * Internal/testing event dispatcher used by Tauri IPC or fixture harnesses
 */
export function dispatchEngineEvent(event: SplyceEvent): void {
  for (const listener of eventListeners) {
    listener(event);
  }
}

/**
 * Subscribe to a session stream starting after a monotonic sequence with full channel cleanup
 */
export async function subscribe(
  sessionId: string,
  afterSeq?: number,
): Promise<Unsubscribe> {
  const invokeTauri = await getTauriInvoke();
  if (!invokeTauri) {
    throw new Error("TAURI_IPC_UNAVAILABLE: Native backend bridge not found");
  }

  // Dispose existing subscription for this session if any
  activeSubscriptions.get(sessionId)?.();

  const fromSeq = afterSeq ?? sessionCursors.get(sessionId) ?? 0;
  await invokeTauri("subscribe", { sessionId, afterSeq: fromSeq });

  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    // The native subscription ends with its channel (#61). Unsubscribing never
    // reaches the engine as a cancel: cancel always means cancel the run.
    activeSubscriptions.delete(sessionId);
  };

  activeSubscriptions.set(sessionId, dispose);
  return dispose;
}

/**
 * Invoke a typed engine command conforming to TD-01 shared contract.
 * Parent native send API takes { op, payload: fullSplyceCommand } where payload.op === op.
 */
export async function invoke<O extends CommandOp>(
  op: O,
  payload: CommandPayloads[O],
  context: CommandContext,
): Promise<unknown> {
  const invokeTauri = await getTauriInvoke();
  if (!invokeTauri) {
    throw new Error("TAURI_IPC_UNAVAILABLE: Native backend bridge not found");
  }

  const fullSplyceCommand = {
    protocolVersion: PROTOCOL_VERSION,
    correlationId:
      context.correlationId ??
      `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    sessionId: context.sessionId,
    scopeId: context.scopeId,
    expectedConfigRevision: context.expectedConfigRevision,
    expectedProfileRevision: context.expectedProfileRevision,
    expectedPolicyRevision: context.expectedPolicyRevision,
    op,
    payload,
  };

  return await invokeTauri("send", {
    op,
    payload: fullSplyceCommand,
  });
}

/**
 * Acknowledge durable event sequence per session
 */
export async function ackCursor(sessionId: string, seq: number): Promise<void> {
  const current = sessionCursors.get(sessionId) ?? 0;
  sessionCursors.set(sessionId, Math.max(current, seq));
}

/**
 * Read current durable cursor for a session
 */
export function getCursor(sessionId: string): number {
  return sessionCursors.get(sessionId) ?? 0;
}

/**
 * Request a stream resync snapshot after a sequence gap
 */
export async function resync(
  context: CommandContext,
  fromSeq: number,
): Promise<void> {
  await invoke("session.subscribe", { afterSeq: fromSeq }, context);
}

export const engine: EngineStore = {
  connectionState,
  handshake,
  subscribe,
  onEvent,
  invoke,
  ackCursor,
  getCursor,
  resync,
  dispatchEngineEvent,
};
