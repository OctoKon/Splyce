<script lang="ts">
  import { CATALOG, filterCommands } from "../../stores/commands";

  // Static reference generated from the registry catalog; never registers or dispatches a key.
  let query = $state("");
  let rows = $derived(filterCommands(CATALOG, query));
  let categories = $derived([...new Set(rows.map((r) => r.category))]);
</script>

<section aria-labelledby="shortcut-ref-title">
  <h2 id="shortcut-ref-title">Keyboard shortcuts</h2>
  <input type="search" aria-label="Search shortcuts" bind:value={query} />
  {#each categories as category (category)}
    <h3>{category}</h3>
    <table aria-label={`${category} shortcuts`}>
      <thead>
        <tr><th scope="col">Action</th><th scope="col">Shortcut</th></tr>
      </thead>
      <tbody>
        {#each rows.filter((r) => r.category === category) as row (row.id)}
          <tr>
            <td>{row.label}</td>
            <td>{#each row.shortcuts as s, i (s)}{#if i}{" / "}{/if}<kbd>{s}</kbd>{/each}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/each}
  {#if rows.length === 0}<p role="status">No matching shortcuts</p>{/if}
</section>
