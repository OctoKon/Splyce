<script lang="ts">
  import {
    whenEffective,
    type Disposition,
    type ModelCatalogStatus,
    type ModelOption,
    type ModelSelectionState,
  } from "../../stores/model-selection";

  let {
    selection,
    options,
    catalogStatus = "ready",
    stale = false,
    turnActive = false,
    onRequest,
  }: {
    selection: ModelSelectionState;
    options: ModelOption[];
    /** The catalog feed's state; never inferred from `options` being empty. */
    catalogStatus?: ModelCatalogStatus;
    /** The catalog may be behind the engine's current catalog. */
    stale?: boolean;
    turnActive?: boolean;
    onRequest: (ref: string, disposition: Disposition) => void;
  } = $props();

  let chosen = $state<string | null>(null);
  let disposition = $state<Disposition>("next-turn");

  const labelOf = (ref: string): string =>
    options.find((o) => o.ref === ref)?.label ?? ref;
  /**
   * A picker is only offered from a catalog we actually read: a failed catalog
   * must not let the user commit a switch to a binding the engine may no longer
   * have. Loading keeps options already known, because they are still the
   * engine's last statement and the refresh is expected to settle.
   */
  const showsPicker = $derived(options.length > 0 && catalogStatus !== "error");
  const busy = $derived(
    selection.transition?.status === "requested" ||
      selection.transition?.status === "pending",
  );
  const STATUS_TEXT = {
    requested: "Requested",
    pending: "Pending",
    applied: "Applied",
    rejected: "Rejected",
    canceled: "Canceled",
  } as const;
</script>

<section
  aria-labelledby="model-switch-title"
  aria-busy={catalogStatus === "loading" ? "true" : undefined}
  data-testid="model-switcher"
>
  <h3 id="model-switch-title">Model</h3>
  <p data-testid="model-current">Active: {labelOf(selection.currentRef)}</p>

  {#if selection.transition}
    {@const t = selection.transition}
    <p
      role={t.status === "rejected" || t.mismatch ? "alert" : "status"}
      data-testid="model-requested"
      data-status={t.status}
    >
      Requested: {labelOf(t.requestedRef)} · {STATUS_TEXT[t.status]}
      {#if t.status === "rejected"}
        · {t.reason}. Still using {labelOf(selection.currentRef)}.
      {:else if t.mismatch}
        · Engine chose a different model than you requested.
      {:else if t.status === "requested" || t.status === "pending"}
        · {whenEffective(t.disposition, turnActive)}
      {/if}
    </p>
  {/if}

  {#if catalogStatus === "loading"}
    <p role="status" data-testid="model-catalog-loading">
      Loading the model catalog…
    </p>
  {:else if catalogStatus === "error"}
    <p role="alert" data-testid="model-catalog-error">
      The model catalog could not be loaded. Available models are unknown - not
      none.
    </p>
  {:else if options.length === 0}
    <p data-testid="model-catalog-empty">
      The engine reported no models. Nothing is available to switch to.
    </p>
  {/if}

  {#if stale && catalogStatus !== "error"}
    <p role="status" data-testid="model-catalog-stale">
      This catalog may be out of date. The engine has not confirmed it.
    </p>
  {/if}

  {#if showsPicker}
    <fieldset disabled={busy}>
      <legend>Switch model</legend>
      {#each options as o (o.ref)}
        <label>
          <input
            type="radio"
            name="model"
            value={o.ref}
            disabled={o.unavailableReason !== undefined}
            checked={chosen === o.ref}
            onchange={() => (chosen = o.ref)}
          />
          {o.label}
          <span>({o.locality === "local" ? "Local" : "Cloud"})</span>
          {#each o.labels ?? [] as l}<span>[{l}]</span>{/each}
          {#if o.unavailableReason !== undefined}
            <span data-testid="model-unavailable">
              Unavailable: {o.unavailableReason}
            </span>
          {/if}
        </label>
      {/each}

      {#if turnActive}
        <label>
          <input
            type="radio"
            name="disposition"
            value="next-turn"
            checked={disposition === "next-turn"}
            onchange={() => (disposition = "next-turn")}
          />
          After the running turn
        </label>
        <label>
          <input
            type="radio"
            name="disposition"
            value="cancel-and-switch"
            checked={disposition === "cancel-and-switch"}
            onchange={() => (disposition = "cancel-and-switch")}
          />
          Cancel the running turn and switch
        </label>
      {/if}

      <button
        type="button"
        disabled={chosen === null || chosen === selection.currentRef}
        onclick={() => chosen !== null && onRequest(chosen, disposition)}
      >
        Request switch
      </button>
    </fieldset>
  {/if}
</section>

<style>
  section {
    display: flex;
    flex-direction: column;
    gap: var(--splyce-space-3, 0.75rem);
    padding: var(--splyce-space-3, 0.75rem);
    background: var(--splyce-surface-raised, #ffffff);
    border: 1px solid var(--splyce-border-default, #e5e7eb);
    border-radius: var(--radius-md, 8px);
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.04);
  }
  h3 {
    margin: 0;
    font-size: var(--splyce-font-size-base, 1rem);
    font-weight: 600;
    color: var(--splyce-text-primary, #111827);
  }
  [data-testid="model-current"] {
    margin: 0;
    font-size: var(--splyce-font-size-sm, 0.875rem);
    font-weight: 500;
    color: var(--splyce-text-secondary, #4b5563);
    padding: var(--splyce-space-2, 0.5rem);
    background: var(--splyce-surface, #ffffff);
    border: 1px solid var(--splyce-border-subtle, #f3f4f6);
    border-radius: var(--radius-md, 6px);
  }
  [data-testid="model-requested"] {
    margin: 0;
    padding: var(--splyce-space-2, 0.5rem) var(--splyce-space-3, 0.75rem);
    font-size: var(--splyce-font-size-sm, 0.875rem);
    border-radius: var(--radius-md, 6px);
    font-weight: 500;
  }
  [data-testid="model-requested"][data-status="requested"],
  [data-testid="model-requested"][data-status="pending"] {
    background: rgba(124, 58, 237, 0.08);
    border: 1px solid var(--splyce-status-pending, #7c3aed);
    color: var(--splyce-status-pending, #7c3aed);
  }
  [data-testid="model-requested"][data-status="applied"] {
    background: rgba(4, 120, 87, 0.08);
    border: 1px solid var(--splyce-status-success, #047857);
    color: var(--splyce-status-success, #047857);
  }
  [data-testid="model-requested"][data-status="rejected"],
  [data-testid="model-requested"][role="alert"] {
    background: rgba(185, 28, 28, 0.08);
    border: 1px solid var(--splyce-status-danger, #b91c1c);
    color: var(--splyce-status-danger, #b91c1c);
  }
  [data-testid="model-catalog-loading"],
  [data-testid="model-catalog-stale"] {
    margin: 0;
    font-size: var(--splyce-font-size-xs, 0.75rem);
    color: var(--splyce-status-warning, #b45309);
    padding: var(--splyce-space-1, 0.25rem) var(--splyce-space-2, 0.5rem);
    background: rgba(180, 83, 9, 0.06);
    border-radius: var(--radius-md, 4px);
  }
  [data-testid="model-catalog-error"] {
    margin: 0;
    font-size: var(--splyce-font-size-sm, 0.875rem);
    color: var(--splyce-status-danger, #b91c1c);
    padding: var(--splyce-space-2, 0.5rem);
    background: rgba(185, 28, 28, 0.08);
    border: 1px solid var(--splyce-status-danger, #b91c1c);
    border-radius: var(--radius-md, 6px);
    font-weight: 500;
  }
  [data-testid="model-catalog-empty"] {
    margin: 0;
    font-size: var(--splyce-font-size-sm, 0.875rem);
    color: var(--splyce-text-muted, #6b7280);
    font-style: italic;
  }
  fieldset {
    display: flex;
    flex-direction: column;
    gap: var(--splyce-space-2, 0.5rem);
    border: 1px solid var(--splyce-border-default, #e5e7eb);
    border-radius: var(--radius-md, 6px);
    padding: var(--splyce-space-3, 0.75rem);
    margin: 0;
  }
  fieldset:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
  legend {
    font-size: var(--splyce-font-size-xs, 0.75rem);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--splyce-text-secondary, #4b5563);
    padding: 0 var(--splyce-space-1, 0.25rem);
  }
  label {
    display: flex;
    align-items: center;
    gap: var(--splyce-space-2, 0.5rem);
    font-size: var(--splyce-font-size-sm, 0.875rem);
    color: var(--splyce-text-primary, #111827);
    padding: var(--splyce-space-1, 0.25rem) var(--splyce-space-2, 0.5rem);
    border-radius: var(--radius-md, 4px);
    cursor: pointer;
    transition: background-color 0.15s ease;
  }
  label:hover:not(:has(input:disabled)) {
    background: var(--splyce-surface, #ffffff);
  }
  label:has(input:disabled) {
    color: var(--splyce-text-muted, #6b7280);
    cursor: not-allowed;
  }
  [data-testid="model-unavailable"] {
    font-size: var(--splyce-font-size-xs, 0.75rem);
    color: var(--splyce-status-danger, #b91c1c);
    font-weight: 500;
    margin-left: auto;
  }
  button {
    align-self: flex-start;
    margin-top: var(--splyce-space-2, 0.5rem);
    padding: 6px 16px;
    font-family: inherit;
    font-size: var(--splyce-font-size-sm, 0.875rem);
    font-weight: 600;
    border-radius: var(--radius-md, 6px);
    background: var(--focus, #2563eb);
    color: #ffffff;
    border: 1px solid transparent;
    cursor: pointer;
    transition: background-color 0.15s ease, opacity 0.15s ease;
  }
  button:hover:not(:disabled) {
    background: #1d4ed8;
  }
  button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  button:focus-visible,
  input:focus-visible {
    outline: 2px solid var(--focus, #2563eb);
    outline-offset: 2px;
  }
</style>
