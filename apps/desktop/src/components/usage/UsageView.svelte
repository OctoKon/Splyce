<script lang="ts" module>
  /** The feed's state. `ready` means whatever `usage` says is current. */
  export type UsageStatus = "ready" | "loading" | "error" | "unavailable";
</script>

<script lang="ts">
  import { usageRows, type UsageInput } from "./usage";

  /**
   * TD-76: the usage screen says which of these it is instead of rendering an
   * empty region. `null` usage used to render nothing at all, so "the engine
   * has not reported yet", "the feed failed" and "this run has no usage" all
   * looked identical - and a blank space reads as zero.
   */
  let {
    usage = null,
    status = "ready",
  }: {
    usage?: UsageInput | null;
    /** The feed's state, never inferred from `usage` being absent. */
    status?: UsageStatus;
  } = $props();

  const rows = $derived(usage ? usageRows(usage) : []);
</script>

<section
  class="usage"
  aria-label="Usage"
  aria-busy={status === "loading" ? "true" : undefined}
  data-testid="usage-view"
  data-state={status}
>
  {#if status === "loading"}
    <p role="status" data-testid="usage-loading">Loading usage…</p>
  {:else if status === "error"}
    <p role="alert" data-testid="usage-error">
      Usage could not be loaded - not zero.
    </p>
  {:else if status === "unavailable"}
    <p data-testid="usage-unavailable-note">
      Usage unavailable - no engine usage report.
    </p>
  {:else if usage === null}
    <p data-testid="usage-not-reported">
      Usage was not reported for this run - not zero.
    </p>
  {:else if rows.length === 0}
    <p data-testid="usage-unavailable">Usage unavailable - not zero.</p>
  {:else}
    <p class="semantics" data-testid="usage-semantics">
      {usage.semantics === "estimated" ? "Estimated usage" : "Reported usage"}
    </p>
    <dl>
      {#each rows as row (row.label)}
        <dt>{row.label}</dt>
        <dd>{row.value}</dd>
      {/each}
    </dl>
  {/if}
</section>

<style>
  section.usage {
    display: flex;
    flex-direction: column;
    gap: var(--splyce-space-2, 0.5rem);
    padding: var(--splyce-space-3, 0.75rem);
    background: var(--splyce-surface-raised, #ffffff);
    border: 1px solid var(--splyce-border-default, #e5e7eb);
    border-radius: var(--radius-md, 8px);
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.04);
  }
  [data-testid="usage-loading"] {
    margin: 0;
    padding: var(--splyce-space-2, 0.5rem);
    background: rgba(180, 83, 9, 0.06);
    border-radius: var(--radius-md, 6px);
    color: var(--splyce-status-warning, #b45309);
    font-size: var(--splyce-font-size-xs, 0.75rem);
    font-weight: 500;
  }
  [data-testid="usage-error"] {
    margin: 0;
    padding: var(--splyce-space-2, 0.5rem);
    background: rgba(185, 28, 28, 0.08);
    border: 1px solid var(--splyce-status-danger, #b91c1c);
    border-radius: var(--radius-md, 6px);
    color: var(--splyce-status-danger, #b91c1c);
    font-size: var(--splyce-font-size-sm, 0.875rem);
    font-weight: 500;
  }
  [data-testid="usage-unavailable-note"],
  [data-testid="usage-not-reported"],
  [data-testid="usage-unavailable"] {
    margin: 0;
    color: var(--splyce-text-muted, #6b7280);
    font-size: var(--splyce-font-size-sm, 0.875rem);
    font-style: italic;
  }
  .semantics {
    margin: 0;
    font-size: var(--splyce-font-size-xs, 0.75rem);
    font-weight: 600;
    color: var(--splyce-text-secondary, #4b5563);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  dl {
    display: grid;
    grid-template-columns: minmax(120px, max-content) 1fr;
    row-gap: var(--splyce-space-1, 0.25rem);
    column-gap: var(--splyce-space-3, 0.75rem);
    margin: var(--splyce-space-1, 0.25rem) 0 0;
    padding: var(--splyce-space-2, 0.5rem);
    background: var(--splyce-surface, #ffffff);
    border: 1px solid var(--splyce-border-subtle, #f3f4f6);
    border-radius: var(--radius-md, 6px);
    font-size: var(--splyce-font-size-sm, 0.875rem);
  }
  dt {
    color: var(--splyce-text-secondary, #4b5563);
    font-weight: 500;
  }
  dd {
    margin: 0;
    color: var(--splyce-text-primary, #111827);
    font-family: var(
      --splyce-font-family-mono,
      "Cascadia Code",
      Consolas,
      monospace
    );
    font-weight: 600;
  }
</style>
