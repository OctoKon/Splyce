import { describe, expect, it } from "vitest";
import {
  initialShell,
  layoutMode,
  normalizeShell,
  shortcutPanel,
  togglePanel,
  visiblePanes,
} from "./shell";

describe("TD-72 shell store", () => {
  it("maps widths to breakpoints at the exact edges", () => {
    expect(layoutMode(767)).toBe("narrow");
    expect(layoutMode(768)).toBe("medium");
    expect(layoutMode(1199)).toBe("medium");
    expect(layoutMode(1200)).toBe("wide");
  });

  it("starts with the rail closed when narrow", () => {
    expect(initialShell("narrow").rail).toBe(false);
    expect(initialShell("wide").rail).toBe(true);
  });

  it("wide allows both side panels; medium and narrow keep one", () => {
    const both = { rail: true, evidence: false };
    expect(togglePanel(both, "evidence", "wide")).toEqual({
      rail: true,
      evidence: true,
    });
    expect(togglePanel(both, "evidence", "medium")).toEqual({
      rail: false,
      evidence: true,
    });
  });

  it("narrow shows one content pane at a time", () => {
    const closed = { rail: false, evidence: false };
    expect(visiblePanes(closed, "narrow")).toEqual({
      rail: false,
      conversation: true,
      evidence: false,
    });
    expect(
      visiblePanes({ rail: true, evidence: false }, "narrow").conversation,
    ).toBe(false);
    expect(
      visiblePanes({ rail: true, evidence: false }, "medium").conversation,
    ).toBe(true);
  });

  it("normalises on resize", () => {
    const both = { rail: true, evidence: true };
    expect(normalizeShell(both, "narrow")).toEqual({
      rail: false,
      evidence: false,
    });
    expect(normalizeShell(both, "medium")).toEqual({
      rail: true,
      evidence: false,
    });
    expect(normalizeShell(both, "wide")).toBe(both);
  });

  it("maps keyboard shortcuts and ignores IME composition", () => {
    const k = { key: "b", ctrlKey: true, shiftKey: false };
    expect(shortcutPanel(k)).toBe("rail");
    expect(shortcutPanel({ ...k, key: "E", shiftKey: true })).toBe("evidence");
    expect(shortcutPanel({ ...k, isComposing: true })).toBeNull();
    expect(shortcutPanel({ ...k, ctrlKey: false })).toBeNull();
    expect(shortcutPanel({ ...k, altKey: true })).toBeNull();
  });
});
