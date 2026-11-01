<script lang="ts">
  import { tick } from "svelte";
  import {
    emptyMessage,
    localityLabel,
    type MemoryEntry,
    type MemoryStatus,
  } from "../../stores/memory-view";

  let {
    entries,
    status = "on",
    stale = false,
    onForget,
  }: {
    entries: MemoryEntry[];
    status?: MemoryStatus;
    /** The list may be behind the engine's current revision. */
    stale?: boolean;
    onForget: (observationId: string) => Promise<void>;
  } = $props();

  let confirming = $state<string | null>(null);
  let inflight = $state<string | null>(null);
  let failed = $state<Record<string, true>>({});
  let listEl: HTMLElement;

  async function restoreFocus(id: string): Promise<void> {
    await tick();
    if (!listEl?.isConnected) return;
    const target = [...listEl.querySelectorAll<HTMLElement>("[data-forget]")].find(
      (el) => el.dataset.forget === id,
    );
    (target ?? listEl).focus();
  }

  function cancel(id: string): void {
    confirming = null;
    void restoreFocus(id);
  }

  async function confirm(id: string): Promise<void> {
    if (inflight !== null) return;
    inflight = id;
    const { [id]: _drop, ...rest } = failed;
    failed = rest;
    try {
      await onForget(id);
    } catch {
      // Fixed copy only: the raw error may carry paths or secrets.
      failed = { ...failed, [id]: true };
    }
    inflight = null;
    confirming = null;
    void restoreFocus(id);
  }
</script>

<section
  bind:this={listEl}
  tabindex="-1"
  aria-labelledby="memory-title"
  aria-busy={status === "loading" ? "true" : undefined}
  data-testid="memory-list"
>
  <h3 id="memory-title">Memory</h3>

  {#if status === "loading"}
    <p role="status" data-testid="memory-loading">{emptyMessage("loading")}</p>
  {:else if status === "error"}
    <p role="alert" data-testid="memory-error">{emptyMessage("error")}</p>
  {:else if status !== "on" || entries.length === 0}
    <p data-testid="memory-empty">{emptyMessage(status, stale)}</p>
  {/if}

  {#if status !== "unavailable" && status !== "error"}
    {#if stale && entries.length > 0}
      <p role="status" data-testid="memory-stale">
        These items may be out of date. The engine has not confirmed the current
        revision.
      </p>
    {/if}
    <ul>
      {#each entries as e (e.observation.observationId)}
        {@const id = e.observation.observationId}
        <li data-testid="memory-item">
          <p>{e.claim ?? "Claim unavailable"}</p>
          <dl>
            <dt>Source</dt>
            <dd>{e.source}</dd>
            <dt>Scope</dt>
            <dd>{e.scope}</dd>
            <dt>Locality</dt>
            <dd data-testid="memory-locality">{localityLabel(e.locality)}</dd>
          </dl>

          {#if e.state === "purge-pending"}
            <p role="status" data-testid="memory-purge">
              Purge pending. Not yet confirmed deleted by the engine.
            </p>
          {:else if confirming === id}
            <div role="alertdialog" aria-label="Confirm forget" data-testid="memory-confirm">
              <p>Forget this memory? This cannot be undone.</p>
              <!-- svelte-ignore a11y_autofocus -->
              <button type="button" autofocus onclick={() => cancel(id)}>
                Cancel
              </button>
              <button
                type="button"
                disabled={inflight !== null}
                onclick={() => confirm(id)}
              >
                Forget memory
              </button>
            </div>
          {:else}
            <button
              type="button"
              data-forget={id}
              aria-label={`Forget: ${e.claim ?? id}`}
              onclick={() => (confirming = id)}
            >
              Forget
            </button>
          {/if}

          {#if failed[id]}
            <p role="alert">
              Forget failed. The memory is still stored. Try again.
            </p>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</section>

<style>
  section[data-testid="memory-list"] {
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
  [data-testid="memory-loading"],
  [data-testid="memory-stale"] {
    margin: 0;
    padding: var(--splyce-space-2, 0.5rem);
    background: rgba(180, 83, 9, 0.06);
    border-radius: var(--radius-md, 6px);
    color: var(--splyce-status-warning, #b45309);
    font-size: var(--splyce-font-size-xs, 0.75rem);
    font-weight: 500;
  }
  [data-testid="memory-error"] {
    margin: 0;
    padding: var(--splyce-space-2, 0.5rem);
    background: rgba(185, 28, 28, 0.08);
    border: 1px solid var(--splyce-status-danger, #b91c1c);
    border-radius: var(--radius-md, 6px);
    color: var(--splyce-status-danger, #b91c1c);
    font-size: var(--splyce-font-size-sm, 0.875rem);
    font-weight: 500;
  }
  [data-testid="memory-empty"] {
    margin: 0;
    color: var(--splyce-text-muted, #6b7280);
    font-size: var(--splyce-font-size-sm, 0.875rem);
    font-style: italic;
  }
  ul {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: var(--splyce-space-2, 0.5rem);
  }
  [data-testid="memory-item"] {
    display: flex;
    flex-direction: column;
    gap: var(--splyce-space-2, 0.5rem);
    padding: var(--splyce-space-3, 0.75rem);
    background: var(--splyce-surface, #ffffff);
    border: 1px solid var(--splyce-border-subtle, #f3f4f6);
    border-radius: var(--radius-md, 6px);
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.03);
    transition: border-color 0.15s ease;
  }
  [data-testid="memory-item"] p {
    margin: 0;
    font-size: var(--splyce-font-size-sm, 0.875rem);
    font-weight: 500;
    color: var(--splyce-text-primary, #111827);
    line-height: 1.4;
  }
  dl {
    display: grid;
    grid-template-columns: minmax(70px, max-content) 1fr;
    row-gap: var(--splyce-space-1, 0.25rem);
    column-gap: var(--splyce-space-2, 0.5rem);
    margin: 0;
    font-size: var(--splyce-font-size-xs, 0.75rem);
  }
  dt {
    color: var(--splyce-text-secondary, #4b5563);
    font-weight: 500;
  }
  dd {
    margin: 0;
    color: var(--splyce-text-primary, #111827);
  }
  [data-testid="memory-locality"] {
    font-weight: 600;
    color: var(--splyce-text-secondary, #4b5563);
  }
  [data-testid="memory-purge"] {
    margin: 0;
    padding: var(--splyce-space-1, 0.25rem) var(--splyce-space-2, 0.5rem);
    font-size: var(--splyce-font-size-xs, 0.75rem);
    color: var(--splyce-status-warning, #b45309);
    background: rgba(180, 83, 9, 0.08);
    border-radius: var(--radius-md, 4px);
    font-weight: 500;
  }
  [data-testid="memory-confirm"] {
    display: flex;
    flex-direction: column;
    gap: var(--splyce-space-2, 0.5rem);
    padding: var(--splyce-space-2, 0.5rem);
    background: rgba(185, 28, 28, 0.04);
    border: 1px solid rgba(185, 28, 28, 0.2);
    border-radius: var(--radius-md, 6px);
    margin-top: var(--splyce-space-1, 0.25rem);
  }
  [data-testid="memory-confirm"] p {
    margin: 0;
    font-size: var(--splyce-font-size-xs, 0.75rem);
    color: var(--splyce-status-danger, #b91c1c);
    font-weight: 500;
  }
  button {
    font-family: inherit;
    font-size: var(--splyce-font-size-xs, 0.75rem);
    font-weight: 600;
    border-radius: var(--radius-md, 4px);
    cursor: pointer;
    transition: background-color 0.15s ease, opacity 0.15s ease;
  }
  button[data-forget] {
    align-self: flex-start;
    padding: 3px 10px;
    color: var(--splyce-text-secondary, #4b5563);
    background: transparent;
    border: 1px solid var(--splyce-border-default, #d1d5db);
  }
  button[data-forget]:hover {
    background: rgba(185, 28, 28, 0.06);
    color: var(--splyce-status-danger, #b91c1c);
    border-color: var(--splyce-status-danger, #b91c1c);
  }
  [data-testid="memory-confirm"] button {
    padding: 4px 12px;
  }
  [data-testid="memory-confirm"] button:first-of-type {
    background: transparent;
    color: var(--splyce-text-primary, #111827);
    border: 1px solid var(--splyce-border-default, #d1d5db);
  }
  [data-testid="memory-confirm"] button:last-of-type {
    background: var(--splyce-status-danger, #b91c1c);
    color: #ffffff;
    border: 1px solid transparent;
  }
  [data-testid="memory-confirm"] button:last-of-type:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  button:focus-visible {
    outline: 2px solid var(--focus, #2563eb);
    outline-offset: 2px;
  }
  [role="alert"]:not([data-testid]) {
    margin: var(--splyce-space-1, 0.25rem) 0 0;
    font-size: var(--splyce-font-size-xs, 0.75rem);
    color: var(--splyce-status-danger, #b91c1c);
    font-weight: 500;
  }
</style>
