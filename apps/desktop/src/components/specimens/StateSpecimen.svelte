<script lang="ts">
  import StateMessage, { STATE_KINDS } from "./StateMessage.svelte";

  const TITLES = {
    loading: "Loading sessions",
    empty: "No sessions yet",
    error: "Could not load sessions",
    stale: "This view may be out of date",
    unavailable: "Engine is not connected",
  } as const;
</script>

<section aria-label="State specimens" data-testid="state-specimen">
  {#each STATE_KINDS as kind (kind)}
    <StateMessage {kind} title={TITLES[kind]} />
  {/each}
</section>
