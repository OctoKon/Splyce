<script lang="ts">
  import {
    validateCredentialDraft,
    type CredentialDraft,
  } from "../../stores/profiles";

  let {
    submit,
    unavailableReason,
  }: {
    /** Injected when the native credential writer exists; never a renderer store. */
    submit?: (draft: CredentialDraft) => Promise<void>;
    unavailableReason?: string;
  } = $props();

  let displayName = $state("");
  let baseUrl = $state("");
  let apiKey = $state("");
  let errors = $state<readonly string[]>([]);
  let pending = $state(false);
  let result = $state<string | null>(null);

  const blockedReason = $derived(
    submit
      ? null
      : (unavailableReason ??
        "The native credential writer is not available yet. Nothing can be saved."),
  );

  async function onsubmit(event: SubmitEvent) {
    event.preventDefault();
    if (!submit || pending) return;
    result = null;
    const draft: CredentialDraft = { displayName, baseUrl, apiKey };
    const found = validateCredentialDraft(draft);
    errors = found;
    if (found.length > 0) return;
    pending = true;
    try {
      await submit(draft);
      result =
        "Credential handed to the native writer. The renderer kept nothing.";
    } catch {
      // Fixed copy: a rejection can carry paths, stack frames or the key itself.
      result =
        "Could not save the credential. Nothing was stored and the key was discarded.";
    } finally {
      apiKey = "";
      pending = false;
    }
  }
</script>

<section class="connect" aria-labelledby="connect-provider-title">
  <h3 id="connect-provider-title">Connect a provider</h3>
  <fieldset disabled={blockedReason !== null || pending}>
    <form aria-label="Provider credential" onsubmit={onsubmit}>
      <p class="note">{blockedReason ?? "The key goes to the native writer and is not stored in the renderer."}</p>
      <label for="connect-name">Name</label>
      <input id="connect-name" bind:value={displayName} autocomplete="off" />
      <label for="connect-url">Base URL</label>
      <input id="connect-url" bind:value={baseUrl} autocomplete="off" />
      <label for="connect-key">API key</label>
      <input
        id="connect-key"
        type="password"
        bind:value={apiKey}
        autocomplete="off"
        aria-describedby="connect-status"
      />
      <button type="submit" disabled={blockedReason !== null || pending}>
        {pending ? "Saving…" : "Save credential"}
      </button>
    </form>
  </fieldset>
  {#if errors.length > 0}
    <ul role="alert" class="errors" data-testid="credential-errors">
      {#each errors as error (error)}
        <li>{error}</li>
      {/each}
    </ul>
  {/if}
  <p id="connect-status" role="status">{result}</p>
</section>

<style>
  .connect { border: 1px solid currentColor; padding: 0.5rem; margin: 0.5rem 0; }
  .note { font-size: 0.875rem; }
  label { display: block; font-weight: 600; margin-top: 0.25rem; }
  input { display: block; width: 100%; }
  button { margin-top: 0.5rem; }
  .errors { font-weight: 600; }
</style>
