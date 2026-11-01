<script lang="ts">
  import {
    buildPrompt,
    keyAction,
    sendBlockedReason,
    type PromptPayload,
  } from "../stores/composer";
  import type { EngineConnectionState } from "../stores/engine";

  /**
   * Fixed copy for a rejected send. The rejection itself is never shown: it can
   * carry filesystem paths, secrets or stack frames, and the UI cannot know
   * whether the engine received the prompt before the failure.
   */
  const SEND_UNCERTAIN =
    "The message may not have reached the engine. Check the connection, then resend.";

  let {
    connection,
    sessionId,
    stale = false,
    generationReady,
    unavailable,
    cancellable = false,
    contextArtifactIds = [],
    send,
    cancel,
  }: {
    connection: EngineConnectionState;
    sessionId: string | null;
    stale?: boolean;
    /** Engine-reported generation readiness; fail closed when false. */
    generationReady?: boolean;
    unavailable?: string;
    cancellable?: boolean;
    contextArtifactIds?: readonly string[];
    send: (payload: PromptPayload) => Promise<void>;
    cancel?: () => void | Promise<void>;
  } = $props();

  let draft = $state("");
  let pending = $state(false);
  let composing = $state(false);
  let error = $state<string | null>(null);

  const reason = $derived(
    sendBlockedReason({
      connection,
      sessionId,
      stale,
      generationReady,
      pending,
      unavailable,
    }),
  );
  const payload = $derived(buildPrompt(draft, contextArtifactIds));

  async function submit() {
    // Guard on live state: a handler may run before derived values re-render.
    if (pending || sendBlockedReason({
      connection,
      sessionId,
      stale,
      generationReady,
      pending,
      unavailable,
    }))
      return;
    const request = buildPrompt(draft, contextArtifactIds);
    if (!request) return;
    pending = true;
    error = null;
    try {
      await send(request);
      draft = "";
    } catch {
      // Never echo the rejection: it can carry paths, secrets or stack text.
      // A rejected promise does not prove the engine ignored the message.
      error = SEND_UNCERTAIN;
    } finally {
      pending = false;
    }
  }

  function onkeydown(e: KeyboardEvent) {
    const action = keyAction(e, composing);
    if (action === "send") {
      e.preventDefault();
      void submit();
    } else if (action === "cancel" && cancellable && cancel) {
      e.preventDefault();
      void cancel();
    }
  }
</script>

<form
  class="composer"
  aria-label="Composer"
  onsubmit={(e) => {
    e.preventDefault();
    void submit();
  }}
>
  <label for="composer-input">Message</label>
  <textarea
    id="composer-input"
    rows="3"
    bind:value={draft}
    {onkeydown}
    oncompositionstart={() => (composing = true)}
    oncompositionend={() => (composing = false)}
    aria-describedby="composer-status"
  ></textarea>
  <div class="composer-footer">
    <p id="composer-status" role="status" class:has-error={!!error} class:is-blocked={!!reason}>
      {#if error}Send failed: {error}{:else if reason}{reason}{/if}
    </p>
    <div class="composer-actions">
      {#if cancellable && cancel}
        <button type="button" class="btn-cancel" onclick={() => void cancel?.()}>Cancel turn</button>
      {/if}
      <button type="submit" class="btn-send" disabled={reason !== null || payload === null}>
        Send
      </button>
    </div>
  </div>
</form>

<style>
  .composer {
    display: flex;
    flex-direction: column;
    gap: var(--splyce-space-2, 0.5rem);
    padding: var(--splyce-space-3, 0.75rem);
    background: var(--splyce-surface-raised, #ffffff);
    border: 1px solid var(--splyce-border-default, #e5e7eb);
    border-radius: var(--radius-md, 8px);
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);
  }
  label {
    font-size: var(--splyce-font-size-xs, 0.75rem);
    font-weight: 600;
    color: var(--splyce-text-secondary, #4b5563);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  textarea {
    width: 100%;
    box-sizing: border-box;
    padding: var(--splyce-space-2, 0.5rem) var(--splyce-space-3, 0.75rem);
    font-family: inherit;
    font-size: var(--splyce-font-size-base, 0.9375rem);
    line-height: var(--splyce-line-height-normal, 1.5);
    color: var(--splyce-text-primary, #111827);
    background: var(--splyce-surface, #ffffff);
    border: 1px solid var(--splyce-border-default, #d1d5db);
    border-radius: var(--radius-md, 6px);
    resize: vertical;
    transition: border-color 0.15s ease, box-shadow 0.15s ease;
  }
  textarea:focus {
    border-color: var(--focus, #2563eb);
    box-shadow: 0 0 0 2px rgba(37, 99, 235, 0.2);
  }
  textarea:focus-visible,
  button:focus-visible {
    outline: 2px solid var(--focus, #2563eb);
    outline-offset: 2px;
  }
  .composer-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--splyce-space-3, 0.75rem);
    min-height: 2rem;
  }
  #composer-status {
    margin: 0;
    font-size: var(--splyce-font-size-xs, 0.8125rem);
    color: var(--splyce-text-muted, #6b7280);
    flex: 1;
    overflow-wrap: anywhere;
  }
  #composer-status.has-error {
    color: var(--status-danger, #b91c1c);
    font-weight: 500;
  }
  #composer-status.is-blocked {
    color: var(--status-warning, #b45309);
  }
  .composer-actions {
    display: flex;
    align-items: center;
    gap: var(--splyce-space-2, 0.5rem);
    margin-left: auto;
  }
  button {
    font-family: inherit;
    font-size: var(--splyce-font-size-sm, 0.875rem);
    font-weight: 600;
    padding: 6px 16px;
    border-radius: var(--radius-md, 6px);
    cursor: pointer;
    transition: background-color 0.15s ease, opacity 0.15s ease;
  }
  .btn-send {
    background: var(--focus, #2563eb);
    color: #ffffff;
    border: 1px solid transparent;
  }
  .btn-send:hover:not(:disabled) {
    background: #1d4ed8;
  }
  .btn-send:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .btn-cancel {
    background: transparent;
    color: var(--status-danger, #b91c1c);
    border: 1px solid var(--status-danger, #b91c1c);
  }
  .btn-cancel:hover {
    background: #fee2e2;
  }
</style>
