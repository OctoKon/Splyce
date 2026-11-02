<script lang="ts">
  import type { EventPayloads } from "@splyce/pi/contracts";
  import ApprovalSummary from "./ApprovalSummary.svelte";

  type ApprovalRequestedPayload = EventPayloads["approval.requested"];

  let {
    request,
    target = undefined,
    argsSummary = undefined,
    decision = null,
    onRespond,
  }: {
    request: ApprovalRequestedPayload;
    target?: string;
    argsSummary?: string;
    decision?: "approve" | "deny" | null;
    onRespond?: (decision: "approve" | "deny") => void;
  } = $props();
</script>

<div
  class="approval-card"
  class:resolved={decision !== null}
  role="dialog"
  aria-labelledby="approval-title"
  aria-describedby="approval-desc"
  data-testid="approval-card"
>
  <div class="card-header">
    <span class="badge" class:pending={decision === null} class:denied={decision === "deny"} class:approved={decision === "approve"}>
      {#if decision === null}
        Waiting for approval
      {:else if decision === "deny"}
        Denied · no effects executed
      {:else}
        Approved · executing action
      {/if}
    </span>
    <h3 id="approval-title">Approval Required: {request.capabilityId}</h3>
  </div>

  <ApprovalSummary {request} {target} {argsSummary} riskId="approval-desc" />

  {#if decision === null}
    <div class="card-actions">
      <button
        type="button"
        class="btn-approve"
        data-testid="approval-allow-button"
        aria-keyshortcuts="y"
        onclick={() => onRespond?.("approve")}
      >
        Allow once
      </button>
      <button
        type="button"
        class="btn-deny"
        data-testid="approval-deny-button"
        aria-keyshortcuts="n Escape"
        onclick={() => onRespond?.("deny")}
      >
        Deny
      </button>
    </div>
    <p class="key-hint">Keyboard: Y allow once · N or Esc deny</p>
  {:else}
    <div class="resolution-banner" class:denied={decision === "deny"}>
      <span>Resolved: {decision === "approve" ? "Approved" : "Denied"}</span>
    </div>
  {/if}
</div>

<style>
  .approval-card {
    border: 1px solid var(--border, #e5e7eb);
    border-radius: var(--radius-md, 8px);
    padding: 16px;
    background: var(--surface, #ffffff);
    margin: 12px 0;
  }
  .approval-card:not(.resolved) {
    border-color: var(--status-warning, #f59e0b);
  }
  .card-header h3 {
    margin: 8px 0 4px;
    font-size: 1rem;
    font-weight: 600;
  }
  .badge {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 4px;
    font-size: 0.75rem;
    font-weight: 500;
  }
  .badge.pending {
    background: rgba(245, 158, 11, 0.12);
    color: #b45309;
  }
  .badge.approved {
    background: rgba(16, 185, 129, 0.12);
    color: #047857;
  }
  .badge.denied {
    background: rgba(239, 68, 68, 0.12);
    color: #b91c1c;
  }
  .card-actions {
    display: flex;
    gap: 8px;
  }
  .key-hint {
    margin: 8px 0 0;
    color: var(--text-muted, #6b7280);
    font-size: 0.75rem;
  }
  .btn-approve,
  .btn-deny {
    padding: 6px 14px;
    border-radius: 4px;
    font-size: 0.875rem;
    font-weight: 500;
    cursor: pointer;
    border: 1px solid transparent;
  }
  .btn-approve {
    background: var(--primary, #0d0d0d);
    color: #ffffff;
  }
  .btn-deny {
    background: transparent;
    border-color: var(--border, #e5e7eb);
    color: var(--text-primary, #111827);
  }
  .resolution-banner {
    padding: 6px 12px;
    border-radius: 4px;
    font-size: 0.8125rem;
    font-weight: 500;
    background: rgba(16, 185, 129, 0.08);
    color: #047857;
  }
  .resolution-banner.denied {
    background: rgba(239, 68, 68, 0.08);
    color: #b91c1c;
  }
</style>
