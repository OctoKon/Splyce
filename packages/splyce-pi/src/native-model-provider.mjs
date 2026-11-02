import { isDeepStrictEqual } from "node:util";
import { NativeProviderRequests } from "../dist/native-provider.js";
import { NativeControl } from "./native-control.mjs";
import { runNativeOpenAIChat } from "../../../vendor/pi/packages/ai/dist/api/native-openai-chat.js";
import { lazyStream } from "../../../vendor/pi/packages/ai/dist/api/lazy.js";
import { AssistantMessageEventStream } from "../../../vendor/pi/packages/ai/dist/utils/event-stream.js";

const failure = () => new Error("Native OpenAI request failed");
const check = (assertCurrent, signal) => {
  assertCurrent();
  if (signal?.aborted) throw failure();
};

export function createNativeModelProvider({
  model,
  credentialRef,
  control,
  requests,
  admit,
  assertCurrent,
}) {
  if (
    !(control instanceof NativeControl) ||
    !(requests instanceof NativeProviderRequests) ||
    typeof admit !== "function" ||
    typeof assertCurrent !== "function"
  )
    throw failure();
  const saved = structuredClone(model);
  const authCheck = async ({ signal }) => {
    try {
      check(assertCurrent, signal);
      const status = await control.credentialStatus(
        { target: credentialRef },
        signal,
      );
      check(assertCurrent, signal);
      return status.present
        ? { type: "api_key", source: "Windows Credential Manager" }
        : undefined;
    } catch {
      throw failure();
    }
  };
  const stream = (selected, context, options = {}) => {
    let input;
    try {
      if (options === null || typeof options !== "object") throw failure();
      const prototype = Object.getPrototypeOf(options);
      if (
        (prototype !== null && prototype !== Object.prototype) ||
        Reflect.ownKeys(options).some((key) => key !== "signal")
      )
        throw failure();
      const descriptor = Object.getOwnPropertyDescriptor(options, "signal");
      if (descriptor && !Object.hasOwn(descriptor, "value")) throw failure();
      const signal = descriptor?.value;
      if (signal !== undefined && !(signal instanceof AbortSignal))
        throw failure();
      input = {
        model: structuredClone(selected),
        context: structuredClone(context),
        options: {},
        signal,
      };
    } catch {
      input = undefined;
    }
    return lazyStream(saved, async () => {
      if (!input) throw failure();
      check(assertCurrent, input.signal);
      if (!isDeepStrictEqual(input.model, saved)) throw failure();
      const scope = await admit(input);
      check(assertCurrent, input.signal);
      const semantic = requests.semantic(scope);
      const expectedContext = {
        ...input.context,
        tools: input.context.tools ?? [],
      };
      if (
        semantic.model !== saved.id ||
        semantic.apiFamily !== saved.api ||
        !isDeepStrictEqual(semantic.options, { model: saved }) ||
        !isDeepStrictEqual(semantic.context, expectedContext)
      )
        throw failure();
      const output = new AssistantMessageEventStream();
      void (async () => {
        try {
          let terminal;
          const result = await runNativeOpenAIChat({
            port: {
              withRequest: (scope, consume) =>
                requests.port.withRequest(scope, (request) =>
                  consume({
                    ...request,
                    fetch: async (...args) =>
                      limitResponse(await request.fetch(...args)),
                  }),
                ),
            },
            scope,
            model: semantic.options.model,
            context: semantic.context,
            onEvent(event) {
              requests.observe(scope, event);
              if (event.type === "done" || event.type === "error")
                terminal = event;
              else output.push(event);
            },
          });
          check(assertCurrent, input.signal);
          if (
            !terminal ||
            terminal.type !== "done" ||
            result.stopReason !== terminal.reason
          )
            throw failure();
          output.push({ ...terminal, message: result });
          output.end(result);
        } catch {
          const error = {
            role: "assistant",
            content: [],
            api: saved.api,
            provider: saved.provider,
            model: saved.id,
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                total: 0,
              },
            },
            stopReason: "error",
            errorMessage: failure().message,
            timestamp: Date.now(),
          };
          output.push({ type: "error", reason: "error", error });
          output.end(error);
        }
      })();
      return output;
    });
  };
  return {
    id: saved.provider,
    name: saved.provider,
    auth: {
      apiKey: {
        name: "Windows Credential Manager",
        check: authCheck,
        resolve: async () => undefined,
      },
    },
    getModels: () => [structuredClone(saved)],
    stream,
    streamSimple: stream,
  };
}
const MAX_EVENT_BYTES = 1048576;

async function limitResponse(response) {
  if (!response.body || response.body.locked) throw failure();
  const reader = response.body.getReader();
  if (!response.ok) {
    try {
      await reader.cancel();
    } finally {
      reader.releaseLock();
    }
    throw failure();
  }
  let size = 0,
    lineHasBytes = false,
    pendingCR = false,
    released = false;
  const release = () => {
    if (!released) {
      released = true;
      reader.releaseLock();
    }
  };
  const cancel = async (reason) => {
    try {
      await reader.cancel(reason);
    } finally {
      release();
    }
  };
  const newline = () => {
    if (!lineHasBytes) size = 0;
    lineHasBytes = false;
  };
  const body = new ReadableStream({
    async pull(controller) {
      try {
        const { value, done } = await reader.read();
        if (done) {
          release();
          controller.close();
          return;
        }
        if (!(value instanceof Uint8Array)) throw failure();
        for (const byte of value) {
          if (pendingCR && byte !== 10) {
            newline();
            pendingCR = false;
          }
          size++;
          if (size > MAX_EVENT_BYTES) throw failure();
          if (pendingCR) {
            newline();
            pendingCR = false;
          } else if (byte === 13) pendingCR = true;
          else if (byte === 10) newline();
          else lineHasBytes = true;
        }
        controller.enqueue(value);
      } catch {
        try {
          await cancel();
        } catch {
          /* Failure remains closed. */
        }
        controller.error(failure());
      }
    },
    async cancel(reason) {
      await cancel(reason);
    },
  });
  const bounded = new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
  return new Proxy(bounded, {
    get(target, property) {
      if (
        property === "url" ||
        property === "redirected" ||
        property === "type"
      )
        return response[property];
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
