<script lang="ts">
  import {
    validateCustomEndpoint,
    type CustomEndpointDraft,
    type ExistingEndpoint,
  } from "../../stores/profiles";

  let {
    existing,
    onAdd,
  }: {
    existing: readonly ExistingEndpoint[];
    onAdd: (draft: CustomEndpointDraft) => void;
  } = $props();

  let connectionId = $state("");
  let baseUrl = $state("");
  let headers = $state<{ name: string; value: string }[]>([]);
  let errors = $state<readonly string[]>([]);

  function submit(event: SubmitEvent) {
    event.preventDefault();
    const draft: CustomEndpointDraft = {
      connectionId: connectionId.trim(),
      baseUrl: baseUrl.trim(),
      headers: headers.map((h) => ({ name: h.name.trim(), value: h.value })),
    };
    errors = validateCustomEndpoint(draft, existing);
    if (errors.length > 0) return;
    onAdd(draft);
    // Header values are never kept or echoed after hand-off.
    connectionId = "";
    baseUrl = "";
    headers = [];
  }
</script>

<form onsubmit={submit} aria-labelledby="custom-title" novalidate>
  <h3 id="custom-title">Add custom OpenAI-compatible endpoint</h3>
  <label>Connection name <input name="connectionId" bind:value={connectionId} autocomplete="off" /></label>
  <label>Base URL <input name="baseUrl" bind:value={baseUrl} autocomplete="off" /></label>
  {#each headers as header, i (i)}
    <fieldset>
      <legend>Header {i + 1}</legend>
      <label>Header {i + 1} name <input name={`hn${i}`} bind:value={header.name} autocomplete="off" /></label>
      <label>Header {i + 1} value <input type="password" name={`hv${i}`} bind:value={header.value} autocomplete="off" /></label>
      <button type="button" onclick={() => (headers = headers.filter((_, j) => j !== i))}>Remove header {i + 1}</button>
    </fieldset>
  {/each}
  <button type="button" onclick={() => (headers = [...headers, { name: "", value: "" }])}>Add header</button>
  {#if errors.length > 0}
    <ul role="alert" data-testid="form-errors">
      {#each errors as message}<li>{message}</li>{/each}
    </ul>
  {/if}
  <button type="submit">Add endpoint</button>
</form>

<style>
  label { display: block; margin: 0.25rem 0; }
  form :global(button:focus-visible), form :global(input:focus-visible) { outline: 2px solid currentColor; outline-offset: 2px; }
</style>
