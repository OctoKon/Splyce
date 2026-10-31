<script lang="ts">
  import { tick } from 'svelte';
  import { fade } from 'svelte/transition';
  import { app } from './lib/state.svelte';
  import Icon from './lib/Icon.svelte';
  import Mark from './lib/Mark.svelte';
  import Toasts from './lib/Toasts.svelte';
  import TopBar from './lib/TopBar.svelte';
  import Landing from './views/Landing.svelte';
  import Sidebar from './views/Sidebar.svelte';
  import Work from './views/Work.svelte';
  import Runs from './views/Runs.svelte';
  import Run from './views/Run.svelte';
  import Memory from './views/Memory.svelte';
  import Models from './views/Models.svelte';
  import Extensions from './views/Extensions.svelte';
  import Settings from './views/Settings.svelte';

  let navOpen = $state(false);
  let menuBtn = $state<HTMLButtonElement>();
  let hadNav = false;
  let sidebarCollapsed = $state(localStorage.getItem('splyce.sidebar') === 'closed');
  const approvals = $derived(
    app.runs.filter((run) => run.status === 'approval' && !run.approval).length,
  );

  $effect(() => {
    if (navOpen) hadNav = true;
    else if (hadNav) {
      hadNav = false;
      menuBtn?.focus();
    }
  });

  $effect(() => {
    localStorage.setItem('splyce.sidebar', sidebarCollapsed ? 'closed' : 'open');
  });

  async function foldSidebar() {
    sidebarCollapsed = true;
    await tick();
  }

  async function unfoldSidebar() {
    sidebarCollapsed = false;
    await tick();
    document.querySelector<HTMLButtonElement>('#app-sidebar .side-fold')?.focus();
  }

  function toggleSidebar() {
    if (sidebarCollapsed) void unfoldSidebar();
    else void foldSidebar();
  }
</script>

<svelte:window
  onkeydown={(event) => {
    if (event.key === 'Escape') navOpen = false;
    if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'l') {
      event.preventDefault();
      app.toggleTheme();
    }
  }}
/>

{#if app.view === 'landing'}
  <Landing />
{:else}
  <div class="app" class:side-collapsed={sidebarCollapsed}>
    <Sidebar bind:open={navOpen} collapsed={sidebarCollapsed} onfold={foldSidebar} />
    {#if navOpen}
      <button
        class="scrim"
        type="button"
        aria-label="Close navigation"
        onclick={() => (navOpen = false)}
        transition:fade={{ duration: 120 }}
      ></button>
    {/if}
    <main class="main" class:session={app.page === 'run'} inert={navOpen}>
      <div
        class="mobile-bar"
        style:opacity={navOpen ? 0 : 1}
        style:pointer-events={navOpen ? 'none' : 'auto'}
      >
        <button
          class="mb-brand"
          type="button"
          aria-label="Splyce home"
          onclick={() => {
            navOpen = false;
            app.go('work');
          }}
        >
          <Mark size={19} />
          Splyce
        </button>
        <button
          class="mb-menu"
          type="button"
          aria-label={navOpen ? 'Close navigation' : 'Open navigation'}
          aria-expanded={navOpen}
          bind:this={menuBtn}
          onclick={() => (navOpen = !navOpen)}
        >
          <Icon name={navOpen ? 'x' : 'menu'} size={18} />
          {#if approvals}<span class="mb-badge">{approvals}</span>{/if}
        </button>
      </div>
      {#if app.page !== 'run'}
        <TopBar collapsed={sidebarCollapsed} ontoggle={toggleSidebar} />
      {/if}
      {#if app.page === 'work'}
        <Work />
      {:else if app.page === 'runs'}
        <Runs />
      {:else if app.page === 'run'}
        {#key app.runId}
          <Run {sidebarCollapsed} ontoggleSidebar={toggleSidebar} />
        {/key}
      {:else if app.page === 'memory'}
        <Memory />
      {:else if app.page === 'models'}
        <Models />
      {:else if app.page === 'extensions'}
        <Extensions />
      {:else if app.page === 'settings'}
        <Settings />
      {/if}
    </main>
  </div>
{/if}

<Toasts />

<style>
  @keyframes page-in {
    from {
      opacity: 0;
      transform: translateY(4px);
    }
    to {
      opacity: 1;
      transform: none;
    }
  }
  main :global(.page),
  main :global(.run) {
    animation: page-in 0.28s cubic-bezier(0.22, 1, 0.36, 1);
  }

  .mobile-bar {
    display: none;
  }
  .scrim {
    display: none;
  }
  .mb-brand {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0;
    font-family: var(--serif);
    font-size: 21px;
    font-weight: 700;
    line-height: 1;
    color: var(--on-surface);
  }
  .mb-menu {
    position: relative;
    width: 36px;
    height: 36px;
    display: grid;
    place-items: center;
    border: 1px solid var(--border);
    border-radius: var(--r-md);
    background: var(--neutral);
    color: var(--on-surface);
  }
  .mb-menu:hover {
    background: var(--surface);
  }
  .mb-badge {
    position: absolute;
    top: -5px;
    right: -5px;
    min-width: 16px;
    height: 16px;
    padding: 0 4px;
    display: grid;
    place-items: center;
    border-radius: var(--r-full);
    background: var(--error);
    color: #fff;
    font-size: 9px;
    font-weight: 600;
  }

  @media (max-width: 820px) {
    .mobile-bar {
      position: sticky;
      top: 0;
      z-index: 30;
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex: none;
      height: 52px;
      padding: 0 16px;
      border-bottom: 1px solid var(--border);
      background: var(--neutral);
      transition: opacity 0.15s var(--ease);
    }
    .scrim {
      position: fixed;
      inset: 0;
      z-index: 50;
      display: block;
      border: 0;
      background: rgba(10, 10, 10, 0.45);
      backdrop-filter: blur(1px);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    main :global(.page),
    main :global(.run) {
      animation: none;
    }
  }
</style>
