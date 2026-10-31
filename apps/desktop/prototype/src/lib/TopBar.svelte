<script lang="ts">
  import { app } from './state.svelte';
  import { toggleThemeFrom } from './theme';
  import Mark from './Mark.svelte';
  import Icon from './Icon.svelte';

  let { collapsed = false, ontoggle }: { collapsed?: boolean; ontoggle?: () => void } = $props();

  const KEY = 'splyce.greeting';
  let greeting = $state('Hello greeting');
  let editing = $state(false);
  let input = $state<HTMLInputElement>();

  $effect(() => {
    const saved = localStorage.getItem(KEY);
    if (saved) greeting = saved;
  });

  function startEdit() {
    editing = true;
    queueMicrotask(() => {
      input?.focus();
      input?.select();
    });
  }

  function commit() {
    const next = (input?.value ?? greeting).trim() || 'Hello greeting';
    greeting = next;
    localStorage.setItem(KEY, next);
    editing = false;
  }

  function newChat() {
    app.go('work');
    app.toast('New chat');
  }
</script>

<header class="topbar">
  {#if collapsed}
    {#if app.page === 'work'}
      <div class="brand-mark">
        <Mark size={22} />
      </div>

      <div class="pill">
        <button
          class="pill-btn"
          type="button"
          aria-label="Open sidebar"
          title="Open sidebar"
          onclick={ontoggle}
        >
          <Icon name="panel-left" size={16} />
        </button>
        <button
          class="pill-btn"
          type="button"
          aria-label="Search"
          title="Search"
          onclick={() => app.toast('Search is not wired yet')}
        >
          <Icon name="search" size={16} />
        </button>
        <button
          class="pill-btn"
          type="button"
          aria-label={app.theme === 'light' ? 'Switch to dark theme' : 'Switch to light theme'}
          title={app.theme === 'light' ? 'Dark theme' : 'Light theme'}
          onclick={toggleThemeFrom}
        >
          <Icon name={app.theme === 'light' ? 'moon' : 'sun'} size={16} />
        </button>
        <button
          class="pill-btn"
          type="button"
          aria-label="New chat"
          title="New chat"
          onclick={newChat}
        >
          <Icon name="plus-circle" size={16} />
        </button>
      </div>
    {:else}
      <div class="pill solo">
        <button
          class="pill-btn"
          type="button"
          aria-label="Open sidebar"
          title="Open sidebar"
          onclick={ontoggle}
        >
          <Icon name="panel-left" size={16} />
        </button>
      </div>
    {/if}
  {/if}

  {#if app.page === 'work'}
    {#if editing}
      <input
        class="greeting-input"
        bind:this={input}
        bind:value={greeting}
        onblur={commit}
        onkeydown={(e) => {
          if (e.key === 'Enter') commit();
          if (e.key === 'Escape') editing = false;
        }}
        aria-label="Greeting"
      />
    {:else}
      <button class="greeting" type="button" onclick={startEdit} title="Click to edit greeting">
        {greeting}
      </button>
    {/if}
  {/if}
</header>

<style>
  .topbar {
    position: sticky;
    top: 0;
    z-index: 30;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 14px;
    min-height: 48px;
    background: var(--neutral);
  }
  .brand-mark {
    display: grid;
    place-items: center;
    color: var(--primary);
  }
  .pill {
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 3px;
    border: 1px solid var(--border);
    border-radius: var(--r-full);
    background: var(--surface);
  }
  .pill-btn {
    display: grid;
    place-items: center;
    width: 30px;
    height: 30px;
    border: 0;
    border-radius: var(--r-full);
    background: transparent;
    color: var(--text-muted);
    transition:
      background 0.15s,
      color 0.15s;
  }
  .pill-btn:hover {
    background: var(--neutral);
    color: var(--on-surface);
  }
  .pill-btn:focus-visible {
    outline: 2px solid var(--primary);
    outline-offset: 1px;
  }
  .greeting {
    border: 0;
    background: transparent;
    padding: 4px 6px;
    border-radius: var(--r-sm);
    color: var(--on-surface);
    font-size: 15px;
    font-weight: 500;
    line-height: 1.4;
    transition: background 0.15s;
  }
  .greeting:hover {
    background: var(--surface);
  }
  .greeting:focus-visible {
    outline: 2px solid var(--primary);
    outline-offset: 2px;
  }
  .greeting-input {
    width: min(320px, 45vw);
    padding: 4px 6px;
    border: 1px solid var(--border);
    border-radius: var(--r-sm);
    background: var(--neutral);
    color: var(--on-surface);
    font: inherit;
    font-size: 15px;
    font-weight: 500;
  }
  .greeting-input:focus {
    outline: 2px solid var(--primary);
    outline-offset: 1px;
  }
  @media (max-width: 820px) {
    .brand-mark,
    .pill {
      display: none;
    }
  }
</style>
