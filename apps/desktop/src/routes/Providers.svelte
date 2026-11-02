<script lang="ts">
  import ConnectionCard from "../components/provider/ConnectionCard.svelte";
  import CredentialForm from "../components/provider/CredentialForm.svelte";
  import CustomEndpointForm from "../components/provider/CustomEndpointForm.svelte";
  import {
    groupByFamily,
    type ConfiguredProfile,
    type ConnectionInput,
    type CustomEndpointDraft,
    type ProviderSetupDraft,
  } from "../stores/profiles";

  let {
    connections,
    families,
    onAddCustom,
    credentialSubmit,
    credentialUnavailable,
    profiles = [],
    workspaceSelected = false,
    selectedProfileId = null,
    selectProfile,
    profilePending = false,
    profileStatus = null,
  }: {
    connections: readonly ConnectionInput[];
    families: readonly string[];
    /** Omitted while no profile service is connected: the form stays disabled with its reason. */
    onAddCustom?: (draft: CustomEndpointDraft) => void;
    /** Injected once the native setup route is available; omitted means unavailable. */
    credentialSubmit?: (draft: ProviderSetupDraft) => Promise<void>;
    credentialUnavailable?: string;
    profiles?: readonly ConfiguredProfile[];
    workspaceSelected?: boolean;
    selectedProfileId?: string | null;
    selectProfile?: (profile: ConfiguredProfile) => Promise<void>;
    profilePending?: boolean;
    profileStatus?: string | null;
  } = $props();

  const groups = $derived(groupByFamily(connections, families));
  const existing = $derived(
    connections.map((c) => ({
      id: c.record.providerConnectionId,
      endpointLabel: c.endpointLabel,
    })),
  );
</script>

<section aria-labelledby="providers-title">
  <h2 id="providers-title">Provider connections</h2>
  <CredentialForm
    submit={credentialSubmit}
    unavailableReason={credentialUnavailable}
  />
  <section aria-labelledby="configured-profiles-title">
    <h3 id="configured-profiles-title">Configured profiles</h3>
    {#if profiles.length === 0}
      <p>No configured profile metadata is available for this project.</p>
    {/if}
    {#each profiles as profile (profile.profileId)}
      <div>
        <span
          >{profile.profileId}{selectedProfileId === profile.profileId
            ? " (selected)"
            : ""}</span
        >
        {#if profile.credential}
          <span
            >{profile.apiFamily} · {profile.modelId} · {profile.endpointOrigin} ·
            Credential {profile.credential}</span
          >
        {/if}
        <button
          type="button"
          disabled={profile.credential === "missing" ||
            !workspaceSelected ||
            !selectProfile ||
            profilePending ||
            !credentialSubmit}
          aria-describedby="profile-status"
          onclick={() => void selectProfile?.(profile)}
        >
          Use this profile
        </button>
      </div>
    {/each}
    <p id="profile-status" role="status">
      {!workspaceSelected
        ? "Choose a project before selecting a profile."
        : profileStatus}
    </p>
  </section>
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
  <fieldset class="custom" disabled={!onAddCustom}>
    {#if !onAddCustom}
      <p>Custom endpoints are unavailable: no profile service is connected.</p>
    {/if}
    <CustomEndpointForm {existing} onAdd={(draft) => onAddCustom?.(draft)} />
  </fieldset>
</section>

<style>
  .custom {
    border: 0;
    margin: 0;
    padding: 0;
  }
  button:focus-visible {
    outline: 2px solid currentColor;
    outline-offset: 2px;
  }
</style>
