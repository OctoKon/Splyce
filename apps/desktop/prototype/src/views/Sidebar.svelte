<script lang="ts">
  import { fly } from 'svelte/transition';
  import { app } from '../lib/state.svelte';
  import { toggleThemeFrom } from '../lib/theme';
  import { workspaces } from '../lib/data';
  import type { Page } from '../lib/types';
  import Mark from '../lib/Mark.svelte';
  import Icon from '../lib/Icon.svelte';
  import { clickOutside } from '../lib/actions';

  let {
    open = $bindable(false),
    collapsed = false,
    onfold,
  }: { open?: boolean; collapsed?: boolean; onfold?: () => void } = $props();
  let wsOpen = $state(false);
  let closeEl = $state<HTMLButtonElement>();
  let searchOpen = $state(false);
  let query = $state('');
  let searchEl = $state<HTMLInputElement>();

  const filteredRuns = $derived(
    query.trim()
      ? app.runs.filter((run) =>
          `${run.title} ${run.workspace}`.toLowerCase().includes(query.trim().toLowerCase()),
        )
      : app.runs,
  );

  const approvals = $derived(
    app.runs.filter((run) => run.status === 'approval' && !run.approval).length,
  );

  $effect(() => {
    if (open) closeEl?.focus();
  });

  $effect(() => {
    if (searchOpen) queueMicrotask(() => searchEl?.focus());
  });

  function go(page: Page) {
    app.go(page);
    open = false;
  }

  function home() {
    app.go('work');
    open = false;
  }

</script>

<aside class="side" class:open class:collapsed id="app-sidebar" inert={collapsed && !open}>
  <button
    class="side-close icon-btn"
    type="button"
    aria-label="Close navigation"
    bind:this={closeEl}
    onclick={() => (open = false)}
  >
    <Icon name="x" size={18} />
  </button>
  <button
    class="side-fold icon-btn"
    type="button"
    aria-label="Collapse sidebar"
    title="Collapse sidebar"
    onclick={() => onfold?.()}
  >
    <Icon name="panel-left" size={15} />
  </button>
  <button class="brand" type="button" onclick={home} title="Go to Work">
    <Mark size={22} />
    Splyce
  </button>

  <div class="ws-wrap" use:clickOutside={() => (wsOpen = false)}>
    <button class="ws" type="button" aria-expanded={wsOpen} onclick={() => (wsOpen = !wsOpen)}>
      <span class="ws-badge">PA</span>
      <span class="ws-name">{app.workspace.name}</span>
      <Icon name="chevron-down" size={13} />
    </button>
    {#if wsOpen}
      <div class="menu" transition:fly={{ y: -4, duration: 120 }}>
        <div class="menu-note">Local workspaces</div>
        {#each workspaces as workspace (workspace.id)}
          <button
            type="button"
            data-active={workspace.id === app.workspaceId}
            onclick={() => {
              app.setWorkspace(workspace.id);
              wsOpen = false;
            }}
          >
            <span>{workspace.name}</span>
            {#if workspace.id === app.workspaceId}
              <span style="margin-left:auto"><Icon name="check" size={13} /></span>
            {/if}
          </button>
        {/each}
      </div>
    {/if}
  </div>

  <button
    class="new-chat"
    type="button"
    onclick={() => {
      app.go('work');
      open = false;
    }}
  >
    <Icon name="plus" size={14} />
    New chat
  </button>

  <section class="recent" aria-labelledby="recent-label">
    <div class="recent-head">
      <h2 class="recent-label" id="recent-label">Recent</h2>
      <button
        class="recent-search"
        type="button"
        aria-label={searchOpen ? 'Close search' : 'Search recent chats'}
        title={searchOpen ? 'Close search' : 'Search recent chats'}
        onclick={() => {
          searchOpen = !searchOpen;
          if (!searchOpen) query = '';
        }}
      >
        <Icon name={searchOpen ? 'x' : 'search'} size={13} />
      </button>
    </div>
    {#if searchOpen}
      <input
        class="recent-input"
        bind:this={searchEl}
        type="search"
        placeholder="Search chats…"
        bind:value={query}
        aria-label="Search recent chats"
      />
    {/if}
    <div class="recent-list">
      {#each filteredRuns as run (run.id)}
        <button
          class="recent-item"
          type="button"
          class:active={app.page === 'run' && app.runId === run.id}
          onclick={() => {
            app.openRun(run.id);
            open = false;
          }}
        >
          <span class="recent-dot" data-status={run.status} aria-hidden="true"></span>
          <span class="recent-copy">
            <span class="recent-title">{run.title}</span>
            <span class="recent-meta">{run.workspace} · {run.updated}</span>
          </span>
        </button>
      {/each}
    </div>
  </section>

  <nav class="nav" aria-label="Workspace">
    <button class="nav-item" class:active={app.page === 'work'} onclick={() => go('work')}>
      <span class="n-ico"><Icon name="terminal" size={15} /></span>
      Work
    </button>
    <button
      class="nav-item"
      class:active={app.page === 'runs' || app.page === 'run'}
      onclick={() => go('runs')}
    >
      <span class="n-ico"><Icon name="clock" size={15} /></span>
      Runs
      {#if approvals}<span class="n-count">{approvals}</span>{/if}
    </button>
    <button class="nav-item" class:active={app.page === 'settings'} onclick={() => go('settings')}>
      <span class="n-ico"><Icon name="settings" size={15} /></span>
      Settings
    </button>
  </nav>

  <div class="side-foot">
    <div class="side-foot-row">
      <span class="side-status"><span class="dot"></span> Pi engine · local</span>
      <button
        class="icon-btn"
        type="button"
        aria-label={app.theme === 'light' ? 'Switch to dark theme' : 'Switch to light theme'}
        title={app.theme === 'light' ? 'Dark theme' : 'Light theme'}
        onclick={toggleThemeFrom}
      >
        <Icon name={app.theme === 'light' ? 'moon' : 'sun'} size={14} />
      </button>
    </div>
  </div>
</aside>

<style>
  .ws-wrap {
    position: relative;
    margin-bottom: 14px;
  }
  .ws-wrap .ws {
    margin-bottom: 0;
  }
  .ws-wrap :global(.menu) {
    top: calc(100% + 4px);
    left: 0;
    right: 0;
    min-width: 0;
  }
  .recent {
    display: flex;
    flex-direction: column;
    min-height: 0;
    flex: 1;
    margin: 4px 0 12px;
  }
  .recent-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 4px 5px 6px 9px;
  }
  .recent-label {
    margin: 0;
    font-size: 10px;
    font-weight: 500;
    line-height: 14px;
    letter-spacing: 0.09em;
    text-transform: uppercase;
    color: var(--text-faint);
  }
  .recent-search {
    display: grid;
    place-items: center;
    width: 22px;
    height: 22px;
    border: 0;
    border-radius: var(--r-sm);
    background: transparent;
    color: var(--text-faint);
    transition:
      background 0.15s,
      color 0.15s;
  }
  .recent-search:hover {
    background: var(--surface);
    color: var(--on-surface);
  }
  .recent-search:focus-visible {
    outline: 2px solid var(--primary);
    outline-offset: -1px;
  }
  .recent-input {
    width: 100%;
    margin-bottom: 4px;
    padding: 6px 8px;
    border: 1px solid var(--border);
    border-radius: var(--r-sm);
    background: var(--neutral);
    color: var(--on-surface);
    font: inherit;
    font-size: 12px;
  }
  .recent-input:focus {
    outline: 2px solid var(--primary);
    outline-offset: -1px;
  }
  .recent-list {
    display: flex;
    flex-direction: column;
    gap: 1px;
    overflow-y: auto;
  }
  .recent-item {
    display: flex;
    align-items: center;
    gap: 9px;
    width: 100%;
    padding: 7px 9px;
    border: 0;
    border-radius: var(--r-sm);
    background: transparent;
    text-align: left;
    transition: background 0.15s;
  }
  .recent-item:hover {
    background: var(--surface);
  }
  .recent-item.active {
    background: var(--surface);
  }
  .recent-item:focus-visible {
    outline: 2px solid var(--primary);
    outline-offset: -2px;
  }
  .recent-dot {
    width: 6px;
    height: 6px;
    border-radius: var(--r-full);
    background: var(--dot-idle);
    flex: none;
  }
  .recent-dot[data-status='approval'] {
    background: var(--error);
  }
  .recent-dot[data-status='running'] {
    background: var(--primary);
  }
  .recent-dot[data-status='verified'] {
    background: var(--add-text);
  }
  .recent-copy {
    display: flex;
    flex-direction: column;
    gap: 1px;
    min-width: 0;
  }
  .recent-title {
    overflow: hidden;
    font-size: 12.5px;
    font-weight: 500;
    line-height: 17px;
    color: var(--on-surface);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .recent-meta {
    overflow: hidden;
    font-size: 11px;
    line-height: 14px;
    color: var(--text-faint);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .new-chat {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 7px;
    width: 100%;
    margin-bottom: 14px;
    padding: 8px 10px;
    border: 1px solid var(--border);
    border-radius: var(--r-md);
    background: var(--surface);
    color: var(--on-surface);
    font-size: 13px;
    font-weight: 500;
    transition:
      background 0.15s,
      border-color 0.15s;
  }
  .new-chat:hover {
    background: var(--neutral);
    border-color: var(--hover-border);
  }
  .new-chat:focus-visible {
    outline: 2px solid var(--primary);
    outline-offset: 2px;
  }
  .side-close {
    display: none;
    position: absolute;
    top: 14px;
    right: 12px;
    width: 28px;
    height: 28px;
    z-index: 2;
  }
  @media (max-width: 820px) {
    .side-close {
      display: grid;
      top: 8px;
      right: 16px;
      width: 36px;
      height: 36px;
      border: 1px solid var(--border);
      background: var(--neutral);
      color: var(--on-surface);
    }
  }
</style>
