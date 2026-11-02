<script lang="ts">
  /**
   * The one presentation of an approval request's target.
   *
   * ApprovalCard (TD-18, the inline prompt in the turn stream) and
   * ApprovalDialog (TD-30, the modal decision surface) both render this, so the
   * capability, target, scope, run/action identity and risk rationale cannot
   * drift between the inline and the modal prompt. It shows only what the
   * engine sent: this component decides nothing and causes no effect.
   */
  import type { EventPayloads } from "@splyce/pi/contracts";
  import { redactToolText } from "../tool-view";

  type ApprovalRequestedPayload = EventPayloads["approval.requested"];

  let {
    request,
    target = undefined,
    argsSummary = undefined,
    riskId = undefined,
  }: {
    request: ApprovalRequestedPayload;
    /** Exact intent target, when an inline caller has it. */
    target?: string;
    /** Requested arguments, when an inline caller has them. */
    argsSummary?: string;
    /** Id for the rationale, so an enclosing dialog can use it as its description. */
    riskId?: string;
  } = $props();

  let exactTarget = $derived(target ? redactToolText(target) : "");
  let requestedArgs = $derived(
    argsSummary ? redactToolText(argsSummary) : "",
  );
  let showsExactTarget = $derived(
    exactTarget !== "" && exactTarget !== request.normalizedTarget,
  );
</script>

<p id={riskId} class="rationale" data-testid="approval-risk">
  {request.riskRationale}
</p>

<dl class="kv-list" data-testid="approval-target">
  <dt>Capability</dt>
  <dd data-testid="approval-capability">{request.capabilityId}</dd>
  {#if showsExactTarget}
    <dt>Requested target</dt>
    <dd data-testid="approval-requested-target">{exactTarget}</dd>
  {/if}
  <dt>{showsExactTarget ? "Normalized target" : "Target"}</dt>
  <dd data-testid="approval-normalized-target">{request.normalizedTarget}</dd>
  {#if requestedArgs}
    <dt>Requested arguments</dt>
    <dd class="args" data-testid="approval-arguments">{requestedArgs}</dd>
  {/if}
  <dt>Scope</dt>
  <dd>{request.targetScope}</dd>
  <dt>Run / action</dt>
  <dd>{request.runId} / {request.actionId}</dd>
  <dt>Request</dt>
  <dd>{request.approvalRequestId}</dd>
</dl>

<style>
  .rationale {
    font-size: 0.875rem;
    color: var(--text-secondary, #4b5563);
    margin: 8px 0 12px;
  }
  .kv-list {
    display: grid;
    grid-template-columns: 120px 1fr;
    gap: 4px 8px;
    font-size: 0.8125rem;
    margin: 8px 0 16px;
  }
  .kv-list dt {
    color: var(--text-muted, #6b7280);
  }
  .kv-list dd {
    font-family: monospace;
    margin: 0;
    overflow-wrap: anywhere;
  }
  .kv-list dd.args {
    white-space: pre-wrap;
  }
</style>
