<script lang="ts">
  import ConnectionCard from "../components/provider/ConnectionCard.svelte";
  import CredentialForm from "../components/provider/CredentialForm.svelte";
  import CustomEndpointForm from "../components/provider/CustomEndpointForm.svelte";
  import {
    groupByFamily,
    type ConnectionInput,
    type CredentialDraft,
    type CustomEndpointDraft,
  } from "../stores/profiles";

  let {
    connections,
    families,
    onAddCustom,
    credentialSubmit,
  }: {
    connections: readonly ConnectionInput[];
    families: readonly string[];
    onAddCustom: (draft: CustomEndpointDraft) => void;
    /** Injected once the native credential writer exists; omitted means unavailable. */
    credentialSubmit?: (draft: CredentialDraft) => Promise<void>;
  } = $props();

  const groups = $derived(groupByFamily(connections, families));
  const existing = $derived(
    connections.map((c) => ({
      id: c.record.providerConnectionId,
      endpointLabel: c.endpointLabel,
    })),
  );
</script>

<main aria-labelledby="providers-title">
  <h2 id="providers-title">Provider connections</h2>
  <CredentialForm submit={credentialSubmit} />
  {#each groups as group (group.apiFamily)}
    <section aria-labelledby={`fam-${group.apiFamily}`} data-testid="family">
      <h3 id={`fam-${group.apiFamily}`}>{group.apiFamily}</h3>
      {#if group.connections.length === 0}
        <p>No connections configured.</p>
      {:else}
        <ul>
          {#each group.connections as connection (connection.id)}
            <ConnectionCard {connection} />
          {/each}
        </ul>
      {/if}
    </section>
  {/each}
  <CustomEndpointForm {existing} onAdd={onAddCustom} />
</main>
