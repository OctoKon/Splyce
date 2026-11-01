<script lang="ts">
  /**
   * TD-30 permission-mode selector (U1_permission_mode).
   *
   * The selector never changes the mode by itself: it asks the store for a
   * request, reports the requested mode to the caller (which submits the
   * command) and keeps the effective mode visible until the engine
   * acknowledges it. A bypass-class mode opens a separate native-dialog
   * confirmation whose default and Escape path keep the current mode, and the
   * engine-unavailable state is shown as a blocking reason rather than silently
   * doing nothing.
   */
  import { tick } from "svelte";
  import {
    PERMISSION_MODE_LABELS,
    confirmationInvalidReason,
    confirmPermissionMode,
    modeConfirmation,
    permissionModeView,
    requestPermissionMode,
    type ModeConfirmation,
    type PermissionMode,
    type PermissionModeContext,
    type PermissionModeState,
  } from "../stores/permission-mode";

  interface Props {
    modeState: PermissionModeState;
    context: PermissionModeContext;
    /** Called only with a mode the store agrees may be requested. */
    onChange?: (mode: PermissionMode) => void;
    /** Optional announcement of a dismissed bypass confirmation. */
    onDismissConfirm?: () => void;
  }

  let {
    modeState,
    context,
    onChange = () => {},
    onDismissConfirm = () => {},
  }: Props = $props();

  const view = $derived(permissionModeView(modeState));
  const ready = $derived(context.engine === "ready");
  const blockedReason = $derived(
    ready
      ? null
      : (context.engineReason ?? "Engine unavailable; the mode cannot be changed."),
  );
  const selected = $derived(
    modeState.status === "pending" && modeState.requested
      ? modeState.requested
      : modeState.effective,
  );

  let pending = $state<ModeConfirmation | null>(null);
  let notice = $state<string | null>(null);
  let dialog = $state<HTMLDialogElement>();
  let keepButton = $state<HTMLButtonElement>();
  let selectEl = $state<HTMLSelectElement>();

  // The confirmation is only an answer to the exact session/revisions it was
  // opened under. If any of those (or the engine) changes, it is dead: the
  // dialog closes and no mode can be requested from it.
  const pendingInvalidation = $derived(
    pending ? confirmationInvalidReason(modeState, pending, context) : null,
  );

  // Opening is done after the dialog's content exists, and the safe control
  // takes focus so Enter cannot enable bypass by accident.
  $effect(() => {
    if (!pending) return;
    if (dialog && !dialog.open) {
      dialog.showModal();
      void tick().then(() => keepButton?.focus());
    }
  });

  $effect(() => {
    const reason = pendingInvalidation;
    if (!pending || reason === null) return;
    invalidate(reason);
  });

  function invalidate(reason: string) {
    pending = null;
    notice = reason;
    if (dialog?.open) dialog.close();
    resetSelect();
    onDismissConfirm();
    void tick().then(() => selectEl?.focus());
  }

  function choose(mode: PermissionMode) {
    notice = null;
    if (!ready) {
      notice = blockedReason;
      resetSelect();
      return;
    }
    if (mode === modeState.effective) return;
    const request = requestPermissionMode(modeState, mode, context);
    if (request.kind === "blocked") {
      notice = request.reason;
      resetSelect();
      return;
    }
    if (request.kind === "confirm") {
      pending = modeConfirmation(modeState, mode, context);
      return;
    }
    // The requested mode is not effective yet: show the engine-acknowledged
    // value until the caller reports the pending state.
    resetSelect();
    onChange(mode);
  }

  /** Puts the native control back on the mode the engine still reports. */
  function resetSelect() {
    if (selectEl) selectEl.value = selected;
  }

  function onSelect(event: Event) {
    choose((event.currentTarget as HTMLSelectElement).value as PermissionMode);
  }

  function cancelConfirm() {
    pending = null;
    if (dialog?.open) dialog.close();
    resetSelect();
    onDismissConfirm();
    void tick().then(() => selectEl?.focus());
  }

  function acceptConfirm() {
    const confirmation = pending;
    if (!confirmation) return;
    // Re-validated against the CURRENT state, not the state at open: a stale
    // render or a same-tick context change cannot request the mode.
    const result = confirmPermissionMode(modeState, confirmation, context);
    pending = null;
    if (dialog?.open) dialog.close();
    if (result.kind === "invalidated") {
      notice = result.reason;
      resetSelect();
      onDismissConfirm();
      void tick().then(() => selectEl?.focus());
      return;
    }
    onChange(confirmation.mode);
  }

  function oncancel(event: Event) {
    // Escape keeps the current mode; it never enables the dangerous one.
    event.preventDefault();
    cancelConfirm();
  }
</script>

<div class="mode-select" data-testid="permission-mode">
  <label for="permission-mode-select">Permission mode</label>
  <select
    id="permission-mode-select"
    bind:this={selectEl}
    value={selected}
    disabled={!ready}
    onchange={onSelect}
    data-testid="permission-mode-select"
  >
    {#each view.options as option (option.mode)}
      <option value={option.mode}>
        {option.label}{option.dangerous ? " — needs confirmation" : ""}
      </option>
    {/each}
  </select>

  <p data-testid="permission-effective">
    Effective: <strong>{view.effectiveLabel}</strong>
  </p>
  {#if view.pendingLabel}
    <p data-testid="permission-pending" class="pending">
      {view.pendingLabel} — not effective until the engine acknowledges it.
    </p>
  {/if}
  {#if view.rejectedReason}
    <p role="alert" class="reason" data-testid="permission-rejected">
      {view.rejectedReason} The previous mode is still effective.
    </p>
  {/if}
  {#if blockedReason}
    <p role="alert" class="reason" data-testid="permission-blocked">
      {blockedReason}
    </p>
  {/if}
  {#if notice}
    <p role="status" class="reason" data-testid="permission-notice">{notice}</p>
  {/if}

  <p
    class="announcement"
    aria-live="polite"
    data-testid="permission-announcement"
  >
    {view.announcement ?? ""}
  </p>
</div>

<dialog
  bind:this={dialog}
  {oncancel}
  aria-labelledby="permission-confirm-title"
  aria-describedby="permission-confirm-body"
  data-testid="permission-confirm"
>
  {#if pending}
    <h2 id="permission-confirm-title">
      Enable {PERMISSION_MODE_LABELS[pending.mode]}?
    </h2>
    <p id="permission-confirm-body">
      {PERMISSION_MODE_LABELS[pending.mode]} removes approval prompts for this
      session. This is a separate, explicit choice and it applies to this session
      only. The safe choice keeps {view.effectiveLabel}.
    </p>
    <div class="actions">
      <button
        bind:this={keepButton}
        type="button"
        onclick={cancelConfirm}
        data-testid="permission-keep"
      >
        Keep {view.effectiveLabel}
      </button>
      <button
        type="button"
        class="danger"
        disabled={pendingInvalidation !== null}
        title={pendingInvalidation ?? undefined}
        onclick={acceptConfirm}
        data-testid="permission-confirm-bypass"
      >
        Enable {PERMISSION_MODE_LABELS[pending.mode]}
      </button>
    </div>
  {/if}
</dialog>

<style>
  .mode-select {
    display: grid;
    gap: var(--splyce-space-1, 0.25rem);
    max-width: 420px;
    color: var(--splyce-text-primary, #111827);
  }
  label {
    font-weight: 600;
    font-size: var(--splyce-font-size-sm, 0.875rem);
    color: var(--splyce-text-secondary, #4b5563);
  }
  select {
    font-family: inherit;
    font-size: var(--splyce-font-size-sm, 0.875rem);
    padding: var(--splyce-space-1, 0.25rem) var(--splyce-space-2, 0.5rem);
    border: 1px solid var(--splyce-border-default, #d1d5db);
    border-radius: var(--radius-md, 6px);
    background: var(--splyce-surface, #ffffff);
    color: inherit;
    cursor: pointer;
    transition: border-color 0.15s ease;
  }
  select:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
  p {
    margin: 0;
    font-size: var(--splyce-font-size-sm, 0.875rem);
  }
  .pending {
    color: var(--splyce-status-warning, #92400e);
    font-weight: 500;
  }
  .reason {
    color: var(--splyce-status-danger, #b91c1c);
    font-weight: 500;
  }
  .announcement {
    min-height: 1em;
  }
  dialog {
    max-width: 460px;
    border: 1px solid var(--splyce-border-default, #e5e7eb);
    border-radius: var(--radius-md, 8px);
    padding: 20px;
    background: var(--splyce-surface-raised, #ffffff);
    color: var(--splyce-text-primary, #111827);
    box-shadow: 0 10px 25px rgba(0, 0, 0, 0.15);
  }
  dialog::backdrop {
    background: rgba(17, 24, 39, 0.45);
  }
  .actions {
    display: flex;
    gap: var(--splyce-space-2, 0.5rem);
    margin-top: 16px;
  }
  button {
    font-family: inherit;
    font-size: var(--splyce-font-size-sm, 0.875rem);
    padding: 6px 14px;
    border: 1px solid var(--splyce-border-default, #d1d5db);
    border-radius: var(--radius-md, 6px);
    background: var(--splyce-surface, #ffffff);
    color: inherit;
    cursor: pointer;
    transition:
      background-color 0.15s ease,
      opacity 0.15s ease;
  }
  button:hover {
    background: var(--splyce-surface-raised, #f3f4f6);
  }
  .danger {
    border-color: var(--splyce-status-danger, #b91c1c);
    color: var(--splyce-status-danger, #b91c1c);
    font-weight: 600;
  }
  .danger:hover {
    background: rgba(185, 28, 28, 0.08);
  }
  button:focus-visible,
  select:focus-visible {
    outline: 2px solid var(--focus, #2563eb);
    outline-offset: 2px;
  }
</style>
