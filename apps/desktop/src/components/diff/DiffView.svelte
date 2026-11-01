<script lang="ts">
  import {
    KIND_GLYPH,
    KIND_LABEL,
    parseUnifiedDiff,
    splitRows,
    type DiffLine,
  } from "./diff";

  let {
    diff,
    mode = "unified",
    pageSize = 300,
    maxBytes = 1_000_000,
  }: {
    diff: string;
    mode?: "unified" | "split";
    pageSize?: number;
    maxBytes?: number;
  } = $props();

  // svelte-ignore state_referenced_locally
  let view = $state<"unified" | "split">(mode);
  let selected = $state(0);
  let shown = $state<Record<number, number>>({});

  const tooLarge = $derived(diff.length > maxBytes);
  const files = $derived(tooLarge ? [] : parseUnifiedDiff(diff));
  const file = $derived(files[Math.min(selected, files.length - 1)]);
  const limit = $derived(shown[selected] ?? pageSize);

  const total = $derived(
    file ? file.hunks.reduce((n, h) => n + h.lines.length, 0) : 0,
  );

  // Truncate by line budget across hunks; a hunk may be cut mid-way.
  const visible = $derived.by(() => {
    if (!file) return [];
    let left = limit;
    const out: { header: string; lines: readonly DiffLine[] }[] = [];
    for (const h of file.hunks) {
      if (left <= 0) break;
      out.push({ header: h.header, lines: h.lines.slice(0, left) });
      left -= h.lines.length;
    }
    return out;
  });

  function more(): void {
    shown = { ...shown, [selected]: limit + pageSize };
  }
</script>

<section class="diff" aria-label="Changes" data-testid="diff-view">
  {#if tooLarge}
    <p class="placeholder" role="status" data-testid="diff-too-large">
      Diff too large to display ({diff.length} bytes, limit {maxBytes}). The
      change is not shown; it is not empty.
    </p>
  {:else if files.length === 0}
    <p class="placeholder" role="status" data-testid="diff-empty">
      No changes in this diff.
    </p>
  {:else}
    <div class="bar">
      <div role="group" aria-label="Files">
        {#each files as f, i (i)}
          <button
            type="button"
            aria-pressed={i === selected}
            onclick={() => (selected = i)}>{f.path}</button
          >
        {/each}
      </div>
      <div role="group" aria-label="Diff layout">
        <button
          type="button"
          aria-pressed={view === "unified"}
          onclick={() => (view = "unified")}>Unified</button
        >
        <button
          type="button"
          aria-pressed={view === "split"}
          onclick={() => (view = "split")}>Side by side</button
        >
      </div>
    </div>

    {#if file}
      {#if file.binary}
        <p class="placeholder" role="status" data-testid="diff-binary">
          Binary file changed: {file.path}. Content is not shown.
        </p>
      {:else}
        <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
        <div class="scroll" tabindex="0" role="region" aria-label="Diff of {file.path}">
          {#each visible as h, hi (hi)}
            <table class="tbl" aria-label="Hunk {h.header}">
              <caption>{h.header}</caption>
              {#if view === "unified"}
                <tbody>
                  {#each h.lines as l, li (li)}
                    <tr class={l.kind} data-kind={l.kind}>
                      <td class="no">{l.oldNo ?? ""}</td>
                      <td class="no">{l.newNo ?? ""}</td>
                      <td class="glyph"
                        ><span aria-hidden="true">{KIND_GLYPH[l.kind]}</span
                        ><span class="sr">{KIND_LABEL[l.kind]}</span></td
                      >
                      <td class="code">{l.text}</td>
                    </tr>
                  {/each}
                </tbody>
              {:else}
                <tbody>
                  {#each splitRows(h.lines) as r, ri (ri)}
                    <tr>
                      {#each [r.left, r.right] as c, ci (ci)}
                        {#if c}
                          <td class="no {c.kind}">{(ci === 0 ? c.oldNo : c.newNo) ?? ""}</td>
                          <td class="glyph {c.kind}" data-kind={c.kind}
                            ><span aria-hidden="true">{KIND_GLYPH[c.kind]}</span
                            ><span class="sr">{KIND_LABEL[c.kind]}</span></td
                          >
                          <td class="code {c.kind}">{c.text}</td>
                        {:else}
                          <td class="no"></td><td class="glyph"></td><td class="code"></td>
                        {/if}
                      {/each}
                    </tr>
                  {/each}
                </tbody>
              {/if}
            </table>
          {/each}
        </div>
        {#if total > limit}
          <button type="button" class="more" data-testid="diff-more" onclick={more}
            >Show more ({total - limit} lines hidden)</button
          >
        {/if}
      {/if}
    {/if}
  {/if}
</section>

<style>
  .bar { display: flex; flex-wrap: wrap; gap: 8px; justify-content: space-between; }
  .scroll { overflow: auto; max-height: 60vh; }
  .tbl { border-collapse: collapse; width: 100%; font-family: ui-monospace, Consolas, monospace; font-size: 13px; }
  caption { text-align: left; color: var(--text-muted, #6b7280); }
  .code { white-space: pre-wrap; overflow-wrap: anywhere; }
  .no { text-align: right; color: var(--text-muted, #6b7280); user-select: none; padding: 0 6px; }
  .glyph { width: 1.5em; text-align: center; font-weight: 700; }
  .add { background: rgb(34 197 94 / 12%); }
  .del { background: rgb(239 68 68 / 12%); }
  .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
  button:focus-visible, .scroll:focus-visible { outline: 2px solid var(--focus, #2563eb); outline-offset: 2px; }
  .placeholder { color: var(--text-secondary, #4b5563); }
</style>
