<script lang="ts">
  import type { EventPayloads } from "@splyce/pi/contracts";
  import ApprovalCard from "./ApprovalCard.svelte";
  import type { ApprovalView, ToolCallView } from "../stores/turns";
  import {
    redactToolText,
    toolActionLabel,
    toolErrorCopy,
    toolState,
  } from "../tool-view";

  type ApprovalDecision = "approve" | "deny";
  type ApprovalRequest = EventPayloads["approval.requested"];

  let {
    action,
    stale = false,
    showApprovalControls = true,
    canRespond = () => false,
    onApproval,
  }: {
    action: ToolCallView;
    stale?: boolean;
    showApprovalControls?: boolean;
    canRespond?: (actionId: string) => boolean;
    onApproval: (
      approvalRequestId: string,
      runId: string,
      actionId: string,
      decision: ApprovalDecision,
    ) => void;
  } = $props();

  let sending = $state<Record<string, ApprovalDecision>>({});
  let stateView = $derived(toolState(action));
  let label = $derived(toolActionLabel(action.capabilityId));
  let target = $derived(redactToolText(action.target) || "Target not reported.");
  let args = $derived(redactToolText(action.argsSummary));
  let error = $derived(toolErrorCopy(action.error));
  let outcomeRef = $derived(
    action.outcomeRef ? redactToolText(action.outcomeRef) : null,
  );
  let summary = $derived(action.summary);
  let preview = $derived(
    summary?.preview ? redactToolText(summary.preview) : null,
  );

  function approvalRequest(approval: ApprovalView): ApprovalRequest {
    return {
      approvalRequestId: approval.approvalRequestId,
      runId: approval.runId,
      actionId: approval.actionId,
      capabilityId: approval.capabilityId,
      targetScope: approval.targetScope,
      normalizedTarget: approval.normalizedTarget,
      riskRationale: approval.riskRationale,
      ...(approval.timeoutMs !== undefined
        ? { timeoutMs: approval.timeoutMs }
        : {}),
    };
  }

  function respond(decision: ApprovalDecision) {
    const approval = action.approval;
    if (
      !approval ||
      approval.state !== "requested" ||
      stale ||
      sending[approval.approvalRequestId] ||
      !canRespond(action.actionId)
    ) {
      return;
    }
    sending[approval.approvalRequestId] = decision;
    onApproval(
      approval.approvalRequestId,
      approval.runId,
      action.actionId,
      decision,
    );
  }

  function onApprovalKeydown(event: KeyboardEvent) {
    if (event.repeat) return;
    if (event.key === "Escape" || event.key === "n" || event.key === "N") {
      event.preventDefault();
      respond("deny");
    } else if (event.key === "y" || event.key === "Y") {
      event.preventDefault();
      respond("approve");
    }
  }

  function approvalKeys(node: HTMLElement) {
    node.addEventListener("keydown", onApprovalKeydown);
    return {
      destroy() {
        node.removeEventListener("keydown", onApprovalKeydown);
      },
    };
  }

  function focusDeny(node: HTMLElement) {
    node
      .querySelector<HTMLButtonElement>('[data-testid="approval-deny-button"]')
      ?.focus();
  }
</script>

<article
  class="tool"
  data-testid="tool-card"
  data-action-id={action.actionId}
  data-capability={action.capabilityId}
  data-status={stateView.status}
  aria-label={`${label}: ${target}`}
>
  <div class="tool-head">
    <div class="tool-identity">
      <span class="tool-action" data-testid="tool-action">{label}</span>
      <code class="capability">{action.capabilityId}</code>
    </div>
    <span
      class="tool-status"
      data-testid="tool-state"
      data-status={stateView.status}
      data-tone={stateView.tone}
    >
      {stateView.label}
    </span>
  </div>

  <p class="target" data-testid="tool-target">
    <span class="field-label">Target</span>
    <code>{target}</code>
  </p>

  {#if stateView.status === "running"}
    <p class="phase">Evidence: Pending - not executed</p>
  {/if}

  {#if args}
    <details class="args" data-testid="tool-arguments">
      <summary>Requested arguments</summary>
      <pre><code>{args}</code></pre>
    </details>
  {/if}

  {#if error.copy}
    <p class="tool-error" role="status" data-testid="tool-error">
      {error.copy}
      {#if error.code}<code class="error-code">{error.code}</code>{/if}
    </p>
  {/if}

  {#if outcomeRef}
    <p class="outcome">
      Outcome: <code>{outcomeRef}</code>
    </p>
  {/if}

  {#if summary && (summary.exitCode !== undefined || summary.durationMs !== undefined || summary.bytes !== undefined || summary.truncated)}
    <p class="summary" data-testid="tool-summary">
      {#if summary.exitCode !== undefined}
        <span>Exit code {summary.exitCode}</span>
      {/if}
      {#if summary.durationMs !== undefined}
        <span>{summary.durationMs} ms</span>
      {/if}
      {#if summary.bytes !== undefined}
        <span>{summary.bytes} bytes</span>
      {/if}
      {#if summary.truncated}
        <span data-testid="tool-truncated">Truncated</span>
      {/if}
    </p>
  {/if}

  {#if preview}
    <div class="preview-block">
      <span class="field-label">Output preview</span>
      <pre data-testid="tool-preview"><code>{preview}</code></pre>
    </div>
  {/if}

  {#if action.approval?.state === "requested" && showApprovalControls}
    {#if canRespond(action.actionId) && !stale}
      <div class="approval" use:approvalKeys use:focusDeny>
        <ApprovalCard
          request={approvalRequest(action.approval)}
          target={action.target}
          argsSummary={action.argsSummary}
          decision={sending[action.approval.approvalRequestId] ?? null}
          onRespond={respond}
        />
      </div>
    {:else}
      <p class="approval-closed" role="status">
        {stale
          ? "Approval closed - this request can no longer be answered."
          : "Approval controls are not available in this view."}
      </p>
    {/if}
  {/if}
</article>

<style>
  .tool {
    display: flex;
    flex-direction: column;
    gap: var(--splyce-space-2, 0.5rem);
    padding: var(--splyce-space-3, 0.75rem);
    border: 1px solid var(--splyce-border-default, #e5e7eb);
    border-radius: var(--splyce-space-2, 0.5rem);
    background: var(--splyce-surface-raised, #ffffff);
  }

  .tool-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--splyce-space-2, 0.5rem);
  }

  .tool-identity {
    display: flex;
    align-items: baseline;
    flex-wrap: wrap;
    gap: var(--splyce-space-2, 0.5rem);
    min-width: 0;
  }

  .tool-action {
    font-weight: 600;
    color: var(--splyce-text-primary, #111827);
  }

  .capability,
  .target code,
  .args code,
  .outcome code,
  .preview-block code,
  .error-code {
    font-family: var(
      --splyce-font-family-mono,
      "Cascadia Code",
      Consolas,
      monospace
    );
    font-size: var(--splyce-font-size-sm, 0.875rem);
    line-height: var(--splyce-line-height-mono, 1.4);
    overflow-wrap: anywhere;
  }

  .tool-status {
    flex: none;
    font-size: var(--splyce-font-size-xs, 0.75rem);
    padding: var(--splyce-space-1, 0.25rem) var(--splyce-space-2, 0.5rem);
    border-radius: 999px;
    border: 1px solid var(--splyce-border-default, #e5e7eb);
    color: var(--splyce-text-secondary, #4b5563);
  }

  .tool-status[data-status="running"] {
    color: var(--splyce-status-pending, #7c3aed);
    border-color: var(--splyce-status-pending, #7c3aed);
  }

  .tool-status[data-status="waiting-approval"],
  .tool-status[data-status="uncertain"] {
    color: var(--splyce-status-warning, #b45309);
    border-color: var(--splyce-status-warning, #b45309);
  }

  .tool-status[data-status="success"] {
    color: var(--splyce-status-success, #047857);
    border-color: var(--splyce-status-success, #047857);
  }

  .tool-status[data-status="error"],
  .tool-status[data-status="denied"] {
    color: var(--splyce-status-danger, #b91c1c);
    border-color: var(--splyce-status-danger, #b91c1c);
  }

  .target,
  .phase,
  .args,
  .outcome,
  .summary,
  .tool-error,
  .approval-closed {
    margin: 0;
    color: var(--splyce-text-secondary, #4b5563);
    font-size: var(--splyce-font-size-sm, 0.875rem);
  }

  .phase {
    color: var(--splyce-text-muted, #6b7280);
    font-size: var(--splyce-font-size-xs, 0.75rem);
  }

  .summary {
    display: flex;
    flex-wrap: wrap;
    gap: var(--splyce-space-2, 0.5rem);
    color: var(--splyce-text-muted, #6b7280);
    font-size: var(--splyce-font-size-xs, 0.75rem);
  }

  .preview-block {
    display: flex;
    flex-direction: column;
    gap: var(--splyce-space-1, 0.25rem);
  }

  .preview-block pre {
    margin: 0;
    padding: var(--splyce-space-2, 0.5rem);
    border: 1px solid var(--splyce-border-subtle, #f3f4f6);
    border-radius: 4px;
    background: var(--splyce-surface-sunken, #f9fafb);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .target {
    display: flex;
    align-items: baseline;
    flex-wrap: wrap;
    gap: var(--splyce-space-2, 0.5rem);
  }

  .field-label,
  .args summary {
    color: var(--splyce-text-muted, #6b7280);
    font-size: var(--splyce-font-size-xs, 0.75rem);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .args summary {
    cursor: pointer;
    padding: var(--splyce-space-1, 0.25rem) 0;
  }

  .args summary:focus-visible {
    outline: 2px solid var(--splyce-focus-ring, #2563eb);
    outline-offset: var(--splyce-focus-offset, 2px);
  }

  .args pre {
    margin: var(--splyce-space-1, 0.25rem) 0 0;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .tool-error {
    display: flex;
    align-items: baseline;
    flex-wrap: wrap;
    gap: var(--splyce-space-2, 0.5rem);
    color: var(--splyce-status-danger, #b91c1c);
  }

  .error-code {
    padding: 0 var(--splyce-space-1, 0.25rem);
    border: 1px solid currentColor;
    border-radius: 4px;
    font-size: var(--splyce-font-size-xs, 0.75rem);
  }

  .approval {
    display: flex;
    flex-direction: column;
  }

  .approval :global(.btn-approve:focus-visible),
  .approval :global(.btn-deny:focus-visible) {
    outline: 2px solid var(--splyce-focus-ring, #2563eb);
    outline-offset: var(--splyce-focus-offset, 2px);
  }

  .approval-closed {
    padding: var(--splyce-space-2, 0.5rem) var(--splyce-space-3, 0.75rem);
    border: 1px dashed var(--splyce-border-default, #e5e7eb);
    border-radius: var(--splyce-space-2, 0.5rem);
  }

  @media (prefers-reduced-motion: reduce) {
    * {
      transition: none;
    }
  }
</style>
