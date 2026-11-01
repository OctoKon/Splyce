<script lang="ts">
  import {
    formatRuns,
    supportCellView,
    type SupportCell,
  } from "../status-labels";
  import StatusLabel from "./StatusLabel.svelte";

  let { cells = null }: { cells?: readonly SupportCell[] | null } = $props();
</script>

<section aria-label="Release support status" data-testid="support-status">
  {#if cells && cells.length > 0}
    <table>
      <thead>
        <tr><th scope="col">Cell</th><th scope="col">Status</th><th scope="col">Runs</th></tr>
      </thead>
      <tbody>
        {#each cells as cell (cell.id)}
          <tr>
            <th scope="row">{cell.label}</th>
            <td><StatusLabel view={supportCellView(cell)} /></td>
            <td>{formatRuns(cell.runs)}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  {:else}
    <p role="status" data-testid="support-status-empty">
      No support record available - support is not claimed.
    </p>
  {/if}
</section>
