// Splyce #70: real Pi/OpenAI adapters, controlled HTTP service and native-port input.
// This suite does not qualify the real native authority, installed app or service.
import assert from "node:assert/strict";
import { inspect } from "node:util";
import test, { after, before } from "node:test";
import { runNativeOpenAIChat } from "../vendor/pi/packages/ai/dist/api/native-openai-chat.js";

const KEY = "fixture-native-key-material";
const REDACTED = "[REDACTED]";
const scope = Object.freeze({ fixtureScope: "scope-owned-by-port" });
const encoder = new TextEncoder();
let ambientFetches = 0;
let originalFetch;

before(() => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    ambientFetches += 1;
    throw new Error("unexpected ambient HTTP transport");
  };
});
after(() => {
  globalThis.fetch = originalFetch;
  assert.equal(
    ambientFetches,
    0,
    "all sends must use the native request fetch",
  );
});

const model = (api = "openai-completions") => ({
  api,
  id: "fixture-model",
  name: "Fixture model",
  provider: "openai",
  baseUrl: "https://fixture-compatible.invalid/custom/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8192,
  maxTokens: 1024,
});
const context = (text = "hello from the fixture") => ({
  messages: [{ role: "user", content: text, timestamp: 0 }],
});
const sse = (events) =>
  events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") +
  "data: [DONE]\n\n";
const response = (events) =>
  new Response(sse(events), {
    headers: { "content-type": "text/event-stream" },
  });

function chatEvents(text = "hello", id = "chat-fixture") {
  return [
    {
      id,
      object: "chat.completion.chunk",
      created: 0,
      model: "fixture-model",
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content: text },
          finish_reason: null,
        },
      ],
    },
    {
      id,
      object: "chat.completion.chunk",
      created: 0,
      model: "fixture-model",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    },
  ];
}

function responseEvents(text = "hello", id = "resp-fixture") {
  const item = {
    type: "message",
    id: "msg-fixture",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
  return [
    {
      type: "response.created",
      response: {
        id,
        model: "fixture-model",
        status: "in_progress",
        output: [],
      },
    },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...item, status: "in_progress", content: [] },
    },
    {
      type: "response.content_part.added",
      output_index: 0,
      content_index: 0,
      item_id: item.id,
      part: { type: "output_text", text: "", annotations: [] },
    },
    {
      type: "response.output_text.delta",
      output_index: 0,
      content_index: 0,
      item_id: item.id,
      delta: text,
    },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id,
        model: "fixture-model",
        status: "completed",
        output: [item],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    },
  ];
}
const success = (api, text = "hello", id) =>
  response(
    api === "openai-completions"
      ? chatEvents(text, id)
      : responseEvents(text, id),
  );
const textOf = (message) =>
  message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
const noKey = (value) =>
  assert.equal(
    inspect(value, { depth: 20 }).includes(KEY),
    false,
    "native credential must not escape",
  );

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture({
  api = "openai-completions",
  fetch,
  fields = {},
  denied,
} = {}) {
  const controller = new AbortController();
  const state = {
    active: false,
    calls: [],
    timeline: [],
    invocations: 0,
    controller,
    events: [],
  };
  const port = {
    async withRequest(actualScope, consume) {
      assert.equal(actualScope, scope);
      state.invocations += 1;
      if (denied) throw denied;
      assert.equal(state.active, false);
      state.active = true;
      state.timeline.push("port-enter");
      try {
        return await consume({
          apiKey: KEY,
          signal: controller.signal,
          transport: "sse",
          maxRetries: 0,
          redact: (text) => {
            assert.equal(
              state.active,
              true,
              "redaction must remain within consume",
            );
            return text.replaceAll(KEY, REDACTED);
          },
          fetch: async (input, init) => {
            assert.equal(
              state.active,
              true,
              "physical send cannot outlive consume",
            );
            const request = new Request(input, init);
            const body = await request.clone().text();
            state.calls.push({
              url: request.url,
              body,
              headers: request.headers,
              signal: request.signal,
            });
            state.timeline.push("fetch");
            return fetch ? fetch(request, state) : success(api);
          },
          ...fields,
        });
      } finally {
        state.timeline.push("port-release");
        state.active = false;
        controller.abort();
      }
    },
  };
  const run = (extra = {}) =>
    runNativeOpenAIChat({
      port,
      scope,
      model: model(api),
      context: context(),
      onEvent: (event) => {
        assert.equal(
          state.active,
          true,
          "observer delivery cannot outlive consume",
        );
        state.events.push(event);
      },
      ...extra,
    });
  return { state, run };
}

for (const api of ["openai-completions", "openai-responses"]) {
  test(
    `${api}: actual adapter streams through the admitted custom endpoint`,
    { timeout: 4000 },
    async () => {
      const f = fixture({ api });
      const result = await f.run();
      assert.equal(result.stopReason, "stop");
      assert.equal(textOf(result), "hello");
      assert.equal(f.state.calls.length, 1);
      assert.equal(
        f.state.calls[0].url,
        `${model(api).baseUrl}/${api === "openai-completions" ? "chat/completions" : "responses"}`,
      );
      assert.equal(
        f.state.calls[0].headers.get("authorization"),
        `Bearer ${KEY}`,
      );
      const body = JSON.parse(f.state.calls[0].body);
      assert.equal(body.model, model(api).id);
      assert.equal(body.stream, true);
      assert.ok(f.state.events.some((event) => event.type === "text_delta"));
      assert.equal(f.state.events.at(-1).type, "done");
      assert.equal(f.state.active, false);
    },
  );

  test(
    `${api}: credential text in context, events and returned metadata is redacted`,
    { timeout: 4000 },
    async () => {
      const f = fixture({
        api,
        fetch: () => success(api, `answer ${KEY}`, `response-${KEY}`),
      });
      const result = await f.run({
        context: context(`do not send ${KEY} as content`),
      });
      assert.equal(result.stopReason, "stop");
      assert.equal(f.state.calls.length, 1);
      assert.equal(
        f.state.calls[0].body.includes(KEY),
        false,
        "credential bytes are not prompt content",
      );
      noKey({ events: f.state.events, result });
      assert.ok(textOf(result).includes(REDACTED));
    },
  );

  test(
    `${api}: stream error diagnostics are sanitized before observer and result delivery`,
    { timeout: 4000 },
    async () => {
      const failure =
        api === "openai-completions"
          ? {
              error: {
                message: `provider failure ${KEY}`,
                code: "fixture_error",
              },
            }
          : {
              type: "error",
              message: `provider failure ${KEY}`,
              code: "fixture_error",
            };
      const f = fixture({ api, fetch: () => response([failure]) });
      const result = await f.run();
      assert.equal(result.stopReason, "error");
      assert.equal(f.state.calls.length, 1);
      assert.ok(result.errorMessage);
      assert.ok(f.state.events.some((event) => event.type === "error"));
      noKey({ result, events: f.state.events });
    },
  );
}

test(
  "native lease lifetime includes held response consumption and terminal observer",
  { timeout: 4000 },
  async (t) => {
    const fetched = deferred();
    let body;
    const f = fixture({
      fetch: (request) => {
        const stream = new ReadableStream({
          start(controller) {
            body = controller;
            request.signal.addEventListener(
              "abort",
              () =>
                controller.error(
                  new DOMException("fixture body aborted", "AbortError"),
                ),
              { once: true },
            );
            fetched.resolve();
          },
        });
        return new Response(stream, {
          headers: { "content-type": "text/event-stream" },
        });
      },
    });
    t.after(() => f.state.controller.abort());
    let settled = false;
    const pending = f.run().finally(() => {
      settled = true;
    });
    await Promise.race([
      fetched.promise,
      pending.then(() =>
        assert.fail("consumer settled before the response was fetched"),
      ),
    ]);
    assert.equal(f.state.active, true);
    assert.equal(settled, false);
    assert.equal(f.state.timeline.includes("port-release"), false);
    body.enqueue(encoder.encode(sse(chatEvents("held response finished"))));
    body.close();
    const result = await pending;
    assert.equal(textOf(result), "held response finished");
    assert.equal(f.state.events.at(-1).type, "done");
    assert.equal(f.state.timeline.at(-1), "port-release");
  },
);

test(
  "nested tool-call argument keys and values are sanitized in events and return value",
  { timeout: 4000 },
  async () => {
    const chunks = [
      {
        id: "chat-fixture",
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call-fixture",
                  type: "function",
                  function: {
                    name: "fixture_tool",
                    arguments: JSON.stringify({ [KEY]: [KEY] }),
                  },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      },
    ];
    const f = fixture({ fetch: () => response(chunks) });
    const result = await f.run();
    assert.equal(result.stopReason, "toolUse");
    const tool = result.content.find((part) => part.type === "toolCall");
    assert.ok(tool);
    assert.deepEqual(tool.arguments, { [REDACTED]: [REDACTED] });
    noKey({ result, events: f.state.events });
  },
);

test(
  "a credential split across SSE text deltas cannot be reconstructed from delivered deltas",
  { timeout: 4000 },
  async () => {
    const half = Math.floor(KEY.length / 2);
    const chunks = [
      {
        id: "chat-fixture",
        choices: [
          {
            index: 0,
            delta: { content: KEY.slice(0, half) },
            finish_reason: null,
          },
        ],
      },
      {
        id: "chat-fixture",
        choices: [
          {
            index: 0,
            delta: { content: KEY.slice(half) },
            finish_reason: null,
          },
        ],
      },
      {
        id: "chat-fixture",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      },
    ];
    const f = fixture({ fetch: () => response(chunks) });
    const result = await f.run();
    const deliveredText = f.state.events
      .filter((event) => event.type === "text_delta")
      .map((event) => event.delta)
      .join("");
    assert.equal(
      deliveredText.includes(KEY),
      false,
      "redaction must protect a streamed transcript, not only complete strings",
    );
    noKey({ result, events: f.state.events });
  },
);

test(
  "native denial sends nothing and does not expose the dependency error",
  { timeout: 4000 },
  async () => {
    const f = fixture({ denied: new Error(`native denial ${KEY}`) });
    await assert.rejects(f.run(), (error) => {
      noKey(error);
      return true;
    });
    assert.equal(f.state.calls.length, 0);
    assert.equal(f.state.events.length, 0);
  },
);

for (const [name, fields] of [
  ["empty credential", { apiKey: "" }],
  ["blank credential", { apiKey: "   " }],
  ["WebSocket transport", { transport: "websocket" }],
  ["nonzero native retry policy", { maxRetries: 1 }],
]) {
  test(
    `${name} is refused without a fallback physical send`,
    { timeout: 4000 },
    async () => {
      const f = fixture({ fields });
      await assert.rejects(f.run(), (error) => {
        noKey(error);
        return true;
      });
      assert.equal(f.state.calls.length, 0);
      assert.equal(f.state.events.length, 0);
    },
  );
}

test(
  "an unsupported API cannot fall back to an OpenAI adapter",
  { timeout: 4000 },
  async () => {
    const f = fixture({ api: "anthropic-messages" });
    await assert.rejects(f.run(), (error) => {
      noKey(error);
      return true;
    });
    assert.equal(f.state.calls.length, 0);
    assert.equal(f.state.events.length, 0);
  },
);

for (const status of [429, 500]) {
  test(
    `actual SDK HTTP ${status} response is not retried`,
    { timeout: 4000 },
    async () => {
      const f = fixture({
        fetch: () =>
          new Response(
            JSON.stringify({
              error: { message: `failure ${KEY}`, type: "fixture_error" },
            }),
            { status, headers: { "content-type": "application/json" } },
          ),
      });
      const result = await f.run();
      assert.equal(result.stopReason, "error");
      assert.equal(f.state.calls.length, 1);
      noKey({ result, events: f.state.events });
    },
  );
}

test(
  "native abort stops the actual SDK body before releasing consume",
  { timeout: 4000 },
  async (t) => {
    const fetched = deferred();
    const f = fixture({
      fetch: (request, state) => {
        const stream = new ReadableStream({
          start(controller) {
            request.signal.addEventListener(
              "abort",
              () => {
                state.timeline.push("body-abort");
                controller.error(
                  new DOMException("fixture body aborted", "AbortError"),
                );
              },
              { once: true },
            );
            fetched.resolve();
          },
        });
        return new Response(stream, {
          headers: { "content-type": "text/event-stream" },
        });
      },
    });
    t.after(() => f.state.controller.abort());
    const pending = f.run();
    await Promise.race([
      fetched.promise,
      pending.then(() =>
        assert.fail("consumer settled before the response was fetched"),
      ),
    ]);
    f.state.controller.abort();
    const result = await pending;
    assert.equal(result.stopReason, "aborted");
    assert.ok(f.state.timeline.indexOf("body-abort") >= 0);
    assert.ok(
      f.state.timeline.indexOf("body-abort") <
        f.state.timeline.indexOf("port-release"),
    );
    assert.equal(f.state.active, false);
  },
);

test(
  "observer failure aborts and settles the SDK before the native port releases",
  { timeout: 4000 },
  async () => {
    const f = fixture({
      fetch: (request, state) => {
        const stream = new ReadableStream({
          start(controller) {
            request.signal.addEventListener(
              "abort",
              () => {
                state.timeline.push("body-abort");
                controller.error(
                  new DOMException("fixture body aborted", "AbortError"),
                );
              },
              { once: true },
            );
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify(chatEvents("first delta")[0])}\n\n`,
              ),
            );
          },
        });
        return new Response(stream, {
          headers: { "content-type": "text/event-stream" },
        });
      },
    });
    await assert.rejects(
      f.run({
        onEvent: async (event) => {
          if (event.type === "text_delta")
            throw new Error(`observer failure ${KEY}`);
        },
      }),
      (error) => {
        noKey(error);
        return true;
      },
    );
    assert.ok(f.state.timeline.indexOf("body-abort") >= 0);
    assert.ok(
      f.state.timeline.indexOf("body-abort") <
        f.state.timeline.indexOf("port-release"),
    );
  },
);

test(
  "observer mutation cannot alter the raw SDK message or the returned result",
  { timeout: 4000 },
  async () => {
    const f = fixture();
    const result = await f.run({
      onEvent: (event) => {
        if (
          event.type === "text_delta" &&
          event.partial?.content[0]?.type === "text"
        )
          event.partial.content[0].text = "observer changed this";
        if (event.type === "done") event.message.content.length = 0;
      },
    });
    assert.equal(result.stopReason, "stop");
    assert.equal(textOf(result), "hello");
  },
);

for (const api of ["openai-completions", "openai-responses"]) {
  test(
    `${api}: SDK debug logging cannot expose native response diagnostics`,
    { timeout: 4000 },
    async () => {
      const captured = [];
      const methods = ["debug", "info", "log", "warn", "error"];
      const saved = Object.fromEntries(
        methods.map((name) => [name, console[name]]),
      );
      const previousLogLevel = process.env.OPENAI_LOG;
      const f = fixture({
        api,
        fetch: () =>
          new Response(`provider diagnostic ${KEY}`, {
            status: 500,
            headers: {
              "content-type": "text/plain",
              "x-provider-diagnostic": KEY,
            },
          }),
      });
      let result;
      try {
        process.env.OPENAI_LOG = "debug";
        for (const name of methods)
          console[name] = (...values) =>
            captured.push(inspect(values, { depth: 20 }));
        result = await f.run();
      } finally {
        for (const name of methods) console[name] = saved[name];
        if (previousLogLevel === undefined) delete process.env.OPENAI_LOG;
        else process.env.OPENAI_LOG = previousLogLevel;
      }
      assert.equal(result.stopReason, "error");
      assert.ok(result.errorMessage);
      assert.equal(f.state.invocations, 1);
      assert.equal(f.state.calls.length, 1);
      assert.equal(f.state.active, false);
      assert.equal(f.state.timeline.at(-1), "port-release");
      assert.ok(f.state.events.some((event) => event.type === "error"));
      noKey({ captured, result, events: f.state.events });
    },
  );
}

for (const api of ["openai-completions", "openai-responses"]) {
  for (const mode of ["observer-failure", "native-abort"]) {
    // Splyce #70: producer completion does not imply async body cancellation settled.
    test(
      `${api}: ${mode} keeps consume active until asynchronous body cancellation settles`,
      { timeout: 4000 },
      async (t) => {
        const fetched = deferred();
        const cancelStarted = deferred();
        const cancelGate = deferred();
        const f = fixture({
          api,
          fetch: (_request, state) =>
            new Response(
              new ReadableStream({
                start(controller) {
                  const events =
                    api === "openai-completions"
                      ? chatEvents("first delta").slice(0, 1)
                      : responseEvents("first delta").slice(0, 4);
                  controller.enqueue(
                    encoder.encode(
                      events
                        .map((event) => `data: ${JSON.stringify(event)}\n\n`)
                        .join(""),
                    ),
                  );
                  fetched.resolve();
                },
                async cancel() {
                  state.timeline.push("cancel-begin");
                  cancelStarted.resolve();
                  await cancelGate.promise;
                  state.timeline.push("cancel-settled");
                },
              }),
              { headers: { "content-type": "text/event-stream" } },
            ),
        });
        let settled = false;
        let result;
        let failure;
        const pending = f
          .run({
            onEvent: (event) => {
              assert.equal(f.state.active, true);
              f.state.events.push(event);
              if (mode === "observer-failure" && event.type === "text_delta") {
                f.state.timeline.push("observer-failure");
                throw new Error(`observer failure ${KEY}`);
              }
            },
          })
          .then(
            (value) => {
              result = value;
              settled = true;
            },
            (error) => {
              failure = error;
              settled = true;
            },
          );
        t.after(async () => {
          cancelGate.resolve();
          f.state.controller.abort();
          await pending;
        });
        if (mode === "native-abort") {
          await fetched.promise;
          f.state.timeline.push("native-abort");
          f.state.controller.abort();
        }
        await Promise.race([
          cancelStarted.promise,
          pending.then(() =>
            assert.fail("consumer settled before body cancellation started"),
          ),
        ]);
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(settled, false, "body cancellation is still gated");
        assert.equal(f.state.active, true);
        assert.equal(f.state.timeline.includes("port-release"), false);
        cancelGate.resolve();
        await pending;
        assert.equal(f.state.calls.length, 1);
        assert.ok(f.state.timeline.indexOf("cancel-settled") >= 0);
        assert.ok(
          f.state.timeline.indexOf("cancel-settled") <
            f.state.timeline.indexOf("port-release"),
        );
        assert.equal(f.state.active, false);
        if (mode === "observer-failure") assert.ok(failure instanceof Error);
        else assert.equal(result.stopReason, "aborted");
        noKey({ result, failure, events: f.state.events });
      },
    );
  }
}

function liveContentChunks(api, kind, first, remainder, complete) {
  if (api === "openai-completions") {
    const delta = (text, initial) =>
      kind === "text"
        ? { content: text }
        : kind === "thinking"
          ? { reasoning_content: text }
          : {
              tool_calls: [
                {
                  index: 0,
                  ...(initial ? { id: "call-fixture", type: "function" } : {}),
                  function: {
                    ...(initial ? { name: "fixture_tool" } : {}),
                    arguments: initial ? `{"message":"${text}` : `${text}"}`,
                  },
                },
              ],
            };
    const chunk = (text, initial) => ({
      id: "chat-fixture",
      choices: [{ index: 0, delta: delta(text, initial), finish_reason: null }],
    });
    return [
      [chunk(first, true)],
      [
        chunk(remainder, false),
        {
          id: "chat-fixture",
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: kind === "toolCall" ? "tool_calls" : "stop",
            },
          ],
        },
      ],
    ];
  }
  if (kind === "text") {
    return [
      responseEvents(first).slice(0, 4),
      [
        { ...responseEvents(remainder)[3] },
        ...responseEvents(complete).slice(4),
      ],
    ];
  }
  const item =
    kind === "thinking"
      ? { type: "reasoning", id: "rs_fixture", summary: [] }
      : {
          type: "function_call",
          id: "fc_fixture",
          call_id: "call-fixture",
          name: "fixture_tool",
          arguments: "",
        };
  const delta = (text) => ({
    type:
      kind === "thinking"
        ? "response.reasoning_summary_text.delta"
        : "response.function_call_arguments.delta",
    item_id: item.id,
    output_index: 0,
    delta: text,
  });
  const done =
    kind === "thinking"
      ? { ...item, summary: [{ type: "summary_text", text: complete }] }
      : { ...item, arguments: JSON.stringify({ message: complete }) };
  return [
    [
      responseEvents()[0],
      { type: "response.output_item.added", output_index: 0, item },
      delta(kind === "thinking" ? first : `{"message":"${first}`),
    ],
    [
      delta(kind === "thinking" ? remainder : `${remainder}"}`),
      { type: "response.output_item.done", output_index: 0, item: done },
      {
        ...responseEvents()[5],
        response: { ...responseEvents()[5].response, output: [done] },
      },
    ],
  ];
}

for (const api of ["openai-completions", "openai-responses"]) {
  for (const kind of ["text", "thinking", "toolCall"]) {
    // Splyce #70: partial snapshots must not bypass split-delta credential protection.
    test(
      `${api}: live ${kind} partial snapshots withhold a split credential prefix`,
      { timeout: 4000 },
      async (t) => {
        const key = "sk-live-ATTACK-synthetic-only-canary";
        const prefix = key.slice(0, 12);
        const complete = `hi ${key} public suffix`;
        const chunks = liveContentChunks(
          api,
          kind,
          `hi ${prefix}`,
          `${key.slice(12)} public suffix`,
          complete,
        );
        const advance = deferred();
        let firstSnapshot;
        let f;
        f = fixture({
          api,
          fields: {
            apiKey: key,
            redact: (text) => {
              assert.equal(f.state.active, true);
              return text.replaceAll(key, REDACTED);
            },
          },
          fetch: (request) =>
            new Response(
              new ReadableStream({
                async start(controller) {
                  request.signal.addEventListener(
                    "abort",
                    () => advance.resolve(),
                    { once: true },
                  );
                  const encode = (events) =>
                    encoder.encode(
                      events
                        .map((event) => `data: ${JSON.stringify(event)}\n\n`)
                        .join(""),
                    );
                  controller.enqueue(encode(chunks[0]));
                  await advance.promise;
                  controller.enqueue(encode(chunks[1]));
                  controller.close();
                },
              }),
              { headers: { "content-type": "text/event-stream" } },
            ),
        });
        t.after(() => {
          advance.resolve();
          f.state.controller.abort();
        });
        const result = await f.run({
          onEvent: (event) => {
            assert.equal(f.state.active, true);
            f.state.events.push(event);
            if (event.partial) {
              const block = event.partial.content.find(
                (part) => part.type === kind,
              );
              const content =
                kind === "text"
                  ? block?.text
                  : kind === "thinking"
                    ? block?.thinking
                    : block?.arguments.message;
              if (content?.startsWith("hi ") && firstSnapshot === undefined) {
                firstSnapshot = inspect(block, { depth: 20 });
                advance.resolve();
              }
            }
          },
        });
        assert.ok(
          firstSnapshot,
          "a pre-completion content snapshot was observed",
        );
        assert.equal(
          firstSnapshot.includes(prefix),
          false,
          "live partial content must not expose the pending credential prefix",
        );
        for (const event of f.state.events) {
          if (!event.partial) continue;
          assert.equal(event.partial.api, api);
          assert.equal(event.partial.model, model(api).id);
          assert.equal(event.partial.role, "assistant");
          assert.equal(
            inspect(event.partial.content, { depth: 20 }).includes(prefix),
            false,
          );
        }
        assert.equal(f.state.calls.length, 1);
        assert.equal(
          result.stopReason,
          kind === "toolCall" ? "toolUse" : "stop",
        );
        const block = result.content.find((part) => part.type === kind);
        const actual =
          kind === "text"
            ? block.text
            : kind === "thinking"
              ? block.thinking
              : block.arguments.message;
        assert.equal(actual, `hi ${REDACTED} public suffix`);
        const deltaType =
          kind === "toolCall" ? "toolcall_delta" : `${kind}_delta`;
        const delivered = f.state.events
          .filter((event) => event.type === deltaType)
          .map((event) => event.delta)
          .join("");
        assert.equal(
          kind === "toolCall" ? JSON.parse(delivered).message : delivered,
          `hi ${REDACTED} public suffix`,
        );
        assert.equal(
          inspect({ result, events: f.state.events }).includes(key),
          false,
        );
      },
    );
  }
}

for (const api of ["openai-completions", "openai-responses"]) {
  test(`${api}: caller model auth headers are refused before native admission`, async () => {
    for (const header of [
      "Authorization",
      "Proxy-Authorization",
      "X-Api-Key",
      "Api-Key",
      "X-Goog-Api-Key",
      "Cookie",
    ]) {
      const f = fixture({ api });
      await assert.rejects(
        f.run({
          model: {
            ...model(api),
            headers: { [header]: "caller-auth-fixture" },
          },
        }),
        (error) => {
          noKey(error);
          return true;
        },
      );
      assert.equal(f.state.invocations, 0);
      assert.equal(f.state.calls.length, 0);
      assert.equal(f.state.events.length, 0);
    }
  });

  test(`${api}: ambient organization and project do not reach native request headers`, async () => {
    const previousOrg = process.env.OPENAI_ORG_ID;
    const previousProject = process.env.OPENAI_PROJECT_ID;
    const f = fixture({ api });
    let result;
    try {
      process.env.OPENAI_ORG_ID = "fixture-ambient-org";
      process.env.OPENAI_PROJECT_ID = "fixture-ambient-project";
      result = await f.run();
    } finally {
      if (previousOrg === undefined) delete process.env.OPENAI_ORG_ID;
      else process.env.OPENAI_ORG_ID = previousOrg;
      if (previousProject === undefined) delete process.env.OPENAI_PROJECT_ID;
      else process.env.OPENAI_PROJECT_ID = previousProject;
    }
    assert.equal(result.stopReason, "stop");
    assert.equal(f.state.calls.length, 1);
    assert.equal(f.state.calls[0].headers.has("openai-organization"), false);
    assert.equal(f.state.calls[0].headers.has("openai-project"), false);
  });

  test(`${api}: a native redactor returning the raw credential is refused before sending`, async () => {
    const f = fixture({ api, fields: { redact: (text) => text } });
    await assert.rejects(f.run(), (error) => {
      noKey(error);
      return true;
    });
    assert.equal(f.state.invocations, 1);
    assert.equal(f.state.calls.length, 0);
    assert.equal(f.state.events.length, 0);
  });

  test(`${api}: failed tool calls discard pending credential-prefix deltas`, async () => {
    const prefix = KEY.slice(0, 12);
    const chunks = liveContentChunks(
      api,
      "toolCall",
      prefix,
      KEY.slice(12),
      KEY,
    );
    const failure =
      api === "openai-completions"
        ? {
            error: {
              message: "fixture provider failure",
              code: "fixture_error",
            },
          }
        : {
            type: "error",
            message: "fixture provider failure",
            code: "fixture_error",
          };
    const f = fixture({ api, fetch: () => response([...chunks[0], failure]) });
    const result = await f.run();
    assert.equal(result.stopReason, "error");
    assert.equal(
      result.content.some((part) => part.type === "toolCall"),
      false,
    );
    assert.equal(f.state.events.at(-1).type, "error");
    assert.ok(f.state.events.some((event) => event.type === "toolcall_delta"));
    assert.equal(
      f.state.events
        .filter((event) => event.type === "toolcall_delta")
        .map((event) => event.delta)
        .join("")
        .includes(prefix),
      false,
    );
    noKey({ result, events: f.state.events });
  });

  test(`${api}: insecure external or credential-bearing base URLs are refused before admission`, async () => {
    for (const baseUrl of [
      "http://fixture-compatible.invalid/v1",
      "https://user:fixture-password@fixture-compatible.invalid/v1",
      "ftp://localhost/v1",
    ]) {
      const f = fixture({ api });
      await assert.rejects(
        f.run({ model: { ...model(api), baseUrl } }),
        (error) => {
          noKey(error);
          assert.equal(inspect(error).includes("fixture-password"), false);
          return true;
        },
      );
      assert.equal(f.state.invocations, 0);
      assert.equal(f.state.calls.length, 0);
    }
  });

  test(`${api}: loopback HTTP retains native authorization and public model headers`, async () => {
    for (const baseUrl of [
      "http://localhost:1234/v1",
      "http://127.0.0.1:1234/v1",
      "http://[::1]:1234/v1",
    ]) {
      const f = fixture({ api });
      const result = await f.run({
        model: {
          ...model(api),
          baseUrl,
          headers: { "X-Public-Fixture": "public-value" },
        },
      });
      assert.equal(result.stopReason, "stop");
      assert.equal(f.state.calls.length, 1);
      assert.ok(f.state.calls[0].url.startsWith(baseUrl));
      assert.equal(
        f.state.calls[0].headers.get("authorization"),
        `Bearer ${KEY}`,
      );
      assert.equal(
        f.state.calls[0].headers.get("x-public-fixture"),
        "public-value",
      );
    }
  });

  test(`${api}: native physical requests force manual redirects while preserving the body`, async () => {
    let physicalRequest;
    const f = fixture({
      api,
      fetch: (request) => {
        physicalRequest = request;
        return success(api);
      },
    });
    const result = await f.run();
    assert.equal(result.stopReason, "stop");
    assert.equal(f.state.calls.length, 1);
    assert.equal(physicalRequest.redirect, "manual");
    assert.equal(physicalRequest.method, "POST");
    const body = JSON.parse(f.state.calls[0].body);
    assert.equal(body.model, model(api).id);
    assert.equal(body.stream, true);
    assert.equal(physicalRequest.headers.get("authorization"), `Bearer ${KEY}`);
  });
}

function publicKeyAndEndedBlockEvents(api, kind) {
  if (api === "openai-completions") {
    const chunks =
      kind === "keys"
        ? [
            {
              tool_calls: [
                {
                  index: 0,
                  id: "call-fixture",
                  type: "function",
                  function: {
                    name: "fixture_tool",
                    arguments: '{"conf":"public"}',
                  },
                },
              ],
            },
          ]
        : [{ content: "half" }, { reasoning_content: "half" }];
    return [...chunks, {}].map((delta, index) => ({
      id: "chat-fixture",
      choices: [
        {
          index: 0,
          delta,
          finish_reason:
            index === chunks.length
              ? kind === "keys"
                ? "tool_calls"
                : "stop"
              : null,
        },
      ],
    }));
  }
  const items =
    kind === "keys"
      ? [
          {
            type: "function_call",
            id: "fc_fixture",
            call_id: "call-fixture",
            name: "fixture_tool",
            arguments: '{"conf":"public"}',
          },
        ]
      : [
          {
            type: "message",
            id: "msg-fixture",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: "half", annotations: [] }],
          },
          {
            type: "reasoning",
            id: "rs_fixture",
            summary: [{ type: "summary_text", text: "half" }],
          },
        ];
  const events = [responseEvents()[0]];
  for (const [output_index, item] of items.entries()) {
    events.push({
      type: "response.output_item.added",
      output_index,
      item: { ...item, content: [], summary: [] },
    });
    if (item.type === "message")
      events.push({
        type: "response.output_text.delta",
        output_index,
        item_id: item.id,
        delta: "half",
      });
    if (item.type === "reasoning")
      events.push({
        type: "response.reasoning_summary_text.delta",
        output_index,
        item_id: item.id,
        delta: "half",
      });
    events.push({ type: "response.output_item.done", output_index, item });
  }
  events.push({
    ...responseEvents()[5],
    response: { ...responseEvents()[5].response, output: items },
  });
  return events;
}

for (const api of ["openai-completions", "openai-responses"]) {
  test(`${api}: live tool-argument object keys retain legitimate credential-prefix suffixes`, async () => {
    const f = fixture({
      api,
      fetch: () => response(publicKeyAndEndedBlockEvents(api, "keys")),
    });
    const result = await f.run();
    assert.equal(result.stopReason, "toolUse");
    assert.deepEqual(
      result.content.find((part) => part.type === "toolCall").arguments,
      { conf: "public" },
    );
    const snapshots = f.state.events
      .filter((event) => event.partial)
      .flatMap((event) =>
        event.partial.content.filter((part) => part.type === "toolCall"),
      )
      .filter((part) => Object.values(part.arguments).includes("public"));
    assert.ok(snapshots.length > 0);
    for (const snapshot of snapshots)
      assert.deepEqual(snapshot.arguments, { conf: "public" });
  });

  test(`${api}: completed text and thinking blocks retain legitimate credential-prefix suffixes`, async () => {
    const f = fixture({
      api,
      fetch: () => response(publicKeyAndEndedBlockEvents(api, "ended")),
    });
    const result = await f.run();
    assert.equal(result.stopReason, "stop");
    const ended = new Set();
    for (const event of f.state.events) {
      if (event.type === "text_end" || event.type === "thinking_end") {
        assert.equal(event.content, "half");
        ended.add(event.contentIndex);
      }
      if (!event.partial) continue;
      for (const index of ended) {
        const block = event.partial.content[index];
        assert.equal(
          block.type === "text" ? block.text : block.thinking,
          "half",
        );
      }
    }
    assert.equal(ended.size, 2);
    assert.equal(textOf(result), "half");
    assert.equal(
      result.content.find((part) => part.type === "thinking").thinking,
      "half",
    );
    for (const type of ["text_delta", "thinking_delta"]) {
      assert.equal(
        f.state.events
          .filter((event) => event.type === type)
          .map((event) => event.delta)
          .join(""),
        "half",
      );
    }
  });
}
