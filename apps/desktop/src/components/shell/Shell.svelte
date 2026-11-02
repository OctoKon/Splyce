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
  .body {
    display: flex;
    flex: 1;
    min-height: 0;
  }
  main {
    flex: 1;
    min-width: 0;
    overflow: auto;
  }
  nav,
  aside {
    overflow: auto;
  }
  [data-layout="narrow"] nav,
  [data-layout="narrow"] aside {
    flex: 1;
  }
  button:focus-visible {
    outline: 2px solid currentColor;
    outline-offset: 2px;
  }
</style>
