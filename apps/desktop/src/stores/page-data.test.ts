import { afterEach, beforeEach, expect, it, vi } from "vitest";

const ipc = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: ipc.invoke,
  Channel: class {},
}));

import { listSessions } from "./sessions";
import { listMemory, searchMemory } from "./memory-view";
import { readProfiles } from "./profiles";
import { readUsage } from "./usage";

beforeEach(() => {
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    configurable: true,
    value: {},
  });
  ipc.invoke.mockReset();
});
afterEach(() => Reflect.deleteProperty(window, "__TAURI_INTERNALS__"));

it("sends each read through the setup frame and returns populated or empty data", async () => {
  const session = {
    sessionId: "session_1",
    branchAnchorId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    state: "idle",
  };
  const entry = {
    observationId: "obs_1",
    sessionId: "session_1",
    createdAt: "2026-01-01T00:00:00.000Z",
    sourceCount: 1,
  };
  const usage = {
    semantics: "unavailable",
    inputTokens: null,
    outputTokens: null,
    costUsd: null,
    sessionCount: 1,
    runCount: 0,
  };
  ipc.invoke
    .mockResolvedValueOnce({ sessions: [session], truncated: false })
    .mockResolvedValueOnce({ entries: [], truncated: false })
    .mockResolvedValueOnce({ entries: [entry], truncated: false })
    .mockResolvedValueOnce(usage)
    .mockResolvedValueOnce({
      configRevision: "cfg_1",
      selectedProfileId: null,
      profiles: [],
    });
  expect(await listSessions("ws_1", "req_1")).toEqual({
    sessions: [session],
    truncated: false,
  });
  expect(await listMemory("ws_1", "req_2")).toEqual({
    entries: [],
    truncated: false,
  });
  expect(await searchMemory("ws_1", "hello", "req_3")).toEqual({
    entries: [entry],
    truncated: false,
  });
  expect(await readUsage("ws_1", "req_4")).toEqual(usage);
  expect(await readProfiles("ws_1", "req_5")).toEqual({
    profiles: [],
    selection: null,
  });
  for (const [i, [op, payload]] of (
    [
      ["sessions.list", { requestId: "req_1", workspaceId: "ws_1" }],
      ["memory.list", { requestId: "req_2", workspaceId: "ws_1" }],
      [
        "memory.search",
        { requestId: "req_3", workspaceId: "ws_1", query: "hello" },
      ],
      ["usage.read", { requestId: "req_4", workspaceId: "ws_1" }],
      ["setup.read", { requestId: "req_5", workspaceId: "ws_1" }],
    ] as const
  ).entries()) {
    expect(ipc.invoke.mock.calls[i]).toEqual([
      "send",
      {
        op,
        payload: {
          frame: "setup",
          command: op,
          requestId: payload.requestId,
          payload,
        },
      },
    ]);
  }
});

it("rejects malformed and private fields instead of returning them", async () => {
  ipc.invoke.mockResolvedValueOnce({
    sessions: [],
    truncated: false,
    path: "private",
  });
  await expect(listSessions("ws_1", "req_1")).rejects.toMatchObject({
    code: "PAGE_READ_INVALID",
  });
  ipc.invoke.mockResolvedValueOnce({ entries: "bad", truncated: false });
  await expect(listMemory("ws_1", "req_2")).rejects.toMatchObject({
    code: "PAGE_READ_INVALID",
  });
  ipc.invoke.mockResolvedValueOnce({
    configRevision: "cfg_1",
    selectedProfileId: null,
    profiles: [],
    secret: "private",
  });
  await expect(readProfiles("ws_1", "req_3")).rejects.toThrow();
});

it("rejects invalid requests before transport and propagates unavailable", async () => {
  await expect(listSessions("", "req_1")).rejects.toMatchObject({
    code: "PAGE_READ_INVALID",
  });
  expect(ipc.invoke).not.toHaveBeenCalled();
  ipc.invoke.mockRejectedValueOnce({
    code: "PAGE_READ_UNAVAILABLE",
    message: "private path",
  });
  await expect(readUsage("ws_1", "req_2")).rejects.toMatchObject({
    code: "PAGE_READ_UNAVAILABLE",
    message: "Page data unavailable",
  });
  ipc.invoke.mockRejectedValueOnce({
    code: "PAGE_READ_INVALID",
    message: "private",
  });
  await expect(readUsage("ws_1", "req_3")).rejects.toMatchObject({
    code: "PAGE_READ_INVALID",
    message: "Page data unavailable",
  });
});
