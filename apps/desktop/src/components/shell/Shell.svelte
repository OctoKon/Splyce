<script lang="ts">
  import { tick, type Snippet } from "svelte";
  import {
    initialShell,
    layoutMode,
    normalizeShell,
    shortcutPanel,
    togglePanel,
    visiblePanes,
    type Panel,
    type ShellState,
  } from "../../stores/shell";

  let {
    rail,
    transcript,
    composer,
    evidence,
  }: {
    rail: Snippet;
    transcript: Snippet;
    composer: Snippet;
    evidence: Snippet;
  } = $props();

  let width = $state(window.innerWidth);
  const mode = $derived(layoutMode(width));
  let shell = $state<ShellState>(initialShell(layoutMode(window.innerWidth)));
  let lastMode = layoutMode(window.innerWidth);
  const panes = $derived(visiblePanes(shell, mode));

  let railBtn = $state<HTMLButtonElement>();
  let evidenceBtn = $state<HTMLButtonElement>();

  /** Apply a new state; if the focused element lives in a pane that is hiding, focus its toggle. */
  async function apply(next: ShellState, nextMode = mode) {
    const was = visiblePanes(shell, mode);
    const will = visiblePanes(next, nextMode);
    const active = document.activeElement;
    const lost: Panel[] = [];
    if (was.rail && !will.rail && document.getElementById("shell-rail")?.contains(active)) lost.push("rail");
    if (was.evidence && !will.evidence && document.getElementById("shell-evidence")?.contains(active))
      lost.push("evidence");
    shell = next;
    if (lost.length > 0) {
      await tick();
      (lost[0] === "rail" ? railBtn : evidenceBtn)?.focus();
    }
  }

  function onresize() {
    width = window.innerWidth;
    const next = layoutMode(width);
    if (next === lastMode) return;
    lastMode = next;
    void apply(normalizeShell(shell, next), next);
  }

  function toggle(panel: Panel) {
    void apply(togglePanel(shell, panel, mode));
  }

  function onkeydown(e: KeyboardEvent) {
    const panel = shortcutPanel(e);
    if (!panel) return;
    e.preventDefault();
    toggle(panel);
  }
</script>

<svelte:window {onresize} {onkeydown} />

<div class="shell" data-layout={mode}>
  <div class="toolbar" role="toolbar" aria-label="Panels">
    <button
      type="button"
      bind:this={railBtn}
      aria-expanded={shell.rail}
      aria-controls="shell-rail"
      aria-keyshortcuts="Control+B"
      title="Projects and tasks (Ctrl+B)"
      onclick={() => toggle("rail")}>Projects and tasks</button
    >
    <button
      type="button"
      bind:this={evidenceBtn}
      aria-expanded={shell.evidence}
      aria-controls="shell-evidence"
      aria-keyshortcuts="Control+Shift+E"
      title="Changes and evidence (Ctrl+Shift+E)"
      onclick={() => toggle("evidence")}>Changes and evidence</button
    >
  </div>
  <div class="body">
    {#if panes.rail}
      <nav id="shell-rail" aria-label="Projects and tasks">
        {@render rail()}
      </nav>
    {/if}
    {#if panes.conversation}
      <main aria-label="Conversation">
        {@render transcript()}
      </main>
    {/if}
    {#if panes.evidence}
      <aside
        id="shell-evidence"
        aria-label="Changes and evidence"
      >
        {@render evidence()}
      </aside>
    {/if}
  </div>
  <footer aria-label="Message composer">
    {@render composer()}
  </footer>
</div>

<style>
  .shell {
    display: flex;
    flex-direction: column;
    height: 100vh;
  }
  .toolbar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 16px;
    border-bottom: 1px solid #e5e7eb;
    background: #ffffff;
    flex-shrink: 0;
  }
  .toolbar button {
    padding: 4px 10px;
    font-size: 0.75rem;
    font-weight: 500;
    color: #4b5563;
    background: #f9fafb;
    border: 1px solid #e5e7eb;
    border-radius: 6px;
    cursor: pointer;
    transition: background 0.15s, color 0.15s;
  }
  .toolbar button:hover {
    background: #f3f4f6;
    color: #111827;
  }
  .toolbar button[aria-expanded="true"] {
    background: #e5e7eb;
    color: #111827;
    border-color: #d1d5db;
  }
  .body {
    display: flex;
    flex: 1;
    min-height: 0;
  }
  nav#shell-rail {
    width: 260px;
    min-width: 220px;
    max-width: 340px;
    border-right: 1px solid #e5e7eb;
    background: #fafafa;
    overflow-y: auto;
    box-sizing: border-box;
  }
  main {
    flex: 1;
    min-width: 0;
    overflow: auto;
    background: #f9fafb;
  }
  aside#shell-evidence {
    width: 280px;
    min-width: 240px;
    border-left: 1px solid #e5e7eb;
    background: #fafafa;
    overflow-y: auto;
    box-sizing: border-box;
  }
  [data-layout="narrow"] nav,
  [data-layout="narrow"] aside {
    flex: 1;
    width: auto;
    max-width: none;
  }
  footer {
    border-top: 1px solid #e5e7eb;
    background: #ffffff;
    flex-shrink: 0;
    box-sizing: border-box;
  }
  button:focus-visible {
    outline: 2px solid currentColor;
    outline-offset: 2px;
  }
</style>
