import { randomUUID } from "node:crypto";
import { TRANSPORT_LIMITS } from "@splyce/pi/contracts";

const unavailable = () =>
  Object.assign(new Error("Credential unavailable"), {
    code: "CREDENTIAL_UNAVAILABLE",
  });
const redactionUnavailable = () =>
  Object.assign(new Error("Persistence redaction unavailable"), {
    code: "PERSIST_REDACTION_UNAVAILABLE",
  });
const validText = (text) =>
  typeof text === "string" &&
  text.isWellFormed() &&
  Buffer.byteLength(text) <= 1048576;
const fitsFrame = (frame) =>
  Buffer.byteLength(JSON.stringify(frame)) + 4 <=
  TRANSPORT_LIMITS.maxEncodedFrameBytes;
const exact = (value, keys) =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));
const opaque = (value) =>
  typeof value === "string" &&
  Buffer.byteLength(value) <= 128 &&
  value.length > 0 &&
  !/[\s\p{Cc}/\\]/u.test(value);
const bindingKeys = [
  "scopeId",
  "target",
  "actionId",
  "profileRevision",
  "connectionRevision",
];

export class NativeControl {
  #send;
  #pending = new Map();
  #scopes = new Map();
  #epoch = randomUUID();
  #sequence = 0;
  #closed = false;
  #onFatal;

  constructor(sendFrame, onFatal = () => {}) {
    this.#send = sendFrame;
    this.#onFatal = onFatal;
  }

  #call(method, params, signal) {
    if (
      this.#closed ||
      signal?.aborted ||
      this.#pending.size >= 8 ||
      this.#sequence >= Number.MAX_SAFE_INTEGER
    )
      return Promise.reject(unavailable());
    const id = `${this.#epoch}-${++this.#sequence}`;
    if (
      method === "credential.redact" &&
      !fitsFrame({ native: { id, method, params } })
    )
      return Promise.reject(unavailable());
    return new Promise((resolve, reject) => {
      const finish = (error, value) => {
        if (!this.#pending.delete(id)) return;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        if (error) reject(unavailable());
        else resolve(value);
      };
      const abort = () => finish(true);
      const timer = setTimeout(abort, 10_000);
      timer.unref();
      this.#pending.set(id, { method, finish });
      signal?.addEventListener("abort", abort, { once: true });
      Promise.resolve()
        .then(() => {
          if (this.#pending.has(id))
            return this.#send({ native: { id, method, params } });
        })
        .catch(abort);
    });
  }

  accept(frame) {
    const fail = () => {
      this.shutdown();
      throw unavailable();
    };
    if (!exact(frame, ["native"])) return fail();
    const reply = frame.native;
    if (
      !reply ||
      typeof reply !== "object" ||
      typeof reply.id !== "string" ||
      typeof reply.ok !== "boolean"
    )
      return fail();
    const match = new RegExp(`^${this.#epoch}-(\\d+)$`).exec(reply.id);
    const sequence = match && Number(match[1]);
    if (
      !match ||
      !Number.isSafeInteger(sequence) ||
      sequence < 1 ||
      sequence > this.#sequence ||
      String(sequence) !== match[1]
    )
      return fail();
    const pending = this.#pending.get(reply.id);
    if (!reply.ok) {
      if (
        !exact(reply, ["id", "ok", "error"]) ||
        !exact(reply.error, ["code"]) ||
        !["CREDENTIAL_UNAVAILABLE", "PERSIST_REDACTION_UNAVAILABLE"].includes(
          reply.error.code,
        ) ||
        (pending &&
          reply.error.code !==
            (pending.method === "credential.redact"
              ? "PERSIST_REDACTION_UNAVAILABLE"
              : "CREDENTIAL_UNAVAILABLE"))
      )
        return fail();
      pending?.finish(true);
      return;
    }
    if (!exact(reply, ["id", "ok", "value"])) return fail();
    const isEmpty = exact(reply.value, []);
    const isSecret =
      exact(reply.value, ["secret"]) &&
      (reply.value.secret === null ||
        (typeof reply.value.secret === "string" &&
          Buffer.byteLength(reply.value.secret) <= 2560 &&
          !/\p{Cc}/u.test(reply.value.secret)));
    const isRedaction =
      exact(reply.value, ["text", "redactedCount"]) &&
      validText(reply.value.text) &&
      Number.isSafeInteger(reply.value.redactedCount) &&
      reply.value.redactedCount >= 0 &&
      fitsFrame(frame);
    if (
      (!isEmpty && !isSecret && !isRedaction) ||
      (pending &&
        (pending.method === "credential.read"
          ? !isSecret
          : pending.method === "credential.redact"
            ? !isRedaction
            : !isEmpty))
    )
      return fail();
    pending?.finish(false, reply.value);
  }

  async redact(text, signal) {
    if (!validText(text)) throw redactionUnavailable();
    try {
      const result = await this.#call("credential.redact", { text }, signal);
      if (this.#closed || signal?.aborted) throw redactionUnavailable();
      return result;
    } catch {
      throw redactionUnavailable();
    }
  }

  async open(binding, signal) {
    if (
      !exact(binding, bindingKeys) ||
      !opaque(binding.scopeId) ||
      !opaque(binding.actionId) ||
      !opaque(binding.profileRevision) ||
      !opaque(binding.connectionRevision) ||
      typeof binding.target !== "string" ||
      !/^splyce-credential:v1:[0-9a-f]{64}$/.test(binding.target) ||
      this.#closed ||
      signal?.aborted ||
      this.#scopes.size >= 8 ||
      this.#scopes.has(binding.scopeId)
    )
      throw unavailable();
    const params = { ...binding };
    const controller = new AbortController();
    const state = {
      read: false,
      closed: false,
      cleanup: () => signal?.removeEventListener("abort", onAbort),
    };
    this.#scopes.set(params.scopeId, state);
    let closing;
    const close = () => {
      if (closing) return closing;
      state.closed = true;
      state.cleanup();
      controller.abort();
      closing = this.#call("credential.scope.close", {
        scopeId: params.scopeId,
      }).then(
        () => {
          this.#scopes.delete(params.scopeId);
        },
        () => {
          if (!this.#closed) {
            this.shutdown();
            try {
              this.#onFatal(unavailable());
            } catch {
              /* Host failure callback cannot restore this control. */
            }
          }
          throw unavailable();
        },
      );
      return closing;
    };
    const onAbort = () => {
      close().catch(() => {});
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      await this.#call("credential.scope.open", params, controller.signal);
      if (signal?.aborted || this.#closed || state.closed) throw unavailable();
      return {
        read: async () => {
          if (state.closed || state.read || signal?.aborted)
            throw unavailable();
          state.read = true;
          const result = await this.#call(
            "credential.read",
            params,
            controller.signal,
          );
          if (state.closed || this.#closed || signal?.aborted)
            throw unavailable();
          return result.secret;
        },
        close,
      };
    } catch {
      if (!this.#closed) close().catch(() => {});
      throw unavailable();
    }
  }

  shutdown() {
    if (this.#closed) return;
    this.#closed = true;
    for (const pending of this.#pending.values()) pending.finish(true);
    for (const scope of this.#scopes.values()) {
      scope.closed = true;
      scope.cleanup();
    }
    this.#scopes.clear();
  }
}
