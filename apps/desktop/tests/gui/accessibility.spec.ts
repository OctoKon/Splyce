import { expect, test, type Page } from "@playwright/test";

const STATE_KINDS = [
  "loading",
  "empty",
  "error",
  "stale",
  "unavailable",
] as const;
type StateKind = (typeof STATE_KINDS)[number];

const STATE_LABELS: Readonly<Record<StateKind, string>> = {
  loading: "Loading",
  empty: "Nothing here yet",
  error: "Error",
  stale: "Out of date",
  unavailable: "Unavailable",
};

const STATE_TITLES: Readonly<Record<StateKind, string>> = {
  loading: "Checking the workspace",
  empty: "Nothing here yet",
  error: "The engine stopped",
  stale: "This snapshot is out of date",
  unavailable: "This feature is unavailable",
};

const SOURCE_KINDS = [
  "user",
  "engine",
  "tool",
  "plugin",
  "provider",
  "memory",
  "external",
] as const;
type SourceKind = (typeof SOURCE_KINDS)[number];

const SOURCE_LABELS: Readonly<Record<SourceKind, string>> = {
  user: "User",
  engine: "Engine",
  tool: "Tool",
  plugin: "Plugin",
  provider: "Provider",
  memory: "Memory",
  external: "External page",
};

const LONG_SOURCE_ID =
  "source:urn:splyce:fixture:transcript:2026-10-27:provider:external:very-long-unbroken-identifier";

type Scenario = "states" | "sources" | "narrow" | "transcript";

async function open(page: Page, scenario: Scenario): Promise<void> {
  await page.goto(`/tests/gui/fixture.html?scenario=${scenario}`);
  await expect(page.getByTestId("a11y-fixture")).toHaveAttribute(
    "data-scenario",
    scenario,
  );
}

function sourceId(kind: SourceKind): string {
  return kind === "user" ? LONG_SOURCE_ID : `source-${kind}`;
}

function sourceName(kind: SourceKind): string {
  const label = SOURCE_LABELS[kind];
  const untrusted = kind === "external" || kind === "tool";
  return `Source: ${label}${untrusted ? ", untrusted" : ""}, id ${sourceId(kind)}`;
}

function colorContrast(element: Element): number {
  const parse = (value: string) => {
    const match = value.match(/rgba?\(([^)]+)\)/);
    if (!match) {
      throw new Error(`Unsupported color value: ${value}`);
    }
    const parts = match[1]
      .split(/[\s,/]+/)
      .filter(Boolean)
      .map(Number);
    return {
      r: parts[0],
      g: parts[1],
      b: parts[2],
      a: parts[3] ?? 1,
    };
  };
  const linear = (value: number) => {
    const channel = value / 255;
    return channel <= 0.04045
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4;
  };
  const luminance = (color: { r: number; g: number; b: number }) =>
    0.2126 * linear(color.r) +
    0.7152 * linear(color.g) +
    0.0722 * linear(color.b);

  const foreground = parse(getComputedStyle(element).color);
  let current: Element | null = element;
  let background = { r: 255, g: 255, b: 255, a: 1 };
  while (current) {
    const candidate = parse(getComputedStyle(current).backgroundColor);
    if (candidate.a >= 0.99) {
      background = candidate;
      break;
    }
    current = current.parentElement;
  }

  const lighter = Math.max(luminance(foreground), luminance(background));
  const darker = Math.min(luminance(foreground), luminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

test.beforeEach(({}, testInfo) => {
  testInfo.annotations.push({
    type: "scope",
    description:
      "Fixture-level browser gate only; packaged WebView2, UI Automation, Narrator/NVDA, IME and M protocol are NOT RUN.",
  });
});

test.describe("TD-54 FUI-W3 state semantics", () => {
  test("announces every state by text, role and busy state without color-only cues", async ({
    page,
  }) => {
    await open(page, "states");

    for (const kind of STATE_KINDS) {
      const root = page
        .getByTestId(`state-${kind}`)
        .getByTestId("state-message");

      await expect(root).toBeVisible();
      await expect(root).toHaveAttribute("data-kind", kind);
      await expect(root).toHaveAttribute(
        "role",
        kind === "error" ? "alert" : "status",
      );
      if (kind === "loading") {
        await expect(root).toHaveAttribute("aria-busy", "true");
      } else {
        await expect(root).not.toHaveAttribute("aria-busy", "true");
      }
      await expect(root.getByTestId("state-kind")).toHaveText(
        STATE_LABELS[kind],
      );
      await expect(root).toContainText(STATE_TITLES[kind]);
      expect(await root.evaluate(colorContrast)).toBeGreaterThanOrEqual(4.5);
    }
  });

  test("keeps the error action named, reachable and focusable", async ({
    page,
  }) => {
    await open(page, "states");

    const action = page.getByTestId("state-action-error");
    await expect(action).toBeVisible();
    await expect(action).toHaveAccessibleName("Retry loading");
    await action.focus();
    await expect(action).toBeFocused();
  });
});

test.describe("TD-54 FUI-W3 source semantics", () => {
  test("names provenance, source identity and untrusted state in text", async ({
    page,
  }) => {
    await open(page, "sources");

    for (const kind of SOURCE_KINDS) {
      const root = page
        .getByTestId(`source-${kind}`)
        .getByTestId("source-label");
      const untrusted = kind === "external" || kind === "tool";

      await expect(root).toBeVisible();
      await expect(root).toHaveAttribute("role", "group");
      await expect(root).toHaveAttribute("data-kind", kind);
      await expect(root).toHaveAccessibleName(sourceName(kind));
      await expect(root).toContainText(SOURCE_LABELS[kind]);
      await expect(root.getByTestId("untrusted-mark")).toHaveCount(
        untrusted ? 1 : 0,
      );
      expect(await root.evaluate(colorContrast)).toBeGreaterThanOrEqual(4.5);
    }
  });

  test("never presents an unknown source as trusted", async ({ page }) => {
    await open(page, "sources");

    const root = page.getByTestId("source-unknown").getByTestId("source-label");
    await expect(root).toHaveAttribute("data-kind", "unknown");
    await expect(root).toHaveAccessibleName(
      "Source: Unknown source, untrusted, id source-unknown-kind",
    );
    await expect(root).toContainText("Unknown source");
    await expect(root.getByTestId("untrusted-mark")).toHaveCount(1);
  });
});

test.describe("TD-54 D8 high DPI and narrow layout", () => {
  test.use({
    viewport: { width: 320, height: 640 },
    deviceScaleFactor: 2,
  });

  test("keeps long labels wrapped and leaves no horizontal overflow at 200% text", async ({
    page,
  }) => {
    await open(page, "narrow");
    await page.addStyleTag({ content: "html { font-size: 200%; }" });

    expect(
      await page.evaluate(() => window.devicePixelRatio),
    ).toBeGreaterThanOrEqual(2);

    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1);

    const boxes = await page
      .locator('[data-testid="state-message"], [data-testid="source-label"]')
      .evaluateAll((elements) =>
        elements.map((element) => {
          const rect = element.getBoundingClientRect();
          return {
            left: rect.left,
            right: rect.right,
            width: rect.width,
          };
        }),
      );

    expect(boxes).toHaveLength(2);
    for (const box of boxes) {
      expect(box.width).toBeGreaterThan(0);
      expect(box.left).toBeGreaterThanOrEqual(-1);
      expect(box.right).toBeLessThanOrEqual(321);
    }

    await expect(page.getByTestId("state-action-error")).toBeVisible();
  });
});

test.describe("TD-54 U1 transcript semantics", () => {
  test("keeps user, engine and external provenance distinct in a transcript (fixture subset)", async ({
    page,
  }) => {
    await open(page, "transcript");

    const list = page.getByRole("list", { name: "Transcript entries" });
    await expect(list).toBeVisible();

    await expect(
      page.getByTestId("transcript-user").getByTestId("source-label"),
    ).toHaveAccessibleName("Source: User, id turn-1-user");
    await expect(
      page.getByTestId("transcript-engine").getByTestId("source-label"),
    ).toHaveAccessibleName("Source: Engine, id turn-1-engine");
    await expect(
      page.getByTestId("transcript-external").getByTestId("source-label"),
    ).toHaveAccessibleName(
      `Source: External page, untrusted, id ${LONG_SOURCE_ID}`,
    );
  });
});
