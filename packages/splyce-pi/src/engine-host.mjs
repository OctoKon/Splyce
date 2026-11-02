import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { createNativeHost } from "./native-host.mjs";
import { NativeControl } from "./native-control.mjs";
import { StoreError } from "../dist/store.js";
import {
  CONTRACT_VERSION,
  PROTOCOL_VERSION,
  PI_REVISION,
  FOUNDATION,
  TRANSPORT_LIMITS,
  validateHandshake,
} from "@splyce/pi/contracts";

export const MAX_FRAME_BYTES = TRANSPORT_LIMITS.maxEncodedFrameBytes;

export class FrameError extends Error {
  constructor() {
    super("Invalid engine frame");
    this.name = "FrameError";
  }
}

export function encodeFrame(value) {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  if (!payload.length || payload.length + 4 > MAX_FRAME_BYTES)
    throw new FrameError();
  const frame = Buffer.allocUnsafe(payload.length + 4);
  frame.writeUInt32BE(payload.length);
  payload.copy(frame, 4);
  return frame;
}

export async function* readFrames(input) {
  const header = Buffer.alloc(4);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let headerBytes = 0;
  let payload;
  let payloadBytes = 0;
  for await (const chunk of input) {
    if (!Buffer.isBuffer(chunk)) throw new FrameError();
    let offset = 0;
    while (offset < chunk.length) {
      if (!payload) {
        const count = Math.min(4 - headerBytes, chunk.length - offset);
        chunk.copy(header, headerBytes, offset, offset + count);
        headerBytes += count;
        offset += count;
        if (headerBytes < 4) continue;
        const length = header.readUInt32BE();
        if (!length || length + 4 > MAX_FRAME_BYTES) throw new FrameError();
        payload = Buffer.allocUnsafe(length);
        payloadBytes = 0;
      }
      const count = Math.min(
        payload.length - payloadBytes,
        chunk.length - offset,
      );
      chunk.copy(payload, payloadBytes, offset, offset + count);
      payloadBytes += count;
      offset += count;
      if (payloadBytes === payload.length) {
        let value;
        try {
          value = JSON.parse(decoder.decode(payload));
        } catch {
          throw new FrameError();
        }
        payload = undefined;
        headerBytes = 0;
        yield value;
      }
    }
  }
  if (headerBytes || payload) throw new FrameError();
}

function nativeHandshake(host) {
  return validateHandshake({
    protocolVersion: PROTOCOL_VERSION,
    schemaVersion: CONTRACT_VERSION,
    engineProtocolVersion: PROTOCOL_VERSION,
    bridgeProtocolVersion: PROTOCOL_VERSION,
    piRevision: PI_REVISION,
    entryMode: FOUNDATION.entryMode,
    disabledBuiltinExtensions: [...FOUNDATION.disabledBuiltinExtensions],
    readiness: host.handshakeReadiness,
  });
}

export function isRequest(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === 3 &&
    Object.keys(value).every((key) =>
      ["id", "method", "params"].includes(key),
    ) &&
    typeof value.id === "string" &&
    value.id.length > 0 &&
    Buffer.byteLength(value.id, "utf8") <= 128 &&
    !/[\s\\/]/u.test(value.id) &&
    typeof value.method === "string" &&
    value.params !== null &&
    typeof value.params === "object" &&
    !Array.isArray(value.params)
  );
}

export async function runHost(
  input = process.stdin,
  output = process.stdout,
  createHost = createNativeHost,
) {
  let host;
  let stopped = false;
  let failure;
  let queued = 0;
  let writes = Promise.resolve();
  let operations = Promise.resolve();
  const lifetime = new AbortController();
  let native;
  const fail = (error) => {
    failure ??= error;
    lifetime.abort();
    native?.shutdown();
    input.destroy?.();
  };
  const write = (value) => {
    const frame = encodeFrame(value);
    writes = writes.then(
      () =>
        new Promise((resolveWrite, rejectWrite) => {
          const finish = (error) => {
            clearTimeout(timer);
            output.removeListener("close", closed);
            output.removeListener("error", closed);
            lifetime.signal.removeEventListener("abort", closed);
            if (error) {
              output.destroy?.();
              rejectWrite(new FrameError());
            } else resolveWrite();
          };
          const closed = () => finish(true);
          const timer = setTimeout(closed, 10_000);
          timer.unref();
          output.once("close", closed);
          output.once("error", closed);
          lifetime.signal.addEventListener("abort", closed, { once: true });
          if (lifetime.signal.aborted || output.destroyed) return closed();
          try {
            output.write(frame, finish);
          } catch {
            closed();
          }
        }),
    );
    writes.catch(fail);
    return writes;
  };
  native = new NativeControl(write, fail);
  async function handle(request) {
    if (stopped || failure) return;
    let reply;
    let shutdown = false;
    if (host === undefined) {
      // The native parent sends this before exposing any renderer command.
      if (
        request.id !== "native-bootstrap" ||
        request.method !== "native.bootstrap" ||
        Object.keys(request.params).length !== 1 ||
        !Object.hasOwn(request.params, "appDataDir")
      )
        throw new FrameError();
      host = createHost(request.params.appDataDir, native);
      reply = { id: request.id, ok: true, value: { state: "initialized" } };
    } else if (request.method === "native.bootstrap") {
      throw new FrameError();
    } else if (request.method === "native.workspace.admit") {
      try {
        const workspace = host.admitWorkspace(request.params);
        reply = { id: request.id, ok: true, value: workspace };
      } catch (error) {
        if (
          !(error instanceof StoreError) ||
          ![
            "WORKSPACE_INPUT",
            "WORKSPACE_PATH_INVALID",
            "WORKSPACE_IDENTITY_CHANGED",
            "WORKSPACE_ADMISSION_CHANGED",
          ].includes(error.code)
        )
          throw error;
        reply = {
          id: request.id,
          ok: false,
          error: {
            code: "POLICY_DENIED",
            message: "Workspace admission unavailable",
            correlationId: request.id,
            retryable: false,
          },
        };
      }
    } else if (
      request.method === "handshake" &&
      Object.keys(request.params).length === 1 &&
      request.params.protocolVersion === PROTOCOL_VERSION
    ) {
      reply = { id: request.id, ok: true, value: nativeHandshake(host) };
    } else if (
      request.method === "shutdown" &&
      Object.keys(request.params).length === 0
    ) {
      reply = { id: request.id, ok: true, value: { state: "stopped" } };
      shutdown = true;
    } else if (request.method === "send" && request.params.frame === "setup") {
      const params = request.params;
      const validId =
        typeof params.requestId === "string" &&
        params.requestId.length > 0 &&
        Buffer.byteLength(params.requestId, "utf8") <= 128 &&
        !/[\s\\/]/u.test(params.requestId);
      if (
        Object.keys(params).length === 4 &&
        ["frame", "command", "requestId", "payload"].every((key) =>
          Object.hasOwn(params, key),
        ) &&
        params.command === "metadata" &&
        validId &&
        params.payload !== null &&
        typeof params.payload === "object" &&
        !Array.isArray(params.payload) &&
        Object.keys(params.payload).length === 0
      ) {
        reply = {
          id: request.id,
          ok: true,
          value: {
            workspaces: host.listWorkspaces(),
            readiness: host.handshakeReadiness,
          },
        };
      } else {
        reply = {
          id: request.id,
          ok: false,
          error: {
            code: "POLICY_DENIED",
            message: "Native command unavailable",
            correlationId: validId ? params.requestId : request.id,
            retryable: false,
          },
        };
      }
    } else {
      let code = "POLICY_DENIED";
      if (request.method === "send") {
        try {
          await host.assertCurrent(request.params.scopeId, {
            configRevision: request.params.expectedConfigRevision,
            profileRevision: request.params.expectedProfileRevision,
            policyRevision: request.params.expectedPolicyRevision,
          });
        } catch (error) {
          if (error?.code === "STALE_REVISION") code = error.code;
          else if (
            ![
              "NATIVE_INVALID_ID",
              "NATIVE_CONFIG_UNAVAILABLE",
              "NATIVE_PROFILE_UNAVAILABLE",
              "NATIVE_PROFILE_STALE",
            ].includes(error?.code)
          )
            throw error;
        }
      }
      reply = {
        id: request.id,
        ok: false,
        error: {
          code,
          message:
            "Generation unconfigured; native runnable ports are unavailable",
          correlationId: request.id,
          retryable: false,
        },
      };
    }
    await write(reply);
    if (shutdown) {
      stopped = true;
      input.destroy?.();
    }
  }
  try {
    try {
      // Private responses must keep moving while an ordinary operation awaits a credential.
      for await (const request of readFrames(input)) {
        if (
          request &&
          typeof request === "object" &&
          Object.hasOwn(request, "native")
        ) {
          native.accept(request);
          continue;
        }
        if (!isRequest(request) || queued >= 8) throw new FrameError();
        queued += 1;
        operations = operations
          .then(() => handle(request))
          .catch(fail)
          .finally(() => {
            queued -= 1;
          });
      }
    } catch (error) {
      if (!stopped && !failure) fail(error);
    }
    // EOF revokes pending native reads; late responses cannot outlive this host.
    native.shutdown();
    await operations;
    try {
      await writes;
    } catch (error) {
      fail(error);
    }
    if (failure) throw failure;
  } finally {
    native.shutdown();
    host?.close();
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  runHost().catch(() => {
    process.stderr.write("Engine bootstrap failed\n");
    process.exitCode = 1;
    process.stdin.destroy();
  });
}
