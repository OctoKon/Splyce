import { afterEach, describe, expect, it } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import { parseUnifiedDiff, splitRows } from "./diff";
import DiffView from "./DiffView.svelte";
import VerificationPanel from "../verification/VerificationPanel.svelte";
import { project, overall } from "../verification/verification";

const DIFF = [
  "diff --git a/a.txt b/a.txt",
  "--- a/a.txt",
  "+++ b/a.txt",
  "@@ -1,3 +1,3 @@",
  " one",
  "--- two",
  "+++ TWO",
  " three",
  "diff --git a/img.png b/img.png",
  "Binary files a/img.png and b/img.png differ",
  "",
].join("\n");

let app: Record<string, unknown> | null = null;
afterEach(() => {
  if (app) void unmount(app);
  app = null;
  document.body.innerHTML = "";
});
function render(C: never, props: Record<string, unknown>): void {
  app = mount(C, { target: document.body, props }) as Record<string, unknown>;
  flushSync();
}

describe("parseUnifiedDiff", () => {
  it("parses files, numbering, and keeps header-looking content lines as content", () => {
    const f = parseUnifiedDiff(DIFF);
    expect(f.map((x) => [x.path, x.binary])).toEqual([
      ["a.txt", false],
      ["img.png", true],
    ]);
    const lines = f[0]!.hunks[0]!.lines;
    expect(lines.map((l) => [l.kind, l.oldNo, l.newNo, l.text])).toEqual([
      ["ctx", 1, 1, "one"],
      ["del", 2, null, "-- two"],
      ["add", null, 2, "++ TWO"],
      ["ctx", 3, 3, "three"],
    ]);
  });

  it("pairs deletions with additions side by side", () => {
    const rows = splitRows(parseUnifiedDiff(DIFF)[0]!.hunks[0]!.lines);
    expect(rows).toHaveLength(3);
    expect(rows[1]!.left!.text).toBe("-- two");
    expect(rows[1]!.right!.text).toBe("++ TWO");
  });
});

describe("DiffView", () => {
  it("marks added/removed with text and glyph, not colour alone", () => {
    render(DiffView as never, { diff: DIFF });
    const del = document.querySelector('tr[data-kind="del"]')!;
    const add = document.querySelector('tr[data-kind="add"]')!;
    expect(del.textContent).toContain("Removed");
    expect(del.textContent).toContain("-");
    expect(add.textContent).toContain("Added");
    expect(add.textContent).toContain("+");
  });

  it("switches to side-by-side and keeps the selected file via keyboard-operable buttons", () => {
    render(DiffView as never, { diff: DIFF });
    const btn = (t: string) =>
      [...document.querySelectorAll("button")].find(
        (b) => b.textContent === t,
      )!;
    btn("Side by side").click();
    flushSync();
    expect(btn("Side by side").getAttribute("aria-pressed")).toBe("true");
    expect(document.querySelectorAll("tbody tr")).toHaveLength(3);
    btn("img.png").click();
    flushSync();
    expect(
      document.querySelector('[data-testid="diff-binary"]'),
    ).not.toBeNull();
    btn("Unified").click();
    flushSync();
    expect(btn("img.png").getAttribute("aria-pressed")).toBe("true");
    expect(document.querySelector('[role="region"]')).toBeNull();
  });

  it("truncates large diffs with an explicit show more", () => {
    const body = Array.from({ length: 50 }, (_, i) => `+l${i}`).join("\n");
    const d = `--- a/x\n+++ b/x\n@@ -0,0 +1,50 @@\n${body}\n`;
    render(DiffView as never, { diff: d, pageSize: 20 });
    expect(document.querySelectorAll("tbody tr")).toHaveLength(20);
    const more = document.querySelector<HTMLButtonElement>(
      '[data-testid="diff-more"]',
    )!;
    expect(more.textContent).toContain("30 lines hidden");
    more.click();
    flushSync();
    expect(document.querySelectorAll("tbody tr")).toHaveLength(40);
  });

  it("shows an honest too-large placeholder, not an empty diff", () => {
    render(DiffView as never, { diff: DIFF, maxBytes: 10 });
    expect(
      document.querySelector('[data-testid="diff-too-large"]')!.textContent,
    ).toContain("not empty");
    expect(document.querySelector("table")).toBeNull();
  });

  it("neutralizes markup in diff text", () => {
    const d = `--- a/x\n+++ b/x\n@@ -0,0 +1 @@\n+<img src=x onerror=alert(1)><script>1</script>\n`;
    render(DiffView as never, { diff: d });
    expect(document.querySelector("img, script")).toBeNull();
    expect(document.querySelector(".code")!.textContent).toContain("<script>");
  });

  it("names the scroll region and the file/layout groups", () => {
    render(DiffView as never, { diff: DIFF });
    expect(
      document.querySelector('[role="region"]')!.getAttribute("aria-label"),
    ).toBe("Diff of a.txt");
    expect(
      document.querySelector('[role="region"]')!.getAttribute("tabindex"),
    ).toBe("0");
    expect(document.querySelector('[aria-label="Files"]')).not.toBeNull();
  });
});

describe("verification", () => {
  const r = (state: never, snapshotId = "s2") => ({
    verifierId: "v",
    name: "tests",
    snapshotId,
    state,
  });

  it("a pass recorded for an older snapshot is stale, never passed", () => {
    const p = project("s2", r("passed" as never, "s1"));
    expect(p.state).toBe("stale");
    expect(overall([p])).toBe("incomplete");
  });

  it("uncertain is never passed; failed dominates; empty is not verified", () => {
    expect(overall([project("s2", r("uncertain" as never))])).toBe(
      "incomplete",
    );
    expect(
      overall([
        project("s2", r("failed" as never)),
        project("s2", r("passed" as never)),
      ]),
    ).toBe("failed");
    expect(overall([])).toBe("incomplete");
    expect(overall([project("s2", r("passed" as never))])).toBe("verified");
  });

  it("panel renders stale and uncertain text with no Passed wording", () => {
    render(VerificationPanel as never, {
      snapshotId: "s2",
      results: [
        { verifierId: "a", name: "unit", snapshotId: "s1", state: "passed" },
        { verifierId: "b", name: "lint", snapshotId: "s2", state: "uncertain" },
      ],
    });
    const panel = document.querySelector('[data-testid="verification-panel"]')!;
    expect(panel.getAttribute("data-overall")).toBe("incomplete");
    expect(panel.textContent).toContain("Stale");
    expect(panel.textContent).toContain("Uncertain");
    expect(panel.textContent).not.toMatch(/Passed|Verified/);
    expect(panel.getAttribute("aria-label")).toBe("Verification");
  });

  it("panel shows verified only for fresh passes", () => {
    render(VerificationPanel as never, {
      snapshotId: "s2",
      results: [
        { verifierId: "a", name: "unit", snapshotId: "s2", state: "passed" },
      ],
    });
    expect(document.body.textContent).toContain("Verified for this snapshot");
  });
});
