import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import DocumentView from "./DocumentView.svelte";
import { isSafeHref, parseMarkdown } from "./markdown";

let app: Record<string, unknown> | null = null;
afterEach(() => {
  if (app) void unmount(app);
  app = null;
  document.body.innerHTML = "";
});
function render(props: Record<string, unknown>): void {
  app = mount(DocumentView as never, {
    target: document.body,
    props,
  }) as Record<string, unknown>;
  flushSync();
}

describe("markdown model", () => {
  it("parses headings, lists, fences", () => {
    const b = parseMarkdown("# T\n\n- a\n- b\n\n```ts\nx\n```\n");
    expect(b.map((x) => x.t)).toEqual(["h", "list", "code"]);
    expect(b[2]).toMatchObject({ lang: "ts", v: "x" });
  });
  it("allows only http/https/mailto hrefs", () => {
    expect(isSafeHref("https://a.b/c")).toBe(true);
    expect(isSafeHref("javascript:alert(1)")).toBe(false);
    expect(isSafeHref("data:text/html,x")).toBe(false);
    expect(isSafeHref("file:///c:/x")).toBe(false);
  });
});

describe("DocumentView", () => {
  it("renders raw HTML and script as inert text", () => {
    render({
      source:
        'hi <img src=x onerror="alert(1)"> <script>alert(1)</script>\n\n<b>x</b>',
    });
    expect(document.querySelector("img, script, b")).toBeNull();
    expect(document.body.textContent).toContain("<script>alert(1)</script>");
  });

  it("renders plain-text format literally even if it looks like markdown", () => {
    render({ source: "# not heading [a](https://x.y)", format: "text" });
    expect(document.querySelector('[role="heading"], button')).toBeNull();
    expect(document.querySelector("pre")!.textContent).toBe(
      "# not heading [a](https://x.y)",
    );
  });

  it("shows the link destination and opens only on explicit activation", () => {
    const open = vi.fn();
    render({ source: "see [docs](https://example.com/x)", onOpenLink: open });
    expect(document.querySelector("a")).toBeNull();
    expect(
      document.querySelector('[data-testid="link-destination"]')!.textContent,
    ).toContain("https://example.com/x");
    expect(open).not.toHaveBeenCalled();
    document.querySelector<HTMLButtonElement>("button.link")!.click();
    expect(open).toHaveBeenCalledWith("https://example.com/x");
  });

  it("never makes a javascript: link openable but still shows it", () => {
    render({ source: "[x](javascript:alert(1))" });
    expect(document.querySelector("button.link")).toBeNull();
    expect(
      document.querySelector('[data-testid="link-destination"]')!.textContent,
    ).toContain("javascript:alert(1)");
  });

  it("code block has a named copy button that copies the exact code", async () => {
    const copy = vi.fn();
    render({ source: "```ts\nconst a = '<b>';\n```", onCopy: copy });
    const btn = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Copy code (ts)"]',
    )!;
    btn.click();
    await new Promise((r) => setTimeout(r, 0));
    flushSync();
    expect(copy).toHaveBeenCalledWith("const a = '<b>';");
    expect(btn.textContent).toBe("Copied");
    expect(document.querySelector("pre code")!.textContent).toBe(
      "const a = '<b>';",
    );
  });

  it("does not claim Copied when the copy fails", async () => {
    render({
      source: "```\nx\n```",
      onCopy: () => Promise.reject(new Error("no")),
    });
    const btn = document.querySelector<HTMLButtonElement>("button")!;
    btn.click();
    await new Promise((r) => setTimeout(r, 0));
    flushSync();
    expect(btn.textContent).toBe("Copy");
  });
});
