import type { JsonValue, ProviderConnectionRecord } from "./contracts.js";
import { NativeCredentialResolver } from "./credential-resolver.js";
import {
  AdmissionError,
  NativePolicy,
  actionArgumentsDigest,
  type ActionPermit,
} from "./policy.js";
import type { CredentialRequest, SecretLease } from "./provider-auth.js";
import type {
  NativeProviderRequestPort,
  NativeProviderScope,
} from "./provider-admission.js";

interface CredentialHandle {
  read(): Promise<string | null>;
  close(): Promise<void>;
}
interface Control {
  open(
    binding: {
      scopeId: string;
      target: string;
      actionId: string;
      profileRevision: string;
      connectionRevision: string;
    },
    signal?: AbortSignal,
  ): Promise<CredentialHandle>;
}
export interface NativeProviderSemanticRequest {
  readonly schema: "splyce-provider-request-v1";
  readonly apiFamily: "openai-completions" | "openai-responses";
  readonly endpointRef: string;
  readonly model: string;
  readonly context: {
    readonly systemPrompt?: string;
    readonly messages: readonly JsonValue[];
    readonly tools: readonly JsonValue[];
  };
  readonly options: Readonly<Record<string, JsonValue>>;
}
export interface NativeModelsSemanticRequest {
  readonly schema: "splyce-models-request-v1";
  readonly providerConnectionId: string;
  readonly endpointRef: string;
}
export interface NativeProviderEvent {
  readonly type: string;
  readonly reason?: string;
  readonly message?: {
    readonly api: string;
    readonly model: string;
    readonly stopReason: string;
  };
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function redactJson(value: unknown, redact: (text: string) => string): unknown {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value))
    return value.map((item) => redactJson(item, redact));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        redact(key),
        redactJson(item, redact),
      ]),
    );
  return value;
}
export interface NativeProviderBinding {
  readonly permit: ActionPermit;
  readonly args: NativeProviderSemanticRequest | NativeModelsSemanticRequest;
  readonly requestKind?: "models";
  readonly catalogTimeoutMs?: number;
  readonly parentToolCallId?: string;
  readonly request: CredentialRequest;
  readonly connection: ProviderConnectionRecord;
  readonly currentConnection: () => ProviderConnectionRecord;
  readonly admittedUrl: string;
  readonly modelId: string;
  readonly api: "openai-completions" | "openai-responses";
  readonly maxRequestBytes: number;
  readonly headersTimeoutMs: number;
  readonly profileRevision: string;
  readonly credentialTarget: string;
  readonly allowLocalLoopback: boolean;
}
type State = NativeProviderBinding & {
  handle?: CredentialHandle;
  sent: boolean;
  catalogTimedOut: boolean;
  terminal: "pending" | "done" | "failed";
};
function denied(): never {
  throw new AdmissionError("PROVIDER_REQUEST_DENIED");
}

/** Native owner only: neither this constructor nor createScope is exposed to adapters. */
export class NativeProviderRequests {
  readonly #policy: NativePolicy;
  readonly #resolver: NativeCredentialResolver;
  readonly #control: Control;
  readonly port: NativeProviderRequestPort = Object.freeze({
    withRequest: <T>(
      scope: NativeProviderScope,
      consume: (
        request: import("./provider-admission.js").NativeProviderRequest,
      ) => Promise<T>,
    ) => this.#withRequest(scope, consume),
  });
  readonly #scopes = new WeakMap<NativeProviderScope, State>();
  readonly #reads = new Map<CredentialRequest, State>();
  readonly #active = new WeakMap<NativeProviderScope, State>();
  constructor(
    policy: NativePolicy,
    resolver: NativeCredentialResolver,
    control: Control,
  ) {
    this.#policy = policy;
    this.#resolver = resolver;
    this.#control = control;
    if (
      !(policy instanceof NativePolicy) ||
      !(resolver instanceof NativeCredentialResolver)
    )
      denied();
  }

  createScope(binding: NativeProviderBinding): NativeProviderScope {
    const url = new URL(binding.admittedUrl);
    const local = ["127.0.0.1", "[::1]"].includes(url.hostname);
    const catalog = binding.requestKind === "models";
    if (
      url.href !== binding.admittedUrl ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !(
        url.protocol === "https:" ||
        (url.protocol === "http:" && local && binding.allowLocalLoopback)
      ) ||
      !["openai-completions", "openai-responses"].includes(binding.api) ||
      binding.connection.apiFamily !== binding.api ||
      (binding.requestKind !== undefined && !catalog) ||
      (!catalog && !binding.modelId) ||
      (catalog && !url.pathname.endsWith("/models")) ||
      (catalog &&
        binding.catalogTimeoutMs !== undefined &&
        (!Number.isSafeInteger(binding.catalogTimeoutMs) ||
          binding.catalogTimeoutMs < 1 ||
          binding.catalogTimeoutMs > 10_000)) ||
      !Number.isSafeInteger(binding.maxRequestBytes) ||
      binding.maxRequestBytes < 1 ||
      !Number.isSafeInteger(binding.headersTimeoutMs) ||
      binding.headersTimeoutMs < 1 ||
      binding.headersTimeoutMs > 2_147_483_647 ||
      binding.request.actionId !== binding.permit.actionId ||
      binding.request.providerConnectionId !==
        binding.connection.providerConnectionId ||
      binding.request.connectionRevision !== binding.connection.revision ||
      binding.request.endpointRef !== binding.connection.endpointRef
    )
      denied();
    const scope = Object.freeze({}) as NativeProviderScope;
    const state: State = {
      ...binding,
      args: freeze(structuredClone(binding.args)),
      sent: false,
      catalogTimedOut: false,
      terminal: "pending",
      permit: structuredClone(binding.permit),
      connection: structuredClone(binding.connection),
      request: Object.freeze({ ...binding.request }),
    };
    if (
      (catalog
        ? state.args.schema !== "splyce-models-request-v1" ||
          state.args.providerConnectionId !==
            state.connection.providerConnectionId ||
          state.args.endpointRef !== state.request.endpointRef ||
          Object.keys(state.args).sort().join() !==
            "endpointRef,providerConnectionId,schema"
        : state.args.schema !== "splyce-provider-request-v1" ||
          state.args.apiFamily !== state.api ||
          state.args.endpointRef !== state.request.endpointRef ||
          state.args.model !== state.modelId ||
          !Array.isArray(state.args.context.messages) ||
          !Array.isArray(state.args.context.tools)) ||
      actionArgumentsDigest(state.args) !== state.permit.argumentsDigest
    )
      denied();
    this.#check(state);
    this.#scopes.set(scope, state);
    return scope;
  }

  /** Native factory only: this exact frozen object also supplies the adapter input. */
  semantic(scope: NativeProviderScope): NativeProviderSemanticRequest {
    const state = this.#scopes.get(scope) ?? this.#active.get(scope);
    if (!state || state.args.schema !== "splyce-provider-request-v1") denied();
    return state.args;
  }

  /** Native owner only: bounded catalog read using the same policy and credential lease. */
  async withCatalog(scope: NativeProviderScope): Promise<unknown> {
    const state = this.#scopes.get(scope);
    if (!state || state.requestKind !== "models") denied();
    try {
      return await this.#withRequest(
        scope,
        async (request) => {
          const response = await request.fetch(state.admittedUrl, {
            method: "GET",
          });
          const json = await response.text();
          return redactJson(JSON.parse(json) as unknown, request.redact);
        },
        true,
      );
    } catch (error) {
      if (state.catalogTimedOut)
        throw new AdmissionError("MODEL_CATALOG_TIMEOUT");
      throw error;
    }
  }

  /** Native factory's existing actual-adapter onEvent bridge; never adapter-facing. */
  observe(scope: NativeProviderScope, event: NativeProviderEvent): void {
    const state = this.#active.get(scope);
    if (!state || !state.sent || state.requestKind === "models") denied();
    this.#check(state);
    if (event.type === "error") state.terminal = "failed";
    if (event.type === "done") {
      if (
        state.terminal !== "pending" ||
        !["stop", "length", "toolUse"].includes(event.reason ?? "") ||
        event.message?.stopReason !== event.reason ||
        event.message?.api !== state.api ||
        event.message?.model !== state.modelId
      ) {
        state.terminal = "failed";
        denied();
      }
      state.terminal = "done";
    }
  }

  /** Install as the genuine resolver's contextful OS-store callback. */
  async readCredentialStore(
    target: string,
    request: CredentialRequest,
  ): Promise<string | undefined> {
    const state = this.#reads.get(request);
    if (!state || target !== state.credentialTarget || !state.handle) denied();
    this.#check(state);
    const secret = await state.handle.read();
    this.#check(state);
    return secret ?? undefined;
  }

  #check(state: State): void {
    this.#policy.check(
      state.permit.toolCallId,
      state.permit.toolName,
      state.request.signal,
    );
    const current = state.currentConnection();
    if (
      actionArgumentsDigest(current) !== actionArgumentsDigest(state.connection)
    )
      denied();
  }

  async #withRequest<T>(
    scope: NativeProviderScope,
    consume: (
      request: import("./provider-admission.js").NativeProviderRequest,
    ) => Promise<T>,
    catalog = false,
  ): Promise<T> {
    const state = this.#scopes.get(scope);
    if (!state || (state.requestKind === "models") !== catalog) denied();
    this.#scopes.delete(scope);
    const { permit, request } = state;
    const signal = request.signal ?? new AbortController().signal;
    const transportController = new AbortController();
    const transportSignal = AbortSignal.any([
      signal,
      transportController.signal,
    ]);
    let lease: SecretLease | undefined;
    let cleanupResponse: (() => Promise<void>) | undefined;
    let bodySettled = false;
    let pending: Promise<unknown> | undefined;
    let transportPending: Promise<Response> | undefined;
    let catalogTimer: ReturnType<typeof setTimeout> | undefined;
    let sent = false;
    let live = true;
    this.#policy.reserve(permit.toolCallId, permit.toolName, signal);
    this.#active.set(scope, state);
    try {
      await this.#policy.prepare(
        permit.toolCallId,
        permit.toolName,
        state.args,
        state.parentToolCallId,
        signal,
      );
      this.#policy.finish(
        permit.toolCallId,
        permit.toolName,
        state.args,
        signal,
      );
      const result = await this.#policy.execute(
        permit.toolCallId,
        permit.toolName,
        state.args,
        async () => {
          try {
            this.#check(state);
            state.handle = await this.#control.open(
              {
                scopeId: permit.actionId,
                target: state.credentialTarget,
                actionId: permit.actionId,
                profileRevision: state.profileRevision,
                connectionRevision: request.connectionRevision,
              },
              signal,
            );
            this.#check(state);
            this.#reads.set(request, state);
            lease = await this.#resolver.resolve(request);
            this.#check(state);
            let value: unknown;
            let error: Error | undefined;
            try {
              await lease.use(async (apiKey) => {
                pending = (async () => {
                  const guardedFetch: typeof fetch = (input, init) => {
                    const operation = (async () => {
                      const method = init?.method;
                      const requestBody = init?.body;
                      const url =
                        typeof input === "string"
                          ? input
                          : input instanceof URL
                            ? input.href
                            : undefined;
                      if (
                        !live ||
                        sent ||
                        (state.requestKind === "models"
                          ? method !== "GET" || requestBody !== undefined
                          : typeof requestBody !== "string" ||
                            method !== "POST")
                      )
                        denied();
                      if (
                        url !== state.admittedUrl ||
                        (state.requestKind !== "models" &&
                          new TextEncoder().encode(requestBody as string)
                            .byteLength > state.maxRequestBytes)
                      )
                        denied();
                      if (state.requestKind !== "models") {
                        const body = JSON.parse(
                          requestBody as string,
                        ) as Record<string, unknown>;
                        if (
                          !body ||
                          body.model !== state.modelId ||
                          body.stream !== true
                        )
                          denied();
                      }
                      // Only the reviewed options cross the physical transport boundary.
                      const headers = new Headers({
                        accept:
                          state.requestKind === "models"
                            ? "application/json"
                            : "text/event-stream",
                        authorization: `Bearer ${apiKey}`,
                      });
                      if (state.requestKind !== "models")
                        headers.set("content-type", "application/json");
                      this.#check(state);
                      sent = true;
                      state.sent = true;
                      const headersTimer = setTimeout(
                        () => {
                          if (state.requestKind === "models")
                            state.catalogTimedOut = true;
                          transportController.abort();
                        },
                        state.requestKind === "models"
                          ? (state.catalogTimeoutMs ?? 10_000)
                          : state.headersTimeoutMs,
                      );
                      if (state.requestKind === "models")
                        catalogTimer = headersTimer;
                      let response: Response;
                      try {
                        response = await globalThis.fetch(state.admittedUrl, {
                          method:
                            state.requestKind === "models" ? "GET" : "POST",
                          body:
                            state.requestKind === "models"
                              ? null
                              : (requestBody as string),
                          headers,
                          signal: transportSignal,
                          redirect: "error",
                        });
                      } finally {
                        if (state.requestKind !== "models")
                          clearTimeout(headersTimer);
                      }
                      if (response.status >= 300 && response.status < 400) {
                        await response.body?.cancel();
                        denied();
                      }
                      const mediaType = response.headers
                        .get("content-type")
                        ?.split(";", 1)[0]
                        ?.trim()
                        .toLowerCase();
                      if (
                        mediaType !==
                          (state.requestKind === "models"
                            ? "application/json"
                            : "text/event-stream") ||
                        (state.requestKind === "models" && !response.ok)
                      ) {
                        await response.body?.cancel();
                        denied();
                      }
                      const reader = response.body?.getReader();
                      if (!reader) denied();
                      cleanupResponse = async () => {
                        await reader.cancel();
                      };
                      let responseBytes = 0;
                      const stream = new ReadableStream<Uint8Array>({
                        async pull(controller) {
                          try {
                            const next = await reader.read();
                            if (next.done) {
                              bodySettled = true;
                              if (state.requestKind === "models") {
                                if (catalogTimer) clearTimeout(catalogTimer);
                                state.terminal = "done";
                              }
                              controller.close();
                            } else {
                              responseBytes += next.value.byteLength;
                              if (
                                state.requestKind === "models" &&
                                responseBytes > 1_048_576
                              ) {
                                await reader.cancel();
                                denied();
                              }
                              controller.enqueue(next.value);
                            }
                          } catch (e) {
                            controller.error(e);
                          }
                        },
                        async cancel() {
                          bodySettled = true;
                          await reader.cancel();
                        },
                      });
                      return new Response(stream, {
                        status: response.status,
                        statusText: response.statusText,
                        headers: response.headers,
                      });
                    })();
                    transportPending ??= operation;
                    return operation;
                  };
                  try {
                    value = await consume(
                      Object.freeze({
                        apiKey,
                        fetch: guardedFetch,
                        signal: transportSignal,
                        redact: this.#resolver.redact,
                        transport: "sse",
                        maxRetries: 0,
                      }),
                    );
                  } catch (cause) {
                    error = new Error(
                      this.#resolver.redact(
                        cause instanceof Error
                          ? cause.message
                          : "provider request failed",
                      ),
                    );
                  } finally {
                    live = false;
                    transportController.abort();
                    try {
                      await transportPending;
                    } catch {
                      error ??= new Error("provider transport cleanup failed");
                    } finally {
                      if (
                        cleanupResponse &&
                        !bodySettled &&
                        state.terminal !== "done" &&
                        !error
                      )
                        error = new AdmissionError(
                          "PROVIDER_RESPONSE_NOT_CONSUMED",
                        );
                      try {
                        await cleanupResponse?.();
                      } catch {
                        error ??= new Error("provider response cleanup failed");
                      }
                    }
                  }
                })();
                await pending;
              });
            } finally {
              // A revoked lease rejects early; keep scope/redaction alive until use cleanup settles.
              await pending;
            }
            this.#check(state);
            if (error) return { isError: true, error };
            if (!sent || state.terminal !== "done") denied();
            return { isError: false, value };
          } finally {
            live = false;
            transportController.abort();
            if (catalogTimer) clearTimeout(catalogTimer);
            lease?.revoke();
            this.#reads.delete(request);
            this.#active.delete(scope);
            await state.handle?.close();
            delete state.handle;
          }
        },
        signal,
      );
      if (result.error) throw result.error;
      return result.value as T;
    } catch (error) {
      this.#active.delete(scope);
      this.#policy.discard(
        permit.toolCallId,
        signal.aborted ? "canceled" : "denied",
      );
      throw error;
    }
  }
}
