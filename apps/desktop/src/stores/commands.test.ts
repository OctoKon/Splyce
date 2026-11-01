import { describe, expect, it, vi } from "vitest";
import { shortcutPanel } from "./shell";
import {
  CATALOG,
  createCommandRegistry,
  filterCommands,
  findConflicts,
  normalizeShortcut,
  type CommandDef,
} from "./commands";

const key = (init: KeyboardEventInit) =>
  new KeyboardEvent("keydown", { cancelable: true, ...init });

describe("filter and ranking", () => {
  const items = [
    { label: "Toggle projects and tasks rail", category: "Layout" },
    { label: "Focus session transcript", category: "Landmarks" },
    { label: "Focus settings and profile selector", category: "Landmarks" },
  ];
  it("prefix match outranks scattered subsequence", () => {
    expect(filterCommands(items, "set")[0]?.label).toMatch(/settings/);
    expect(filterCommands(items, "tog")[0]?.label).toBe(
      "Toggle projects and tasks rail",
    );
  });
  it("drops non-matches and keeps order for an empty query", () => {
    expect(filterCommands(items, "zzz")).toEqual([]);
    expect(filterCommands(items, "  ")).toEqual(items);
  });
});

describe("registry", () => {
  it("disabled commands report a reason and never run, even when run() is called directly", async () => {
    const run = vi.fn();
    const reg = createCommandRegistry({
      "landmark.rail": { run, unavailable: () => "No workspace selected" },
    });
    const c = reg.list().find((x) => x.id === "landmark.rail")!;
    expect(c).toMatchObject({
      enabled: false,
      reason: "No workspace selected",
    });
    expect(await reg.run("landmark.rail")).toEqual({
      ok: false,
      reason: "No workspace selected",
    });
    expect(run).not.toHaveBeenCalled();
  });

  it("re-checks availability at run time (stale list cannot invoke)", async () => {
    let blocked: string | undefined;
    const run = vi.fn();
    const reg = createCommandRegistry({
      "landmark.rail": { run, unavailable: () => blocked },
    });
    expect(reg.list()[0]!.enabled).toBe(true);
    blocked = "Session changed";
    expect((await reg.run("landmark.rail")).ok).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it("commands without a handler are unavailable, not silently runnable", async () => {
    const reg = createCommandRegistry({});
    expect(await reg.run("landmark.rail")).toMatchObject({ ok: false });
  });

  it("routes global shortcuts, ignores IME composition and unrouted scoped keys", () => {
    const open = vi.fn();
    const submit = vi.fn();
    const reg = createCommandRegistry({
      "palette.open": { run: open },
      "composer.submit": { run: submit },
    });
    expect(reg.handleKey(key({ key: "k", ctrlKey: true }))).toBe(true);
    expect(open).toHaveBeenCalledTimes(1);
    expect(
      reg.handleKey(key({ key: "k", ctrlKey: true, isComposing: true })),
    ).toBe(false);
    expect(reg.handleKey(key({ key: "Enter", ctrlKey: true }))).toBe(false);
    expect(submit).not.toHaveBeenCalled();
    expect(open).toHaveBeenCalledTimes(1);
  });
});

describe("shortcut conflicts", () => {
  it("catalog (registry plus shell bindings) has no duplicate active bindings", () => {
    expect(findConflicts(CATALOG)).toEqual([]);
    expect(
      CATALOG.some(
        (c) => c.scope === "shell" && c.shortcuts.includes("Ctrl+B"),
      ),
    ).toBe(true);
    expect(CATALOG.some((c) => c.shortcuts.includes("Ctrl+Shift+E"))).toBe(
      true,
    );
  });
  it("the shell's real shortcutPanel claims exactly the catalog's shell bindings", () => {
    const ev = (s: string) => {
      const parts = s.split("+");
      return {
        key: parts[parts.length - 1]!,
        ctrlKey: parts.includes("Ctrl"),
        shiftKey: parts.includes("Shift"),
        altKey: parts.includes("Alt"),
        isComposing: false,
      };
    };
    for (const c of CATALOG) {
      for (const s of c.shortcuts) {
        expect(shortcutPanel(ev(s)) !== null, `${c.id} ${s}`).toBe(
          c.scope === "shell",
        );
      }
    }
  });
  it("detects same-scope and global-versus-scoped clashes but not disjoint scopes", () => {
    const d = (
      id: string,
      scope: CommandDef["scope"],
      s: string,
    ): CommandDef => ({
      id,
      label: id,
      category: "x",
      scope,
      shortcuts: [s],
      palette: false,
      routed: false,
    });
    expect(
      findConflicts([d("a", "global", "ctrl+b"), d("b", "shell", "Ctrl+B")]),
    ).toHaveLength(1);
    expect(
      findConflicts([d("a", "review", "J"), d("b", "review", "j")]),
    ).toHaveLength(1);
    expect(
      findConflicts([d("a", "review", "Escape"), d("b", "approval", "Escape")]),
    ).toEqual([]);
    expect(normalizeShortcut("shift+ctrl+e")).toBe("Ctrl+Shift+E");
  });
});

describe("run boundary", () => {
  it("a throwing or rejecting handler returns a failure and never leaks a rejection", async () => {
    const reg = createCommandRegistry({
      "landmark.rail": {
        run: () => {
          throw new Error("boom");
        },
      },
      "landmark.transcript": { run: () => Promise.reject(new Error("nope")) },
    });
    expect(await reg.run("landmark.rail")).toEqual({
      ok: false,
      reason: "boom",
    });
    expect(await reg.run("landmark.transcript")).toEqual({
      ok: false,
      reason: "nope",
    });
  });

  it("key-routed failure is surfaced through onFailure and the command can run again", async () => {
    const seen: string[] = [];
    let fail = true;
    const reg = createCommandRegistry(
      {
        "landmark.rail": {
          run: () => {
            if (fail) throw new Error("boom");
          },
        },
      },
      undefined,
      (id, reason) => seen.push(`${id}:${reason}`),
    );
    reg.handleKey(key({ key: "1", ctrlKey: true }));
    await new Promise((r) => setTimeout(r, 0));
    expect(seen).toEqual(["landmark.rail:boom"]);
    fail = false;
    expect(await reg.run("landmark.rail")).toEqual({ ok: true });
  });

  it("ignores a second run of the same command while the first is in flight", async () => {
    let release!: () => void;
    const run = vi.fn(
      () =>
        new Promise<void>((r) => {
          release = r;
        }),
    );
    const reg = createCommandRegistry({ "landmark.rail": { run } });
    const first = reg.run("landmark.rail");
    expect(await reg.run("landmark.rail")).toEqual({
      ok: false,
      reason: "Already running",
    });
    reg.handleKey(key({ key: "1", ctrlKey: true }));
    expect(run).toHaveBeenCalledTimes(1);
    release();
    expect(await first).toEqual({ ok: true });
    void reg.run("landmark.rail");
    expect(run).toHaveBeenCalledTimes(2);
  });
});
