import { describe, expect, it } from "vitest";
import {
  toSpecialistView,
  type CalibrationState,
  type SpecialistBindingState,
  type SpecialistInput,
} from "./specialist-view";

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

describe("toSpecialistView", () => {
  it("keeps advice advisory and separate from authority", () => {
    const view = toSpecialistView(make());
    expect(view.authority).toBe("advisory");
    expect(view.advice?.headline).toBe("Prefer option A");
  });

  it("only exposes confidence when calibration is calibrated", () => {
    expect(toSpecialistView(make()).calibration.confidence).toBe(0.82);
    for (const state of [
      "unmeasured",
      "insufficient-history",
      "unavailable",
    ] as const) {
      expect(
        toSpecialistView(
          make({
            calibration: { ...base.calibration, state, confidence: 0.91 },
          }),
        ).calibration.confidence,
        state,
      ).toBeNull();
    }
  });

  it("rejects out-of-range or non-finite confidence", () => {
    for (const confidence of [1.2, -0.1, Number.NaN]) {
      expect(
        toSpecialistView(
          make({ calibration: { ...base.calibration, confidence } }),
        ).calibration.confidence,
      ).toBeNull();
    }
  });

  it("hides advice when the binding is unavailable", () => {
    const view = toSpecialistView(
      make({
        binding: { state: "unavailable", reason: "Local model not installed." },
      }),
    );
    expect(view.bindingState).toBe("unavailable");
    expect(view.bindingUnavailableReason).toBe("Local model not installed.");
    expect(view.advice).toBeNull();
  });

  it("fails closed on an unknown binding state", () => {
    const view = toSpecialistView(
      make({
        binding: { state: "bogus" as unknown as SpecialistBindingState },
      }),
    );
    expect(view.bindingState).toBe("unavailable");
    expect(view.bindingUnavailableReason).toBe(
      "Specialist model is unavailable.",
    );
    expect(view.advice).toBeNull();
  });

  it("fails closed on an unknown calibration state", () => {
    const view = toSpecialistView(
      make({
        calibration: {
          state: "bogus" as unknown as CalibrationState,
          detail: undefined,
          confidence: 0.9,
        },
      }),
    );
    expect(view.calibration.state).toBe("unavailable");
    expect(view.calibration.label).toBe("Calibration unavailable");
    expect(view.calibration.detail).toBe("Calibration data is unavailable.");
    expect(view.calibration.confidence).toBeNull();
  });

  it("downgrades calibrated advice with insufficient samples", () => {
    const view = toSpecialistView(
      make({
        calibration: {
          state: "calibrated",
          samples: 3,
          requiredSamples: 20,
          confidence: 0.9,
        },
      }),
    );
    expect(view.calibration.state).toBe("insufficient-history");
    expect(view.calibration.label).toBe("Insufficient history");
    expect(view.calibration.detail).toBe("3 of 20 required samples.");
    expect(view.calibration.confidence).toBeNull();
  });

  it("downgrades calibrated claims with non-finite sample counts", () => {
    const view = toSpecialistView(
      make({
        calibration: {
          state: "calibrated",
          samples: Number.NaN,
          requiredSamples: 50,
          confidence: 0.9,
        },
      }),
    );
    expect(view.calibration.state).toBe("insufficient-history");
    expect(view.calibration.label).toBe("Insufficient history");
    expect(view.calibration.detail).toBe("Not enough history to calibrate.");
    expect(view.calibration.confidence).toBeNull();
  });

  it("downgrades calibrated claims without sample counts", () => {
    const view = toSpecialistView(
      make({
        calibration: {
          state: "calibrated",
          samples: undefined,
          requiredSamples: undefined,
          confidence: 0.9,
        },
      }),
    );
    expect(view.calibration.state).toBe("insufficient-history");
    expect(view.calibration.label).toBe("Insufficient history");
    expect(view.calibration.detail).toBe("Not enough history to calibrate.");
    expect(view.calibration.confidence).toBeNull();
  });

  it("downgrades calibrated claims with a zero requirement", () => {
    const view = toSpecialistView(
      make({
        calibration: {
          state: "calibrated",
          samples: 50,
          requiredSamples: 0,
          confidence: 0.9,
        },
      }),
    );
    expect(view.calibration.state).toBe("insufficient-history");
    expect(view.calibration.confidence).toBeNull();
  });

  it("keeps calibrated confidence when samples meet the requirement", () => {
    const view = toSpecialistView(
      make({
        calibration: {
          state: "calibrated",
          samples: 20,
          requiredSamples: 20,
          confidence: 0.75,
        },
      }),
    );
    expect(view.calibration.state).toBe("calibrated");
    expect(view.calibration.confidence).toBe(0.75);
  });

  it("uses an honest fixed reason when an unavailable binding has none", () => {
    expect(
      toSpecialistView(make({ binding: { state: "unavailable" } }))
        .bindingUnavailableReason,
    ).toBe("Specialist model is unavailable.");
  });

  it("labels every calibration state", () => {
    const states: readonly [CalibrationState, string][] = [
      ["calibrated", "Calibrated"],
      ["unmeasured", "Not measured"],
      ["insufficient-history", "Insufficient history"],
      ["unavailable", "Calibration unavailable"],
    ];
    for (const [state, label] of states) {
      const view = toSpecialistView(
        make({
          calibration: { ...base.calibration, state, detail: undefined },
        }),
      );
      expect(view.calibration.label).toBe(label);
      expect(view.calibration.detail.length).toBeGreaterThan(0);
    }
  });

  it("renders insufficient history with sample counts and no confidence", () => {
    const view = toSpecialistView(
      make({
        calibration: {
          state: "insufficient-history",
          samples: 3,
          requiredSamples: 20,
          confidence: 0.9,
        },
      }),
    );
    expect(view.calibration.detail).toBe("3 of 20 required samples.");
    expect(view.calibration.confidence).toBeNull();
  });

  it("keeps advice when only calibration is unavailable", () => {
    const view = toSpecialistView(
      make({
        calibration: {
          state: "unavailable",
          detail: "Calibration service offline.",
        },
      }),
    );
    expect(view.advice?.headline).toBe("Prefer option A");
    expect(view.calibration.label).toBe("Calibration unavailable");
    expect(view.calibration.detail).toBe("Calibration service offline.");
    expect(view.calibration.confidence).toBeNull();
  });

  it("preserves fixture labelling and model identity from the input", () => {
    const view = toSpecialistView(
      make({
        fixture: false,
        model: { name: "Local decision", revision: "v2" },
      }),
    );
    expect(view.fixture).toBe(false);
    expect(view.model).toEqual({ name: "Local decision", revision: "v2" });
  });
});
