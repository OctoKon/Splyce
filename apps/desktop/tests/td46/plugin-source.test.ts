import { afterEach, describe, expect, it } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import { INSTALLATION_STATES } from "@splyce/pi/contracts";
import PluginDetails from "../../src/components/plugins/PluginDetails.svelte";
import SourceLabel from "../../src/components/source/SourceLabel.svelte";
import {
  resolveCompatibility,
  type Compatibility,
  type PluginRecord,
} from "../../src/components/plugins/compat";
import {
  SOURCE_KINDS,
  type SourceKind,
} from "../../src/components/source/source-kinds";
import { projectStatus } from "../../src/status-view";

const rec = (state: PluginRecord["state"] = "installed"): PluginRecord => ({
  packageId: "pkg.demo",
  installationRevision: "rev-7",
  sourceRef: "src_abc",
  sourceRevisionOrSnapshot: "v1.2.3",
  contentDigest: "sha256:deadbeef",
  state,
});

let apps: Record<string, unknown>[] = [];
function render(c: unknown, props: Record<string, unknown>): HTMLElement {
  const target = document.createElement("div");
  document.body.append(target);
  apps.push(mount(c as never, { target, props }));
  flushSync();
  return target;
}
afterEach(() => {
  for (const a of apps) unmount(a);
  apps = [];
  document.body.innerHTML = "";
});
const q = (t: HTMLElement, id: string) =>
  t.querySelector(`[data-testid="${id}"]`);

describe("TD-46 plugin compatibility", () => {
  it("unknown or missing compatibility is never shown as compatible", () => {
    for (const compatibility of [null, { kind: "unknown" } as Compatibility]) {
      const t = render(PluginDetails, { record: rec(), compatibility });
      expect(q(t, "plugin-compat")!.textContent!.trim()).toBe(
        "Compatibility unknown",
      );
    }
    expect(resolveCompatibility(undefined)).toEqual({ kind: "unknown" });
    expect(resolveCompatibility(null)).toEqual({ kind: "unknown" });
    expect(resolveCompatibility(1.5)).toEqual({ kind: "unknown" });
  });

  it("incompatible shows its reason; compatible shows compatible", () => {
    const t = render(PluginDetails, {
      record: rec(),
      compatibility: resolveCompatibility(9, 1),
    });
    expect(q(t, "plugin-compat")!.textContent).toContain("Incompatible");
    expect(q(t, "plugin-compat-reason")!.textContent).toContain("version 9");
    const ok = render(PluginDetails, {
      record: rec(),
      compatibility: resolveCompatibility(1, 1),
    });
    expect(q(ok, "plugin-compat")!.textContent!.trim()).toBe("Compatible");
  });

  it("shows revision, source, digest and the not-sandboxed notice for trusted plugins", () => {
    const t = render(PluginDetails, { record: rec(), trusted: true });
    expect(q(t, "plugin-revision")!.textContent).toBe("rev-7");
    expect(q(t, "plugin-digest")!.textContent).toBe("sha256:deadbeef");
    expect(q(t, "plugin-source-revision")!.textContent).toBe("v1.2.3");
    expect(q(t, "source-label")!.getAttribute("aria-label")).toContain(
      "src_abc",
    );
    expect(q(t, "plugin-not-sandboxed")!.textContent).toMatch(
      /full app permissions \(not sandboxed\)/,
    );
    const other = render(PluginDetails, { record: rec(), trusted: false });
    expect(q(other, "plugin-not-sandboxed")).toBeNull();
  });

  it("install-state labels come from projectStatus for every state", () => {
    for (const state of INSTALLATION_STATES) {
      const t = render(PluginDetails, { record: rec(state) });
      expect(q(t, "plugin-install")!.textContent).toBe(
        projectStatus("packageInstallation", { state }).label,
      );
    }
  });

  it("has an accessible name", () => {
    const t = render(PluginDetails, { record: rec() });
    expect(q(t, "plugin-details")!.getAttribute("aria-label")).toBe(
      "Plugin pkg.demo",
    );
  });
});

describe("TD-78 source labels", () => {
  it("labels every source kind with text, glyph and an accessible name with id", () => {
    const glyphs = new Set<string>();
    for (const kind of SOURCE_KINDS) {
      const t = render(SourceLabel, { kind, sourceId: `id_${kind}` });
      const el = q(t, "source-label")!;
      expect(el.getAttribute("data-kind")).toBe(kind);
      expect(el.querySelector(".text")!.textContent).toBeTruthy();
      expect(el.getAttribute("aria-label")).toContain(`id id_${kind}`);
      glyphs.add(el.querySelector(".glyph")!.textContent!);
    }
    expect(glyphs.size).toBe(SOURCE_KINDS.length);
  });

  it("marks external pages untrusted in text; trusted kinds are not marked", () => {
    const ext = render(SourceLabel, { kind: "external" });
    expect(q(ext, "untrusted-mark")!.textContent).toContain("untrusted");
    expect(q(ext, "source-label")!.getAttribute("aria-label")).toContain(
      "untrusted",
    );
    expect(
      q(render(SourceLabel, { kind: "user" }), "untrusted-mark"),
    ).toBeNull();
    expect(
      q(
        render(SourceLabel, { kind: "tool", untrusted: true }),
        "untrusted-mark",
      ),
    ).not.toBeNull();
  });

  it("a caller flag cannot remove the untrusted mark from an external page", () => {
    const t = render(SourceLabel, { kind: "external", untrusted: false });
    expect(q(t, "untrusted-mark")).not.toBeNull();
    expect(q(t, "source-label")!.getAttribute("aria-label")).toContain(
      "untrusted",
    );
  });

  it("an unknown kind stays untrusted even with untrusted false", () => {
    const t = render(SourceLabel, {
      kind: "bogus" as SourceKind,
      untrusted: false,
    });
    expect(q(t, "untrusted-mark")).not.toBeNull();
  });

  it("an unknown kind is marked untrusted, never presented as a known source", () => {
    const t = render(SourceLabel, { kind: "bogus" as SourceKind });
    expect(q(t, "source-label")!.getAttribute("data-kind")).toBe("unknown");
    expect(q(t, "untrusted-mark")).not.toBeNull();
  });
});
