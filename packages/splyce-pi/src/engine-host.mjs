import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { createNativeHost } from "./native-host.mjs";
import { NativeControl } from "./native-control.mjs";
import { validateNativeSessionSetup } from "./native-session-setup.mjs";
import { StoreError } from "../dist/store.js";
import {
  ModelsListError,
  validateModelsListRequest,
  validateModelsListResult,
} from "../dist/model-data.js";
import {
  PAGE_READ_OPS,
  PageReadError,
  validatePageReadRequest,
  validatePageReadResult,
} from "../dist/page-data.js";
import {
  CONTRACT_VERSION,
  PROTOCOL_VERSION,
  PI_REVISION,
  FOUNDATION,
  TRANSPORT_LIMITS,
  validateHandshake,
  validateCommand,
  validatePermissionResult,
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
  let hostShutdown;
  let closing = false;
  let stopped = false;
  let failure;
  let inputEnded = false;
  let queued = 0;
  let writes = Promise.resolve();
  let operations = Promise.resolve();
  const lifetime = new AbortController();
  let native;
  const subscriptions = new Map();
  let removeEventListener = () => {};
  const fail = (error) => {
    failure ??= error;
    lifetime.abort();
    native?.shutdown();
    input.destroy?.();
  };
  const write = (value, maySend) => {
    const frame = encodeFrame(value);
    writes = writes.then(
      () =>
        new Promise((resolveWrite, rejectWrite) => {
          if (maySend && !maySend()) return resolveWrite();
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
  function drain(sessionId) {
    const subscription = subscriptions.get(sessionId);
    if (!subscription || !subscription.active || subscription.draining) return;
    subscription.draining = true;
    void (async () => {
      try {
        do {
          subscription.pending = false;
          const batch = await host.drainSessionEvents(sessionId);
          if (
            !batch ||
            !Array.isArray(batch.frames) ||
            typeof batch.morePending !== "boolean"
          )
            throw new FrameError();
          for (const event of batch.frames) {
            if (
              subscriptions.get(sessionId) !== subscription ||
              !subscription.active
            )
              return;
            await write({ event });
          }
          subscription.pending ||= batch.morePending;
        } while (
          subscription.pending &&
          subscriptions.get(sessionId) === subscription &&
          subscription.active
        );
      } catch (error) {
        fail(error);
      } finally {
        subscription.draining = false;
        if (
          subscription.pending &&
          subscriptions.get(sessionId) === subscription &&
          subscription.active
        )
          drain(sessionId);
      }
    })();
  }
  const exact = (value, fields) =>
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === fields.length &&
    fields.every((field) => Object.hasOwn(value, field));
  const validId = (value) =>
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value) <= 128 &&
    !/[\s\p{Cc}\p{Cf}\/\\]/u.test(value);
  const denied = (id, code = "POLICY_DENIED") => ({
    id,
    ok: false,
    error: {
      code,
      message: "Native command unavailable",
      correlationId: id,
      retryable: false,
    },
  });
  native = new NativeControl(write, fail);
  async function handle(request) {
    if (stopped || failure) return;
    if (closing && request.method !== "shutdown")
      return write(denied(request.id));
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
      removeEventListener =
        host.onSessionEvents?.((sessionId) => {
          const subscription = subscriptions.get(sessionId);
          if (subscription) {
            subscription.pending = true;
            drain(sessionId);
          }
        }) ?? (() => {});
      reply = { id: request.id, ok: true, value: { state: "initialized" } };
    } else if (request.method === "native.bootstrap") {
      throw new FrameError();
    } else if (
      [
        "native.provider.prepare",
        "native.provider.commit",
        "native.provider.read",
      ].includes(request.method)
    ) {
      try {
        const method = {
          "native.provider.prepare": "prepareProviderSetup",
          "native.provider.commit": "commitProviderSetup",
          "native.provider.read": "readProviderSetup",
        }[request.method];
        reply = {
          id: request.id,
          ok: true,
          value: host[method](request.params),
        };
      } catch (error) {
        const codes = [
          "SETUP_INVALID",
          "SETUP_UNAVAILABLE",
          "SETUP_WORKSPACE_UNAVAILABLE",
          "SETUP_DESCRIPTOR_UNAVAILABLE",
          "SETUP_REQUEST_CONFLICT",
          "SETUP_STALE_REVISION",
          "SETUP_CREDENTIAL_UNAVAILABLE",
          "SETUP_CREDENTIAL_RESERVATION_ORPHANED",
          "SETUP_OUTCOME_UNKNOWN",
          "SETUP_MODEL_METADATA_REQUIRED",
          "ENTITY_STALE_REVISION",
        ];
        const code = codes.includes(error?.code)
          ? error.code
          : "SETUP_OUTCOME_UNKNOWN";
        reply = {
          id: request.id,
          ok: false,
          error: {
            code,
            message: "Provider setup unavailable",
            correlationId: request.id,
            retryable: false,
          },
        };
      }
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
      closing = true;
      hostShutdown = Promise.resolve().then(() =>
        host.shutdown ? host.shutdown() : host.close(),
      );
      try {
        await hostShutdown;
      } catch (error) {
        if (error?.code !== "SHELL_CLEANUP_UNCERTAIN") throw error;
        hostShutdown = undefined;
        return write(denied(request.id, "UNCERTAIN_EFFECT"));
      }
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
      } else if (params.command === "models.list") {
        try {
          if (
            !exact(params, ["frame", "command", "requestId", "payload"]) ||
            !validId ||
            params.payload?.requestId !== params.requestId
          )
            throw new ModelsListError("MODEL_CATALOG_INVALID");
          const input = validateModelsListRequest(params.payload);
          const value = validateModelsListResult(
            await host.listModels(input, lifetime.signal),
          );
          reply = { id: request.id, ok: true, value };
        } catch (error) {
          reply = {
            id: request.id,
            ok: false,
            error: {
              code:
                error instanceof ModelsListError
                  ? error.code
                  : "MODEL_CATALOG_UNAVAILABLE",
              message: "Model catalog unavailable",
              correlationId: validId ? params.requestId : request.id,
              retryable: false,
            },
          };
        }
      } else if (PAGE_READ_OPS.includes(params.command)) {
        try {
          if (
            !exact(params, ["frame", "command", "requestId", "payload"]) ||
            !validId ||
            params.payload?.requestId !== params.requestId
          )
            throw new PageReadError("PAGE_READ_INVALID");
          const input = validatePageReadRequest(params.command, params.payload);
          const value = validatePageReadResult(
            params.command,
            await host.readPage(params.command, input),
          );
          reply = { id: request.id, ok: true, value };
        } catch (error) {
          reply = {
            id: request.id,
            ok: false,
            error: {
              code:
                error instanceof PageReadError
                  ? error.code
                  : "PAGE_READ_UNAVAILABLE",
              message: "Page data unavailable",
              correlationId: validId ? params.requestId : request.id,
              retryable: false,
            },
          };
        }
      } else if (
        Object.keys(params).length === 4 &&
        ["frame", "command", "requestId", "payload"].every((key) =>
          Object.hasOwn(params, key),
        ) &&
        [
          "profile.select",
          "session.start",
          "session.resume",
          "setup.read",
          "permission.set",
          "permission.read",
        ].includes(params.command) &&
        validId
      ) {
        try {
          const input = validateNativeSessionSetup(
            params.command,
            params.payload,
            params.requestId,
          );
          const method = {
            "profile.select": "selectProfile",
            "session.start": "startSession",
            "session.resume": "resumeSession",
            "setup.read": "readSetup",
            "permission.set": "setPermission",
            "permission.read": "readPermission",
          }[params.command];
          let value = await host[method](
            input,
            params.requestId,
            lifetime.signal,
          );
          if (
            params.command === "permission.set" ||
            params.command === "permission.read"
          )
            value = validatePermissionResult(value, input);
          reply = { id: request.id, ok: true, value };
        } catch (error) {
          const codes = [
            "SETUP_INVALID",
            "SETUP_UNAVAILABLE",
            "SETUP_REQUEST_CONFLICT",
            "STALE_REVISION",
            "WORKSPACE_SUPERSEDED",
            "CREDENTIAL_UNAVAILABLE",
            "SETUP_OUTCOME_UNKNOWN",
          ];
          reply = {
            id: request.id,
            ok: false,
            error: {
              code: codes.includes(error?.code)
                ? error.code
                : "SETUP_UNAVAILABLE",
              message: "Native setup unavailable",
              correlationId: params.requestId,
              retryable: false,
            },
          };
        }
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
    } else if (request.method === "subscribe") {
      const { sessionId, afterSeq } = request.params;
      if (
        !exact(request.params, ["sessionId", "afterSeq"]) ||
        !validId(sessionId) ||
        !Number.isSafeInteger(afterSeq) ||
        afterSeq < 0
      ) {
        reply = denied(request.id);
      } else {
        const subscription = { active: false, draining: false, pending: true };
        subscriptions.set(sessionId, subscription);
        try {
          const value = await host.subscribeSession(sessionId, afterSeq);
          if (
            !exact(value, ["sessionId", "scopeId", "afterSeq"]) ||
            value.sessionId !== sessionId ||
            !validId(value.scopeId) ||
            value.afterSeq !== afterSeq
          )
            throw new FrameError();
          await write({ id: request.id, ok: true, value });
          subscription.active = true;
          drain(sessionId);
          return;
        } catch {
          subscriptions.delete(sessionId);
          reply = denied(request.id);
        }
      }
    } else if (request.method === "unsubscribe") {
      const { sessionId } = request.params;
      if (!exact(request.params, ["sessionId"]) || !validId(sessionId))
        reply = denied(request.id);
      else {
        subscriptions.delete(sessionId);
        try {
          await host.unsubscribeSession(sessionId);
          reply = { id: request.id, ok: true, value: { unsubscribed: true } };
        } catch {
          reply = denied(request.id);
        }
      }
    } else if (request.method === "cancel") {
      const { sessionId, reason } = request.params;
      if (
        !exact(request.params, ["sessionId", "reason"]) ||
        !validId(sessionId) ||
        (reason !== null &&
          (typeof reason !== "string" || reason.length > 4096))
      )
        reply = denied(request.id);
      else {
        try {
          const value = await host.cancelSession({ sessionId, reason });
          if (!exact(value, ["canceled"]) || value.canceled !== true)
            throw new FrameError();
          reply = { id: request.id, ok: true, value };
        } catch {
          reply = denied(request.id);
        }
      }
    } else if (request.method === "send") {
      try {
        const command = request.params;
        if (!["session.prompt", "approval.respond"].includes(command.op))
          throw new FrameError();
        validateCommand(command, {
          sessionId: command.sessionId,
          scopeId: command.scopeId,
          configRevision: command.expectedConfigRevision,
          profileRevision: command.expectedProfileRevision,
          policyRevision: command.expectedPolicyRevision,
          lastDurableSeq: 0,
          maxInlineBytes: TRANSPORT_LIMITS.maxEncodedFrameBytes,
          resolveReference: (ref) =>
            command.op === "approval.respond" &&
            [
              command.payload?.approvalRequestId,
              command.payload?.runId,
              command.payload?.actionId,
            ].includes(ref),
        });
        await host.assertCurrent(command.scopeId, {
          configRevision: command.expectedConfigRevision,
          profileRevision: command.expectedProfileRevision,
          policyRevision: command.expectedPolicyRevision,
        });
        const value =
          command.op === "approval.respond"
            ? await host.respondApproval(command)
            : await host.preparePrompt(command, lifetime.signal);
        if (
          !exact(
            value,
            command.op === "approval.respond"
              ? ["accepted"]
              : ["accepted", "runId", "turnId"],
          ) ||
          value.accepted !== true ||
          (command.op === "session.prompt" &&
            (!validId(value.runId) || !validId(value.turnId)))
        )
          throw new FrameError();
        reply = { id: request.id, ok: true, value };
      } catch (error) {
        if (inputEnded) throw error;
        reply = denied(
          request.id,
          error?.code === "STALE_REVISION" ? "STALE_REVISION" : "POLICY_DENIED",
        );
      }
    } else {
      reply = denied(request.id);
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
    inputEnded = true;
    native.shutdown();
    await operations;
    try {
      await writes;
    } catch (error) {
      fail(error);
    }
    if (failure) throw failure;
  } finally {
    removeEventListener();
    subscriptions.clear();
    native.shutdown();
    if (!hostShutdown) {
      if (host?.shutdown) await host.shutdown();
      else await host?.close();
    }
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
