<script lang="ts">
  import Icon from "./shell/Icon.svelte";
  import type { Snippet } from "svelte";
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
    workspaceName,
    modeControl,
    runtimeName,
    onChooseProject,
    onOpenModels,
    projectUnavailable = true,
    connection,
    sessionId,
    stale = false,
    generationReady,
    workspaceSelected = false,
    profileSelected = false,
    sessionReadiness,
    unavailable,
    cancellable = false,
    contextArtifactIds = [],
    send,
    cancel,
  }: {
    workspaceName?: string;
    modeControl?: Snippet;
    runtimeName?: string;
    onChooseProject?: () => void;
    onOpenModels?: () => void;
    projectUnavailable?: boolean;
    connection: EngineConnectionState;
    sessionId: string | null;
    stale?: boolean;
    /** Engine-reported generation readiness; fail closed when false. */
    generationReady?: boolean;
    /** A project is selected; sending is blocked without one. */
    workspaceSelected?: boolean;
    profileSelected?: boolean;
    sessionReadiness?: "ready" | "unavailable";
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
      workspaceSelected,
      profileSelected,
      sessionReadiness,
      pending,
      unavailable,
    }),
  );
  const payload = $derived(buildPrompt(draft, contextArtifactIds));

  async function submit() {
    // Guard on live state: a handler may run before derived values re-render.
    if (
      pending ||
      sendBlockedReason({
        connection,
        sessionId,
        stale,
        generationReady,
        workspaceSelected,
        profileSelected,
        sessionReadiness,
        pending,
        unavailable,
      })
    )
      return;
    const submittedDraft = draft;
    const request = buildPrompt(submittedDraft, contextArtifactIds);
    if (!request) return;
    pending = true;
    error = null;
    try {
      await send(request);
      if (draft === submittedDraft) draft = "";
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
  <div class="c-top">
    <label class="sr" for="composer-input">Message</label>
    <textarea
      id="composer-input"
      rows="2"
      bind:value={draft}
      {onkeydown}
      oncompositionstart={() => (composing = true)}
      oncompositionend={() => (composing = false)}
      aria-describedby="composer-status composer-hint"
      placeholder="Describe the task, the acceptance test, and anything that must not change…"
    ></textarea>
    <button
      type="submit"
      class="send"
      aria-label="Send"
      disabled={reason !== null || payload === null}
      ><Icon name="arrow-up" size={15} /><span class="sr">Send</span></button
    >
  </div>
  <div class="c-bottom">
    {#if onChooseProject}<button
        type="button"
        class="context-chip"
        aria-label="Choose workspace"
        disabled={projectUnavailable}
        onclick={onChooseProject}
        ><Icon name="folder" size={12} /><span class="chip-label"
          >workspace</span
        >
        {workspaceName ?? "Choose project"}<Icon
          name="chevron-down"
          size={11}
        /></button
      >{/if}
    {#if onOpenModels}<button
        type="button"
        class="context-chip"
        aria-label="Configure runtime"
        onclick={onOpenModels}
        ><Icon name="cpu" size={12} /><span class="chip-label">runtime</span>
        {runtimeName ?? "Set up a provider"}<Icon
          name="chevron-down"
          size={11}
        /></button
      >{/if}
    {#if modeControl}{@render modeControl()}{/if}
    <span id="composer-hint">Enter to start · Shift+Enter for a line</span>
  </div>
  <div class="composer-footer">
    <p id="composer-status" role="status" class:has-error={!!error} class:is-blocked={!!reason}>

      {#if error}Send failed: {error}{:else if reason}{reason}{/if}
    </p>
    {#if cancellable && cancel}<button
        type="button"
        class="btn-cancel"
        onclick={() => void cancel?.()}>Cancel turn</button
      >{/if}
  </div>
</form>
