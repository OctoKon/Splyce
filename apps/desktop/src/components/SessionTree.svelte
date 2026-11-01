<script lang="ts">
  import {
    visibleNodes,
    type SessionNavState,
  } from "../stores/sessions";

  let {
    nav,
    onSelect,
    onFocus,
    onMove,
    onRetry,
    canRetry = true,
  }: {
    nav: SessionNavState;
    onSelect: (key: string) => void;
    onFocus: (key: string) => void;
    onMove: (to: "next" | "prev" | "first" | "last") => void;
    onRetry: () => void;
    canRetry?: boolean;
  } = $props();

  const nodes = $derived(visibleNodes(nav));
  let container: HTMLElement | undefined = $state();

  // Move DOM focus only when it is already inside the tree, so a refresh never steals focus from elsewhere.
  $effect(() => {
    const key = nav.focusKey;
    if (!container || key === null) return;
    if (!container.contains(document.activeElement)) return;
    const el = container.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`);
    if (el && el !== document.activeElement) el.focus();
  });

  function onKeydown(event: KeyboardEvent, key: string) {
    const to =
      event.key === "ArrowDown"
        ? "next"
        : event.key === "ArrowUp"
          ? "prev"
          : event.key === "Home"
            ? "first"
            : event.key === "End"
              ? "last"
              : null;
    if (to) {
      event.preventDefault();
      onMove(to);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onSelect(key);
    }
  }
</script>

<section class="session-tree" aria-label="Sessions" data-testid="session-tree">
  <!-- Shown in every load state, so an empty or failed refresh cannot hide that the selection was lost. -->
  {#if nav.lostSelection}
    <p role="status" class="state" data-testid="lost-selection">
      The selected branch is no longer available: {nav.lostSelection}
    </p>
  {/if}
  {#if nav.load === "error"}
    <div role="alert" class="state state-error">
      <p>Sessions could not be loaded{nav.error ? `: ${nav.error}` : "."}</p>
      {#if canRetry}
        <button type="button" onclick={onRetry}>Retry</button>
      {/if}
    </div>
  {:else if nav.load === "loading" && nodes.length === 0}
    <p role="status" class="state">Loading sessions…</p>
  {:else if nav.load === "empty"}
    <p role="status" class="state">No sessions yet.</p>
  {:else}
    {#if nav.load === "loading"}
      <p role="status" class="state">Refreshing…</p>
    {/if}
    <ul role="tree" aria-label="Session branches" bind:this={container}>
      {#each nodes as node (node.key)}
        <li
          role="treeitem"
          aria-selected={node.selected}
          tabindex={node.focused ? 0 : -1}
          data-key={node.key}
          class:selected={node.selected}
          onclick={() => onSelect(node.key)}
          onfocus={() => onFocus(node.key)}
          onkeydown={(event) => onKeydown(event, node.key)}
        >
          <span class="name">{node.sessionId} / {node.branchAnchorId}</span>
          <span class="meta">{node.leaves.length} leaf{node.leaves.length === 1 ? "" : "s"}</span>
          <span class="badge">{node.stateLabel}</span>
        </li>
      {/each}
    </ul>
  {/if}
</section>

<style>
  .session-tree {
    padding: 12px;
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  li {
    display: flex;
    gap: 8px;
    align-items: baseline;
    padding: 6px 8px;
    border: 1px solid transparent;
    border-radius: var(--radius-md, 8px);
    cursor: pointer;
  }
  li:focus-visible {
    outline: 2px solid var(--focus, #2563eb);
    outline-offset: 1px;
  }
  li.selected {
    border-color: var(--border, #9ca3af);
    font-weight: 600;
  }
  .meta {
    color: var(--text-muted, #4b5563);
    font-size: 0.8125rem;
  }
  .badge {
    margin-left: auto;
    font-size: 0.75rem;
  }
  .state {
    margin: 8px 0;
  }
  .state-error {
    border: 1px solid var(--status-danger, #b91c1c);
    padding: 8px;
    border-radius: var(--radius-md, 8px);
  }
</style>
