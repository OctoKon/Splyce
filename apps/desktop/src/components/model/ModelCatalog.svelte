<script lang="ts">
  import type { ModelSummary, ModelsListResult } from "@splyce/pi/model-data";
  import type { ConfiguredProfile } from "../../stores/profiles";
  let { profiles, catalogProfileId, catalog, catalogStatus, catalogPending, switchPending, onLoad, onUse }: {
    profiles: readonly ConfiguredProfile[]; catalogProfileId: string; catalog: ModelsListResult | null;
    catalogStatus: string; catalogPending: boolean; switchPending: boolean;
    onLoad: (id: string) => Promise<void>; onUse: (model: ModelSummary) => Promise<void>;
  } = $props();
  let query = $state("");
  let filter = $state("all");
  const profile = $derived(profiles.find((p) => p.profileId === catalogProfileId));
  const models = $derived((catalog?.models ?? []).filter((m) =>
    `${m.title ?? ""} ${m.modelId}`.toLowerCase().includes(query.toLowerCase()) &&
    (filter === "all" || (filter === "tools" && m.tools === true) || (filter === "paid" && m.paidOnly === true))));
</script>
<section aria-labelledby="catalog-title" aria-busy={catalogPending || switchPending}>
  <h3 id="catalog-title">Models</h3>
  <label for="catalog-profile">Provider profile</label>
  <select id="catalog-profile" value={catalogProfileId} disabled={catalogPending || switchPending} onchange={(e) => void onLoad(e.currentTarget.value)}>
    <option value="">Choose a profile</option>
    {#each profiles as p (p.profileId)}<option value={p.profileId} disabled={p.credential !== "configured"}>{p.profileId} · {p.endpointOrigin ?? "Provider"}</option>{/each}
  </select>
  <button type="button" disabled={!catalogProfileId || catalogPending || switchPending} onclick={() => void onLoad(catalogProfileId)}>Refresh models</button>
  <p role="status">{catalogStatus}</p>
  {#if catalog}
    <label for="catalog-search">Search models</label>
    <input id="catalog-search" type="search" bind:value={query} />
    <label for="catalog-filter">Filter models</label>
    <select id="catalog-filter" bind:value={filter}><option value="all">All models</option><option value="tools">Supports tools</option><option value="paid">Paid only</option></select>
    {#if models.length === 0}<p>No models match this view.</p>{/if}
    <div class="section-label">Catalog <span class="line"></span><span>{models.length} shown</span></div>
    <ul class="panel">
      {#each models as model (model.modelId)}
        <li class="catalog-row">
          <div class="c-main"><div class="c-name">{model.title ?? model.modelId}</div>
            <div class="c-meta">{#if model.title}{model.modelId} · {/if}Context: {model.contextWindow?.toLocaleString() ?? "Unknown"} · Tools: {model.tools === undefined ? "Unknown" : model.tools ? "Yes" : "No"} · {model.paidOnly === undefined ? "Pricing unknown" : model.paidOnly ? "Paid only" : "Not paid only"}</div>
          </div>
          <button type="button" aria-label={`Use ${model.title ?? model.modelId}`} disabled={switchPending || catalogPending || !profile?.providerConnectionId || (!model.contextWindow && !(model.modelId === profile?.modelId && profile?.model?.contextWindow))} onclick={() => void onUse(model)}>Use this model</button>
        </li>
      {/each}
    </ul>
    {#if !profile?.providerConnectionId}<p>Model switching is unavailable for this profile. Reconnect the provider to enable it.</p>{/if}
  {/if}
</section>
<style>
  label { display: block; margin-top: .75rem; }
  .section-label { display: flex; align-items: center; gap: 10px; margin-top: 24px; color: var(--text-muted); font-size: 11px; }
  .line { flex: 1; border-top: 1px solid var(--border); }
  .panel { padding: 0; border: 1px solid var(--border); border-radius: var(--r-md); background: var(--neutral); list-style: none; overflow: hidden; }
  .catalog-row { display: flex; align-items: center; gap: 12px; padding: 12px 16px; border-bottom: 1px solid var(--border); }
  .catalog-row:last-child { border-bottom: 0; }
  .c-main { flex: 1; min-width: 0; }
  .c-name { font-size: 13px; font-weight: 500; overflow-wrap: anywhere; }
  .c-meta { margin-top: 2px; font-size: 11px; color: var(--text-muted); overflow-wrap: anywhere; }
  @media (max-width: 600px) { .catalog-row { flex-wrap: wrap; } }
  button { margin-left: .5rem; }
  :focus-visible { outline: 2px solid currentColor; outline-offset: 2px; }
</style>
