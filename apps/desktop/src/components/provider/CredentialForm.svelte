<script lang="ts">
  import {
    API_FAMILIES,
    validateProviderSetup,
    type ApiFamily,
    type ProviderSetupDraft,
    type SetupErrors,
    type SetupField,
  } from "../../stores/profiles";

  let {
    submit,
    unavailableReason,
  }: {
    /** Injected when the native setup route is available; never a renderer store. */
    submit?: (draft: ProviderSetupDraft) => Promise<void>;
    unavailableReason?: string;
  } = $props();

  // Fixed copy per typed error code: a rejection can carry paths, stack frames or the key itself.
  const ERROR_COPY: Readonly<Record<string, string>> = {
    STALE_REVISION:
      "The provider changed since this form was opened. Nothing was saved; reload and try again.",
    SETUP_REQUEST_CONFLICT:
      "This setup request conflicts with an earlier request. Check the provider configuration before continuing.",
    WORKSPACE_SUPERSEDED:
      "The project changed. Select it again before configuring a provider.",
    POLICY_DENIED:
      "The engine refused this provider setup. Nothing was saved and the key was discarded.",
    SETUP_CREDENTIAL_UNAVAILABLE:
      "A Windows credential operation was unavailable. Check Windows Credential Manager access before retrying. The key was discarded from this form.",
    SETUP_CREDENTIAL_INVENTORY_UNAVAILABLE:
      "Windows credential inventory could not be validated. Review Splyce entries in Windows Credential Manager. Nothing was saved and the key was discarded.",
  };
  const FAILED =
    "Could not confirm the provider save. Check the provider configuration before trying again. The key was discarded from this form.";

  let endpoint = $state("");
  let apiFamily = $state<ApiFamily>("openai-completions");
  let modelId = $state("");
  let modelTouched = false;
  let pollinationsDefault = false;
  let contextWindow = $state("");
  let maxOutputTokens = $state("");
  let reasoning = $state(false);
  let image = $state(false);
  let apiKey = $state("");
  let errors = $state<SetupErrors>({});
  let pending = $state(false);
  let result = $state<string | null>(null);

  const blockedReason = $derived(
    submit
      ? null
      : (unavailableReason ??
          "The native provider setup route is not available yet. Nothing can be saved."),
  );

  const FIELD_IDS: Readonly<Record<SetupField, string>> = {
    endpoint: "setup-endpoint",
    modelId: "setup-model",
    contextWindow: "setup-context",
    maxOutputTokens: "setup-output",
    apiKey: "setup-key",
  };

  async function onsubmit(event: SubmitEvent) {
    event.preventDefault();
    if (!submit || pending) return;
    result = null;
    const draft: ProviderSetupDraft = {
      endpoint,
      apiFamily,
      modelId,
      contextWindow,
      maxOutputTokens,
      reasoning,
      image,
      apiKey,
    };
    errors = validateProviderSetup(draft);
    const first = (Object.keys(FIELD_IDS) as SetupField[]).find(
      (field) => errors[field],
    );
    if (first) {
      document.getElementById(FIELD_IDS[first])?.focus();
      return;
    }
    pending = true;
    try {
      await submit(draft);
      result =
        "Provider saved. The key went to the engine and the renderer kept nothing.";
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      result =
        typeof code === "string" && Object.hasOwn(ERROR_COPY, code)
          ? ERROR_COPY[code]!
          : FAILED;
    } finally {
      apiKey = "";
      pending = false;
    }
  }
</script>

{#snippet error(field: SetupField)}
  {#if errors[field]}
    <p id={`${FIELD_IDS[field]}-error`} class="error">{errors[field]}</p>
  {/if}
{/snippet}

<section class="connect" aria-labelledby="connect-provider-title">
  <h3 id="connect-provider-title">Connect a provider</h3>
  <p id="setup-note" class="note">
    {blockedReason ??
      "The key goes to the engine in one request and is not stored in the renderer."}
  </p>
  <form
    aria-label="Provider setup"
    aria-describedby="setup-note"
    novalidate
    {onsubmit}
  >
    <fieldset disabled={blockedReason !== null || pending}>
      <label for="setup-endpoint">Endpoint URL</label>
      <input
        id="setup-endpoint"
        type="url"
        bind:value={endpoint}
        oninput={(e) => {
          try {
            if (!modelTouched && new URL(e.currentTarget.value).origin === "https://gen.pollinations.ai") {
              modelId = "stealth/glyph-cluster";
              contextWindow = "256000";
              maxOutputTokens = "8192";
              pollinationsDefault = true;
            } else if (!modelTouched && pollinationsDefault) {
              modelId = "";
              contextWindow = "";
              maxOutputTokens = "";
              pollinationsDefault = false;
            }
          } catch { /* incomplete URL */ }
        }}
        autocomplete="off"
        aria-invalid={errors.endpoint ? "true" : undefined}
        aria-describedby={errors.endpoint ? "setup-endpoint-error" : undefined}
      />
      {@render error("endpoint")}
      <label for="setup-family">API family</label>
      <select
        id="setup-family"
        value={apiFamily}
        onchange={(e) => (apiFamily = e.currentTarget.value as ApiFamily)}
      >
        {#each API_FAMILIES as family (family)}
          <option value={family}>{family}</option>
        {/each}
      </select>
      <label for="setup-model">Model ID</label>
      <input
        id="setup-model"
        bind:value={modelId}
        oninput={() => (modelTouched = true)}
        autocomplete="off"
        aria-invalid={errors.modelId ? "true" : undefined}
        aria-describedby={errors.modelId ? "setup-model-error" : undefined}
      />
      {@render error("modelId")}
      <p id="setup-limits-note" class="note">
        Token limits: leave both blank only for a known catalog model. A custom
        model needs both from your provider; Splyce never guesses them. Cost is
        shown as unknown for custom models.
      </p>
      <label for="setup-context">Context window (tokens)</label>
      <input
        id="setup-context"
        inputmode="numeric"
        bind:value={contextWindow}
        autocomplete="off"
        aria-invalid={errors.contextWindow ? "true" : undefined}
        aria-describedby={errors.contextWindow
          ? "setup-context-error setup-limits-note"
          : "setup-limits-note"}
      />
      {@render error("contextWindow")}
      <label for="setup-output">Max output tokens</label>
      <input
        id="setup-output"
        inputmode="numeric"
        bind:value={maxOutputTokens}
        autocomplete="off"
        aria-invalid={errors.maxOutputTokens ? "true" : undefined}
        aria-describedby={errors.maxOutputTokens
          ? "setup-output-error setup-limits-note"
          : "setup-limits-note"}
      />
      {@render error("maxOutputTokens")}
      <label class="check"
        ><input id="setup-reasoning" type="checkbox" bind:checked={reasoning} /> Reasoning
        model</label
      >
      <label class="check"
        ><input id="setup-image" type="checkbox" bind:checked={image} /> Accepts image
        input</label
      >
      <label for="setup-key">API key</label>
      <input
        id="setup-key"
        type="password"
        bind:value={apiKey}
        autocomplete="off"
        aria-invalid={errors.apiKey ? "true" : undefined}
        aria-describedby={errors.apiKey ? "setup-key-error" : "connect-status"}
      />
      {@render error("apiKey")}
      <button type="submit" disabled={blockedReason !== null || pending}
        >{pending ? "Saving…" : "Save provider"}</button
      >
    </fieldset>
  </form>
  <p id="connect-status" role="status">{result}</p>
</section>

<style>
  .connect {
    padding: 0;
    margin: 20px 0;
  }
  fieldset {
    border: 0;
    margin: 0;
    padding: 0;
  }
  .note {
    font-size: 0.875rem;
  }
  label {
    display: block;
    font-weight: 600;
    margin-top: 0.75rem;
  }
  .check {
    font-weight: 400;
  }
  input:not([type="checkbox"]),
  select {
    display: block;
    width: 100%;
  }
  .error {
    font-weight: 600;
    margin: 0.125rem 0;
  }
  button {
    margin-top: 0.5rem;
  }
  :focus-visible {
    outline: 2px solid currentColor;
    outline-offset: 2px;
  }
</style>
