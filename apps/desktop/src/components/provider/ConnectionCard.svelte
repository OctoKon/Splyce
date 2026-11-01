<script lang="ts">
  import type { ConnectionView } from "../../stores/profiles";

  let { connection }: { connection: ConnectionView } = $props();
  const label: Record<ConnectionView["credential"], string> = {
    configured: "Configured",
    missing: "Missing",
    unavailable: "Unavailable",
  };
</script>

<li class="connection" data-state={connection.state} data-testid="connection">
  <h4 id={`conn-${connection.id}`}>{connection.displayName}</h4>
  <dl aria-labelledby={`conn-${connection.id}`}>
    <dt>Endpoint</dt>
    <dd>{connection.endpointHost ?? "Unavailable"}</dd>
    <dt>Data destination</dt>
    <dd>{connection.egress}</dd>
    <dt>Locality</dt>
    <dd>{connection.locality === "local" ? "Local" : "Cloud"}</dd>
    <dt>Credential</dt>
    <dd><span class="credential-badge" data-credential={connection.credential}>{label[connection.credential]}</span></dd>
    <dt>Revision</dt>
    <dd>{connection.revision}</dd>
  </dl>
  {#if connection.error}
    <p role="alert" class="error">Unavailable: {connection.error}</p>
  {/if}
</li>

<style>
  .connection {
    display: flex;
    flex-direction: column;
    gap: var(--splyce-space-2, 0.5rem);
    padding: var(--splyce-space-3, 0.75rem);
    margin: var(--splyce-space-2, 0.5rem) 0;
    list-style: none;
    background: var(--splyce-surface-raised, #ffffff);
    border: 1px solid var(--splyce-border-default, #e5e7eb);
    border-radius: var(--radius-md, 8px);
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.04);
    transition: border-color 0.15s ease;
  }
  .connection[data-state="unavailable"] {
    border-left: 4px solid var(--splyce-status-danger, #b91c1c);
  }
  h4 {
    margin: 0;
    font-size: var(--splyce-font-size-base, 1rem);
    font-weight: 600;
    color: var(--splyce-text-primary, #111827);
  }
  dl {
    display: grid;
    grid-template-columns: minmax(130px, max-content) 1fr;
    row-gap: var(--splyce-space-1, 0.25rem);
    column-gap: var(--splyce-space-3, 0.75rem);
    margin: var(--splyce-space-1, 0.25rem) 0 0;
    font-size: var(--splyce-font-size-sm, 0.875rem);
    line-height: var(--splyce-line-height-normal, 1.4);
  }
  dt {
    color: var(--splyce-text-secondary, #4b5563);
    font-weight: 500;
  }
  dd {
    margin: 0;
    color: var(--splyce-text-primary, #111827);
    overflow-wrap: anywhere;
  }
  .credential-badge {
    display: inline-block;
    padding: 1px var(--splyce-space-2, 0.5rem);
    font-size: var(--splyce-font-size-xs, 0.75rem);
    border-radius: 999px;
    border: 1px solid var(--splyce-border-default, #e5e7eb);
    font-weight: 500;
  }
  .credential-badge[data-credential="configured"] {
    color: var(--splyce-status-success, #047857);
    border-color: var(--splyce-status-success, #047857);
    background: rgba(4, 120, 87, 0.06);
  }
  .credential-badge[data-credential="missing"] {
    color: var(--splyce-status-warning, #b45309);
    border-color: var(--splyce-status-warning, #b45309);
    background: rgba(180, 83, 9, 0.06);
  }
  .credential-badge[data-credential="unavailable"] {
    color: var(--splyce-status-danger, #b91c1c);
    border-color: var(--splyce-status-danger, #b91c1c);
    background: rgba(185, 28, 28, 0.06);
  }
  .error {
    margin: var(--splyce-space-2, 0.5rem) 0 0;
    padding: var(--splyce-space-2, 0.5rem) var(--splyce-space-3, 0.75rem);
    background: rgba(185, 28, 28, 0.08);
    border: 1px solid var(--splyce-status-danger, #b91c1c);
    border-radius: var(--radius-md, 6px);
    color: var(--splyce-status-danger, #b91c1c);
    font-size: var(--splyce-font-size-sm, 0.875rem);
    font-weight: 600;
  }
</style>
