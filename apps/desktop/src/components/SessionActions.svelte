<script lang="ts">
  /**
   * TD-33 session lifecycle actions (D4_session_resume_fork).
   *
   * Renders the typed reducer only: fork and resume hand the parent one
   * request, rewind asks for confirmation first, and nothing here fakes an
   * engine result. Cancelling a dispatched request is delivered to the parent
   * as an aborted signal and stays pending until the executor says it stopped.
   * Every control states why it is disabled, the position shown is the ancestry
   * the tree delivered, and the editor text captured at the start is handed
   * back so a cancel or failure can restore it.
   */
  import {
    REWIND_LIMITS,
    actionAvailability,
    createSessionActionState,
    forkPointLabel,
    newlyAdmittedRequest,
    reduceSessionAction,
    rewindChoiceAvailability,
    type RewindChoice,
    type SessionActionRequest,
    type SessionActionState,
    type SessionActionsContext,
    type SessionActionKind,
  } from "../stores/session-actions";
  import { tick } from "svelte";

  let {
    context,
    onRequest,
    onRestoreDraft,
  }: {
    context: SessionActionsContext;
    /**
     * The parent owns execution; the component never invokes the engine.
     *
     * The second argument is the cancellation channel: the component aborts it
     * when the user cancels an already-dispatched request. An executor that
     * honours the signal rejects with an `AbortError` (the DOM convention), and
     * only that answer lets the UI say the request stopped. An executor that
     * ignores the signal leaves the UI in the pending "cancel requested" state,
     * which claims nothing about the source. The component aborts only when the
     * user cancels: unmounting never aborts, because that would stop work the
     * user did not ask to stop.
     */
    onRequest?: (
      request: SessionActionRequest,
      signal: AbortSignal,
    ) => Promise<void> | void;
    /** Called with the captured editor text when an action settles. */
    onRestoreDraft?: (text: string) => void;
  } = $props();

  // Not named `state`: `$state` would read it as a store subscription.
  let current = $state.raw<SessionActionState>(createSessionActionState());
  let dialog: HTMLDialogElement | undefined = $state();
  let cancelButton: HTMLButtonElement | undefined = $state();
  let lastTrigger: HTMLElement | undefined;
  let cancelingStatus: HTMLElement | undefined = $state();
  let previousPhase: SessionActionState["phase"] = "idle";
  /** The controller for the request currently in flight, if any. */
  let inFlight: AbortController | null = null;

  /** The DOM cancellation convention: an honoured abort rejects this way. */
  const isAbortError = (error: unknown): boolean =>
    typeof error === "object" &&
    error !== null &&
    (error as { name?: unknown }).name === "AbortError";

  const availability = (kind: SessionActionKind) =>
    actionAvailability(context, current, kind);

  const resume = $derived(availability("resume"));
  const fork = $derived(availability("fork"));
  const rewind = $derived(availability("rewind"));
  const reasons = $derived(
    (
      [
        ["resume", resume],
        ["fork", fork],
        ["rewind", rewind],
      ] as const
    )
      .map(([kind, entry]) => ({ kind, entry }))
      .filter(({ entry }) => !entry.enabled && entry.reason),
  );
  const choice = $derived(current.choice ?? "conversation");
  const choiceAvailability = $derived(
    rewindChoiceAvailability(context, choice),
  );
  // While an action is open, show the ancestry it captured; at rest, show the
  // live selection the next action would use.
  const target = $derived(
    current.phase === "requesting" || current.phase === "confirming"
      ? current.target
      : context.selected,
  );
  const label = $derived(
    current.kind === null
      ? "the session"
      : current.kind === "resume"
        ? "the session"
        : current.kind === "fork"
          ? "the fork"
          : "the rewind",
  );

  const reasonId = (kind: SessionActionKind) => `session-action-${kind}-reason`;

  const send = (action: Parameters<typeof reduceSessionAction>[1]) => {
    current = reduceSessionAction(current, action, context);
    return current;
  };

  /**
   * Reduces an action and hands back ONLY the request that this transition
   * newly admitted. A refused transition (second activation while in flight)
   * returns null, so the executor is never asked twice for the same intent.
   */
  const issue = (
    action: Parameters<typeof reduceSessionAction>[1],
  ): SessionActionRequest | null => {
    const next = reduceSessionAction(current, action, context);
    const admitted = newlyAdmittedRequest(current, next);
    current = next;
    return admitted;
  };

  /**
   * Hands the captured editor text back only while the editor still holds what
   * it held when the action began. If the user typed after capture, their newer
   * text wins: a lifecycle result must never erase it.
   */
  function restore() {
    const preserved = current.preservedDraft;
    if (preserved === null || context.draft !== preserved) return;
    onRestoreDraft?.(preserved);
  }

  function focusTrigger() {
    lastTrigger?.focus();
  }

  async function run(request: SessionActionRequest) {
    if (!onRequest) {
      current = reduceSessionAction(
        current,
        { type: "failed", message: "No engine executor is connected." },
        context,
      );
      restore();
      focusTrigger();
      return;
    }
    // One request is in flight at a time (the reducer refuses a second), so one
    // controller is enough: it is the channel the user's cancel travels on.
    const controller = new AbortController();
    const signal = controller.signal;
    inFlight = controller;
    try {
      await onRequest(request, signal);
      send({ type: "succeeded" });
      restore();
    } catch (e) {
      if (signal.aborted && isAbortError(e)) {
        // The executor honoured the cancel: it reports the request stopped.
        send({ type: "stopped" });
      } else {
        send({
          type: "failed",
          message: e instanceof Error ? e.message : "The request failed.",
        });
      }
      restore();
    } finally {
      if (inFlight === controller) inFlight = null;
    }
    focusTrigger();
  }

  async function begin(
    kind: Exclude<SessionActionKind, "rewind">,
    event: MouseEvent,
  ) {
    lastTrigger = event.currentTarget as HTMLElement;
    const request = issue({ type: "begin", kind });
    if (request) await run(request);
  }

  async function beginRewind(event: MouseEvent) {
    lastTrigger = event.currentTarget as HTMLElement;
    issue({ type: "begin", kind: "rewind" });
  }

  function choose(next: RewindChoice) {
    send({ type: "choose", choice: next });
  }

  async function confirm() {
    const request = issue({ type: "confirm" });
    if (request) await run(request);
    // A refused confirmation leaves the dialog open: keep focus inside it.
  }

  function cancel() {
    const dispatched = current.phase === "requesting";
    send({ type: "cancel" });
    // Deliver the cancel to the executor. The reducer has already moved to the
    // pending state, so nothing here can claim the request stopped: only the
    // executor's AbortError does that.
    if (dispatched) inFlight?.abort();
    restore();
    // A dispatched request leaves every action disabled while its cancel is
    // pending, so the trigger cannot take focus. Put focus on the status that
    // explains why instead of dropping it on <body>.
    if (current.phase === "canceling") {
      void tick().then(() => cancelingStatus?.focus());
    } else {
      focusTrigger();
    }
  }

  $effect(() => {
    if (current.phase === "confirming") {
      // Focus and open only on the transition into confirming. Refocusing on
      // every later state change (choosing a scope, a refused confirmation)
      // would steal focus from the control the user is on.
      if (dialog && !dialog.open) {
        dialog.showModal();
        // The default focus is the non-destructive control.
        cancelButton?.focus();
      }
    } else if (dialog?.open) {
      dialog.close();
    }
  });

  $effect(() => {
    const phase = current.phase;
    const busy =
      previousPhase === "requesting" ||
      previousPhase === "canceling" ||
      previousPhase === "confirming";
    if (busy && phase !== "requesting" && phase !== "confirming" && phase !== "canceling") {
      lastTrigger?.focus();
    }
    previousPhase = phase;
  });
</script>

<section
  class="session-actions"
  aria-label="Session actions"
  data-testid="session-actions"
>
  <h2>Session actions</h2>
  <p class="target" data-testid="fork-point">
    {#if target && forkPointLabel(target)}
      Fork point: {forkPointLabel(target)}
    {:else}
      No branch selected
    {/if}
  </p>
  {#if target}
    <p class="leaves" data-testid="fork-leaves">
      Leaves: {target.leaves.length === 0
        ? "none"
        : target.leaves.join(", ")}
    </p>
  {/if}

  <div role="group" aria-label="Session lifecycle" class="buttons">
    <button
      type="button"
      data-testid="action-resume"
      disabled={!resume.enabled}
      aria-describedby={resume.enabled ? undefined : reasonId("resume")}
      onclick={(event) => void begin("resume", event)}
    >
      Resume
    </button>
    <button
      type="button"
      data-testid="action-fork"
      disabled={!fork.enabled}
      aria-describedby={fork.enabled ? undefined : reasonId("fork")}
      onclick={(event) => void begin("fork", event)}
    >
      Fork from here
    </button>
    <button
      type="button"
      data-testid="action-rewind"
      disabled={!rewind.enabled}
      aria-describedby={rewind.enabled ? undefined : reasonId("rewind")}
      onclick={(event) => void beginRewind(event)}
    >
      Rewind…
    </button>
  </div>

  <ul class="reasons" data-testid="action-reasons">
    {#each reasons as { kind, entry } (kind)}
      <li id={reasonId(kind)} data-reason={kind}>
        {kind === "resume" ? "Resume" : kind === "fork" ? "Fork" : "Rewind"} unavailable: {entry.reason}
      </li>
    {/each}
  </ul>

  {#if current.phase === "requesting"}
    <div class="outcome" role="status" data-testid="action-busy">
      <p>
        {#if current.kind === "resume"}
          Resuming the session…
        {:else}
          Requesting {label} at {forkPointLabel(current.target)}…
        {/if}
      </p>
      <button type="button" data-testid="action-cancel" onclick={cancel}>
        Cancel
      </button>
    </div>
  {:else if current.phase === "canceling"}
    <div
      class="outcome"
      role="status"
      tabindex="-1"
      bind:this={cancelingStatus}
      data-testid="action-canceling"
    >
      <p>
        Cancel requested. The {label} request was already sent and the engine has
        been asked to stop it; the source is not guaranteed unchanged until the
        engine confirms it stopped. Your draft is preserved.
      </p>
    </div>
  {:else if current.phase === "stopped"}
    <p class="outcome" role="status" data-testid="action-stopped">
      Stop confirmed: the engine reports the {label} request stopped. Anything it
      had already applied is not undone, so the source is not verified unchanged.
      Your draft is preserved.
    </p>
  {:else if current.phase === "canceled"}
    <p class="outcome" role="status" data-testid="action-canceled">
      {label === "the rewind" ? "Rewind" : label === "the fork" ? "Fork" : "Resume"}
      canceled before anything was requested. The source was left unchanged and
      your draft is preserved.
    </p>
  {:else if current.phase === "succeeded"}
    <p class="outcome" role="status" data-testid="action-succeeded">
      {#if current.canceledWhileRequesting}
        Your cancel request arrived too late: the engine reports this {label}{" "}
        completed, so the source may have changed. Your draft is preserved.
      {:else if current.kind === "rewind"}
        Rewind completed. The source conversation is kept as ancestry.
      {:else if current.kind === "fork"}
        Fork created from {forkPointLabel(current.target)}. Your draft is
        preserved.
      {:else}
        Session resumed. Your draft is preserved.
      {/if}
    </p>
  {:else if current.phase === "failed"}
    <p class="outcome outcome-error" role="alert" data-testid="action-failed">
      {label === "the rewind" ? "Rewind" : label === "the fork" ? "Fork" : "Resume"}
      failed{#if current.canceledWhileRequesting} after your cancel request{/if}:
      {current.error} Your draft is preserved.
    </p>
  {/if}

  {#if current.blocked && current.phase !== "confirming"}
    <p class="outcome" role="status" data-testid="action-blocked">
      {current.blocked}
    </p>
  {/if}
</section>

{#if current.phase === "confirming"}
  <dialog
    bind:this={dialog}
    class="rewind"
    aria-labelledby="rewind-title"
    aria-describedby="rewind-limits rewind-choice-reason"
    data-testid="rewind-dialog"
    oncancel={(event) => {
      event.preventDefault();
      cancel();
    }}
  >
    <h2 id="rewind-title">Rewind to {forkPointLabel(current.target)}?</h2>
    <p>
      Rewinding is destructive. Choose what to restore, and review what this
      cannot undo.
    </p>

    <fieldset>
      <legend>What to restore</legend>
      {#each [["conversation", "Conversation only"], ["code", "Code only"], ["both", "Conversation and code"]] as [value, text] (value)}
        {@const availabilityOf = rewindChoiceAvailability(
          context,
          value as RewindChoice,
        )}
        <label>
          <input
            type="radio"
            name="rewind-choice"
            value={value}
            checked={choice === value}
            disabled={!availabilityOf.enabled}
            data-testid={`rewind-choice-${value}`}
            onchange={() => choose(value as RewindChoice)}
          />
          {text}
          {#if !availabilityOf.enabled}
            <span
              class="choice-reason"
              data-testid={`rewind-choice-${value}-reason`}
            >
              {availabilityOf.reason}
            </span>
          {/if}
        </label>
      {/each}
    </fieldset>

    <p id="rewind-choice-reason" data-testid="rewind-choice-reason">
      {choiceAvailability.enabled
        ? ""
        : (choiceAvailability.reason ?? "")}
    </p>

    {#if current.blocked}
      <p class="outcome-error" role="alert" data-testid="rewind-blocked">
        {current.blocked}
      </p>
    {/if}

    <ul id="rewind-limits" data-testid="rewind-limits">
      {#each REWIND_LIMITS as limit (limit)}
        <li>{limit}</li>
      {/each}
      {#if context.codeRestore.status !== "ready"}
        <li data-testid="rewind-code-limit">
          {context.codeRestore.reason ?? "Code restore is unavailable."}
        </li>
      {/if}
    </ul>

    <div class="dialog-actions">
      <button
        type="button"
        data-testid="rewind-confirm"
        disabled={!choiceAvailability.enabled}
        onclick={() => void confirm()}
      >
        Rewind
      </button>
      <button
        type="button"
        bind:this={cancelButton}
        data-testid="rewind-cancel"
        onclick={cancel}
      >
        Cancel
      </button>
    </div>
  </dialog>
{/if}

<style>
  .session-actions {
    display: grid;
    gap: 6px;
    padding: 8px;
  }
  h2 {
    margin: 0;
    font-size: 0.75rem;
    font-weight: 700;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: #4b5563;
  }
  .target,
  .leaves {
    margin: 0;
    font-size: 0.8125rem;
  }
  .leaves {
    color: #4b5563;
  }
  .buttons {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  button:focus-visible,
  input:focus-visible {
    outline: 2px solid #2563eb;
    outline-offset: 1px;
  }
  .reasons {
    margin: 0;
    padding-left: 18px;
    color: #4b5563;
    font-size: 0.75rem;
  }
  .outcome {
    margin: 4px 0;
    font-size: 0.8125rem;
  }
  .outcome-error {
    color: #b91c1c;
  }
  dialog.rewind {
    max-width: 32rem;
    border: 1px solid #9ca3af;
    border-radius: 8px;
    padding: 16px;
  }
  fieldset {
    display: grid;
    gap: 6px;
    margin: 8px 0;
  }
  .choice-reason {
    display: block;
    color: #4b5563;
    font-size: 0.75rem;
  }
  .dialog-actions {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
  }
</style>
