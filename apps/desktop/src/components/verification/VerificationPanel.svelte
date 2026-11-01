<script lang="ts">
  import { overall, project, type VerifierResult } from "./verification";

  let {
    snapshotId,
    results,
  }: { snapshotId: string; results: readonly VerifierResult[] } = $props();

  const shown = $derived(results.map((r) => project(snapshotId, r)));
  const total = $derived(overall(shown));
  const summary = {
    verified: "Verified for this snapshot",
    failed: "Verification failed",
    incomplete: "Not verified",
  } as const;
</script>

<section aria-label="Verification" data-testid="verification-panel" data-overall={total}>
  <h3>{summary[total]}</h3>
  <p class="snap">Snapshot {snapshotId}</p>
  {#if shown.length === 0}
    <p>No verifier has reported for this snapshot.</p>
  {:else}
    <ul>
      {#each shown as s (s.verifierId)}
        <li data-state={s.state}>
          <span class="name">{s.name}</span>:
          <strong>{s.label}</strong>
        </li>
      {/each}
    </ul>
  {/if}
</section>
