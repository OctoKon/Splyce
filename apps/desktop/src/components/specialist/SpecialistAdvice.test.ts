import { afterEach, describe, expect, it } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import SpecialistAdvice from "./SpecialistAdvice.svelte";
import {
  toSpecialistView,
  type CalibrationState,
  type SpecialistInput,
  type SpecialistView,
} from "../../stores/specialist-view";
import { PROPOSED_SELECTION, contrastRatio } from "../specimens/tokens";

const base: SpecialistInput = {
  kind: "decision",
  fixture: true,
  binding: { state: "ready" },
  model: { name: "Fixture decision model", revision: "fixture-v1" },
  calibration: {
    state: "calibrated",
    samples: 50,
    requiredSamples: 50,
    confidence: 0.82,
  },
  advice: { headline: "Prefer option A", detail: "Fixture rationale." },
};

const make = (over: Partial<SpecialistInput> = {}): SpecialistInput => ({
  ...base,
  ...over,
  binding: { ...base.binding, ...(over.binding ?? {}) },
  calibration: { ...base.calibration, ...(over.calibration ?? {}) },
  model: { ...base.model, ...(over.model ?? {}) },
});

let cmp: ReturnType<typeof mount> | null = null;
function render(view: SpecialistView): void {
  if (cmp) unmount(cmp);
  document.body.innerHTML = "";
  cmp = mount(SpecialistAdvice, { target: document.body, props: { view } });
  flushSync();
}
afterEach(() => {
  if (cmp) unmount(cmp);
  cmp = null;
  document.body.innerHTML = "";
});

const q = (s: string) => document.querySelector<HTMLElement>(s);
const text = () => document.body.textContent ?? "";

describe("SpecialistAdvice", () => {
  it("labels advice as advisory and exposes no effectful controls", () => {
    render(toSpecialistView(make()));
    expect(q("h3")!.textContent).toContain("Decision advice");
    expect(text()).toContain("Advisory only");
    expect(text()).toContain("does not grant authority");
    expect(text()).toContain("Fixture decision model (fixture-v1)");
    expect(
      document.querySelectorAll("button, a, input, select, textarea").length,
    ).toBe(0);
    expect(q("details > summary")?.textContent).toContain("Technical detail");
  });

  it("renders binding readiness and every calibration label as text", () => {
    render(toSpecialistView(make()));
    expect(q('[data-testid="specialist-binding"]')!.textContent?.trim()).toBe(
      "Ready",
    );
    const states: readonly [CalibrationState, string][] = [
      ["calibrated", "Calibrated"],
      ["unmeasured", "Not measured"],
      ["insufficient-history", "Insufficient history"],
      ["unavailable", "Calibration unavailable"],
    ];
    for (const [state, label] of states) {
      render(
        toSpecialistView(make({ calibration: { ...base.calibration, state } })),
      );
      expect(
        q('[data-testid="specialist-calibration"]')!.textContent?.trim(),
      ).toBe(label);
    }
  });

  it("does not show confidence unless the model is calibrated", () => {
    render(
      toSpecialistView(
        make({ calibration: { state: "unmeasured", confidence: 0.9 } }),
      ),
    );
    expect(q('[data-testid="specialist-confidence"]')).toBeNull();
    expect(text()).not.toContain("90%");

    render(
      toSpecialistView(
        make({ calibration: { state: "calibrated", confidence: 0.82 } }),
      ),
    );
    expect(q('[data-testid="specialist-confidence"]')!.textContent).toContain(
      "82%",
    );
  });

  it("hides advice and shows the reason when the binding is unavailable", () => {
    render(
      toSpecialistView(
        make({
          binding: {
            state: "unavailable",
            reason: "Local model not installed.",
          },
        }),
      ),
    );
    expect(q('[data-testid="specialist-unavailable"]')!.textContent).toContain(
      "Local model not installed.",
    );
    expect(q('[data-testid="specialist-binding"]')!.textContent).toContain(
      "Unavailable",
    );
    expect(text()).not.toContain("Prefer option A");
  });

  it("labels fixture data and never implies unlabelled live data", () => {
    render(toSpecialistView(make({ fixture: true })));
    expect(q('[data-testid="specialist-fixture"]')!.textContent).toContain(
      "Fixture data",
    );

    render(toSpecialistView(make({ fixture: false })));
    expect(q('[data-testid="specialist-fixture"]')).toBeNull();
  });

  it("marks an abstention as no recommendation and hides confidence", () => {
    render(
      toSpecialistView(
        make({
          advice: {
            headline: "No decision",
            detail: "Evidence is conflicting.",
            abstained: true,
          },
          calibration: { state: "calibrated", confidence: 0.9 },
        }),
      ),
    );
    expect(q('[data-testid="specialist-abstained"]')!.textContent).toContain(
      "no recommendation is implied",
    );
    expect(q('[data-testid="specialist-confidence"]')).toBeNull();
  });

  it("renders forecast advice with the same advisory boundary", () => {
    render(toSpecialistView(make({ kind: "forecast" })));
    expect(q("h3")!.textContent).toContain("Forecast advice");
    expect(text()).toContain("Advisory only");
  });

  it("reuses the TD-75 selection pair for the advisory badge", () => {
    expect(
      contrastRatio(
        PROPOSED_SELECTION.selection,
        PROPOSED_SELECTION.selectionText,
      ),
    ).toBeGreaterThanOrEqual(4.5);
    render(toSpecialistView(make()));
    expect(q('[data-testid="specialist-advisory"]')!.textContent).toContain(
      "Advisory only",
    );
  });
});
