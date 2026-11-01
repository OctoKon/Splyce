<script lang="ts">
  import { filterCommands, type CommandRegistry } from "../../stores/commands";

  interface Props {
    registry: CommandRegistry;
    open: boolean;
    /** Visible current scope, e.g. "Workspace: splyce". */
    scopeLabel: string;
  }
  let { registry, open = $bindable(), scopeLabel }: Props = $props();

  let query = $state("");
  let active = $state(0);
  let notice = $state("");
  let input = $state<HTMLInputElement>();
  let opener: HTMLElement | null = null;

  // Availability is recomputed from the registry on every render of the open palette.
  let items = $derived(
    open
      ? filterCommands(
          registry.list().filter((c) => c.palette),
          query,
        )
      : [],
  );

  $effect(() => {
    if (open) {
      opener = document.activeElement as HTMLElement | null;
      query = "";
      active = 0;
      notice = "";
      queueMicrotask(() => input?.focus());
    }
  });

  $effect(() => {
    void query;
    active = 0;
  });

  function close() {
    open = false;
    const target = opener;
    opener = null;
    target?.focus();
  }

  async function runActive() {
    const item = items[active];
    if (!item) return;
    const result = await registry.run(item.id);
    if (result.ok) close();
    else notice = result.reason;
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.isComposing) return; // Enter confirms IME candidates, never runs a command
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      if (items.length) active = (active + 1) % items.length;
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (items.length) active = (active - 1 + items.length) % items.length;
    } else if (e.key === "Enter") {
      e.preventDefault();
      void runActive();
    } else if (e.key === "Tab") {
      e.preventDefault(); // focus stays in the modal
    }
  }
</script>

{#if open}
  <div class="palette-backdrop">
    <div
      class="palette"
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
    >
      <p class="scope">Scope: {scopeLabel}</p>
      <input
        bind:this={input}
        bind:value={query}
        onkeydown={onKeydown}
        type="text"
        role="combobox"
        aria-label="Search commands"
        aria-expanded="true"
        aria-controls="palette-list"
        aria-activedescendant={items[active] ? `palette-${items[active].id}` : undefined}
        autocomplete="off"
      />
      <ul id="palette-list" role="listbox" aria-label="Commands">
        {#each items as item, i (item.id)}
          <!-- svelte-ignore a11y_click_events_have_key_events -->
          <li
            id={`palette-${item.id}`}
            role="option"
            aria-selected={i === active}
            aria-disabled={!item.enabled}
            class:active={i === active}
            onclick={() => {
              active = i;
              void runActive();
            }}
          >
            <span class="label">{item.label}</span>
            {#if item.shortcuts.length}<kbd>{item.shortcuts.join(" / ")}</kbd>{/if}
            {#if !item.enabled}<span class="reason">Unavailable: {item.reason}</span>{/if}
          </li>
        {/each}
      </ul>
      {#if items.length === 0}
        <p role="status">No matching commands</p>
      {/if}
      <p role="status" class="notice">{notice}</p>
    </div>
  </div>
{/if}

<style>
  .palette-backdrop {
    position: fixed;
    inset: 0;
    display: grid;
    place-items: start center;
    padding-top: 12vh;
    background: rgb(0 0 0 / 0.4);
  }
  .palette {
    width: min(40rem, 92vw);
    background: Canvas;
    color: CanvasText;
    border: 1px solid CanvasText;
    border-radius: 8px;
    padding: 0.75rem;
  }
  .scope,
  .reason {
    opacity: 0.8;
    font-size: 0.85em;
  }
  input {
    width: 100%;
    box-sizing: border-box;
  }
  ul {
    list-style: none;
    margin: 0.5rem 0 0;
    padding: 0;
    max-height: 50vh;
    overflow: auto;
  }
  li {
    display: flex;
    gap: 0.75rem;
    align-items: baseline;
    padding: 0.4rem 0.5rem;
  }
  li.active {
    outline: 2px solid Highlight;
    outline-offset: -2px;
  }
  li[aria-disabled="true"] .label {
    text-decoration: line-through;
  }
  .label {
    flex: 1;
  }
</style>
