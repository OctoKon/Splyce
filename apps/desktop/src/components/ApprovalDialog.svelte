<script lang="ts">
  /**
   * TD-30 approval dialog (D3_approval_revision, FUI-W5).
   *
   * A native <dialog> is used deliberately: it gives the modal focus trap and
   * Escape handling without adding a dependency (so no Bits UI
   * qualification-register row is needed). The default focus is the
   * non-destructive control, so Enter cannot approve a target by accident.
   *
   * The dialog never decides anything itself: it asks the approval store for the
   * current blockers and submits only the exact payload that store builds. Close
   * and Escape dismiss without approving, and no effect runs from this component.
   */
  import { onMount, tick } from "svelte";
  import ApprovalSummary from "./ApprovalSummary.svelte";
  import {
    approvalBlockers,
    approvalDecisionState,
    approvalResponse,
    type ApprovalContext,
    type ApprovalDismissCause,
    type ApprovalRequestView,
    type ApprovalResponsePayload,
  } from "../stores/approvals";

  interface Props {
    request: ApprovalRequestView;
    context: ApprovalContext;
    /** Receives only a payload the store validated. */
    onRespond?: (payload: ApprovalResponsePayload) => void;
    /**
     * Dismissal (Escape or Close): never an approval. The cause is what this
     * dialog observed, so a caller never has to guess it from the run state.
     */
    onDismiss?: (cause: ApprovalDismissCause) => void;
  }

  let { request, context, onRespond = () => {}, onDismiss = () => {} }: Props =
    $props();

  let dialog = $state<HTMLDialogElement>();
  let denyButton = $state<HTMLButtonElement>();
  let submitted = $state<ApprovalResponsePayload | null>(null);
  let rejection = $state<string | null>(null);
  let decided = $state(false);
  let opener: Element | null = null;

  const blockers = $derived(approvalBlockers(request, context));
  const inert = $derived(blockers.length > 0);
  const approve = $derived(approvalDecisionState(request, context, "approve"));
  const deny = $derived(approvalDecisionState(request, context, "deny"));

  onMount(() => {
    opener = document.activeElement;
    // A request whose run is already canceled must not open a dead modal. The
    // effect below still reports the dismissal so the surface stops showing it.
    if (!context.runCanceled) {
      dialog?.showModal();
      void tick().then(() => denyButton?.focus());
    }
    return () => {
      if (dialog?.open) dialog.close();
      // Restore focus to the control that opened the dialog, if it still exists.
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  });

  // A canceled run can no longer accept a decision, so keeping a modal open
  // would ask the user to answer a question that no longer exists. Close it,
  // return focus to where it came from, and report the dismissal as the run's
  // doing. A decision already submitted stays visible instead: its own outcome
  // is still pending, and the user closing that prompt later is a user action.
  let runEnded = false;
  $effect(() => {
    if (!context.runCanceled || runEnded || submitted !== null) return;
    runEnded = true;
    if (dialog?.open) dialog.close();
    if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    onDismiss("canceled");
  });

  function submit(decision: "approve" | "deny") {
    // The request is one-use: a second activation that lands before the re-render
    // must not submit a second decision for the same target.
    if (decided) return;
    const result = approvalResponse(request, context, decision);
    if (!result.ok) {
      rejection = result.reason;
      return;
    }
    decided = true;
    rejection = null;
    submitted = result.payload;
    onRespond(result.payload);
  }

  function dismiss(cause: ApprovalDismissCause) {
    if (dialog?.open) dialog.close();
    onDismiss(cause);
  }

  function oncancel(event: Event) {
    // Escape closes the prompt; it is the person's own dismissal and must never
    // approve or submit a decision.
    event.preventDefault();
    dismiss("user");
  }
</script>

<dialog
  bind:this={dialog}
  {oncancel}
  aria-labelledby="approval-title"
  aria-describedby="approval-risk"
  data-testid="approval-dialog"
  data-inert={inert ? "true" : "false"}
>
  <h2 id="approval-title">{submitted ? "Approval submitted" : "Approval required"}</h2>

  <ApprovalSummary request={request.request} riskId="approval-risk" />

  {#if submitted}
    <p role="status" data-testid="approval-submitted">
      Decision submitted for action <code>{submitted.actionId}</code>. Nothing is
      shown as executed until the engine reports the outcome.
    </p>
    <div class="actions">
      <button
        type="button"
        onclick={() => dismiss("user")}
        data-testid="approval-close"
      >
        Close
      </button>
    </div>
  {:else}
    {#if inert}
      <div class="banner" role="alert" data-testid="approval-inert">
        <p>This request can no longer be approved:</p>
        <ul>
          {#each blockers as blocker (blocker)}
            <li>{blocker}</li>
          {/each}
        </ul>
      </div>
    {/if}

    {#if rejection}
      <p role="alert" data-testid="approval-rejection">{rejection}</p>
    {/if}

    <div class="actions">
      <button
        type="button"
        bind:this={denyButton}
        disabled={!deny.enabled}
        title={deny.reason ?? undefined}
        onclick={() => submit("deny")}
        data-testid="approval-deny"
      >
        Deny
      </button>
      <button
        type="button"
        disabled={!approve.enabled}
        title={approve.reason ?? undefined}
        aria-describedby={approve.reason ? "approval-approve-reason" : undefined}
        onclick={() => submit("approve")}
        data-testid="approval-approve"
      >
        Approve once
      </button>
      <button
        type="button"
        onclick={() => dismiss("user")}
        data-testid="approval-dismiss"
      >
        {inert ? "Close" : "Cancel"}
      </button>
    </div>
    {#if approve.reason}
      <p id="approval-approve-reason" role="status" data-testid="approval-approve-reason">
        {approve.reason}
      </p>
    {/if}
  {/if}
</dialog>

<style>
  dialog {
    max-width: 560px;
    border: 1px solid #e5e7eb;
    border-radius: 8px;
    padding: 20px;
    background: #ffffff;
    color: #111827;
  }
  dialog::backdrop {
    background: rgb(17 24 39 / 45%);
  }
  .banner {
    border: 1px solid #fcd34d;
    background: #fffbeb;
    color: #78350f;
    padding: 8px 12px;
    margin: 12px 0;
  }
  .actions {
    display: flex;
    gap: 8px;
    margin-top: 16px;
  }
  [role="alert"] {
    color: #991b1b;
  }
</style>
