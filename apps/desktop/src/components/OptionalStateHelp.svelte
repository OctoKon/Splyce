<script lang="ts" module>
  /** Fixed optional-feature states this help covers. No other state is invented. */
  export const OPTIONAL_STATES = [
    "unsupported",
    "off",
    "missing",
    "cancelled",
  ] as const;
  export type OptionalState = (typeof OPTIONAL_STATES)[number];

  export interface OptionalStateCopy {
    readonly label: string;
    readonly detail: string;
  }

  /**
   * Inert copy only: each state says what is true and what does not happen.
   * Nothing here promises a ready feature or an implicit install.
   */
  export const OPTIONAL_STATE_COPY: Readonly<
    Record<OptionalState, OptionalStateCopy>
  > = Object.freeze({
    unsupported: {
      label: "Not supported on this computer",
      detail:
        "This build leaves the optional feature out. Nothing is installed, downloaded or switched on for you.",
    },
    off: {
      label: "Switched off",
      detail:
        "The optional feature is present but off. It stays off, and nothing runs, until you switch it on.",
    },
    missing: {
      label: "Not installed",
      detail:
        "The optional part is not on this computer. You can add it from Setup if you want it; skipping is fine.",
    },
    cancelled: {
      label: "Setup cancelled",
      detail:
        "Nothing was added. The optional part stays as it was until you start setup again.",
    },
  });

  const FALLBACK: OptionalStateCopy = Object.freeze({
    label: "Unavailable",
    detail:
      "This optional feature cannot be described here. Nothing is installed or running.",
  });

  /** Unknown input never inherits a supported claim. */
  export function optionalStateCopy(state: unknown): OptionalStateCopy {
    return typeof state === "string" &&
      Object.hasOwn(OPTIONAL_STATE_COPY, state)
      ? OPTIONAL_STATE_COPY[state as OptionalState]
      : FALLBACK;
  }

  const GLYPH: Readonly<Record<OptionalState, string>> = Object.freeze({
    unsupported: "⊘",
    off: "○",
    missing: "◇",
    cancelled: "↺",
  });

  export function optionalStateGlyph(state: unknown): string {
    return typeof state === "string" && Object.hasOwn(GLYPH, state)
      ? GLYPH[state as OptionalState]
      : "⊘";
  }
</script>

<script lang="ts">
  import type { Snippet } from "svelte";

  // Presentation only: the parent owns any control, so help can never act alone.
  let {
    state,
    feature,
    action,
  }: {
    state: OptionalState;
    feature?: string;
    action?: Snippet;
  } = $props();

  const copy = $derived(optionalStateCopy(state));
  const glyph = $derived(optionalStateGlyph(state));
</script>

<section
  class="optional-state"
  role="group"
  aria-label={`Optional feature, ${copy.label}`}
  data-testid="optional-state-help"
  data-state={state}
>
  <p class="state">
    <span aria-hidden="true">{glyph}</span>
    <span>{copy.label}</span>
  </p>
  <h3>{copy.label}</h3>
  <p class="detail">{copy.detail}</p>
  {#if feature}<p class="feature">Optional feature: {feature}</p>{/if}
  {#if action}<div class="action">{@render action()}</div>{/if}
</section>

<style>
  .optional-state {
    display: flex;
    flex-direction: column;
    gap: var(--splyce-space-2, 0.5rem);
    padding: var(--splyce-space-3, 0.75rem);
    background: var(--splyce-surface-raised, #ffffff);
    border: 1px solid var(--splyce-border-default, #e5e7eb);
    border-radius: var(--radius-md, 8px);
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.04);
    overflow-wrap: anywhere;
    transition: border-color 0.15s ease;
  }
  .optional-state[data-state="unsupported"] {
    border-left: 4px solid var(--splyce-status-danger, #b91c1c);
  }
  .optional-state[data-state="missing"],
  .optional-state[data-state="cancelled"] {
    border-left: 4px solid var(--splyce-status-warning, #b45309);
  }
  .optional-state[data-state="off"] {
    border-left: 4px solid var(--splyce-text-muted, #6b7280);
  }
  .state {
    display: flex;
    align-items: center;
    gap: var(--splyce-space-2, 0.5rem);
    margin: 0;
    font-size: var(--splyce-font-size-xs, 0.75rem);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--splyce-text-secondary, #4b5563);
  }
  h3 {
    margin: 0;
    font-size: var(--splyce-font-size-base, 1rem);
    font-weight: 600;
    color: var(--splyce-text-primary, #111827);
  }
  .detail {
    margin: 0;
    font-size: var(--splyce-font-size-sm, 0.875rem);
    color: var(--splyce-text-secondary, #4b5563);
    line-height: var(--splyce-line-height-normal, 1.5);
    max-width: 65ch;
  }
  .feature {
    margin: 0;
    font-size: var(--splyce-font-size-xs, 0.75rem);
    color: var(--splyce-text-muted, #6b7280);
  }
  .action {
    margin-top: var(--splyce-space-1, 0.25rem);
  }
</style>
