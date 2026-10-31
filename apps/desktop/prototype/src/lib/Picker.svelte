<script lang="ts">
  import Icon from './Icon.svelte';
  import type { IconName } from './icons';
  import { clickOutside } from './actions';
  import { fly } from 'svelte/transition';

  interface Option {
    value: string;
    label: string;
    note?: string;
  }

  let {
    label = '',
    value,
    options,
    icon,
    trigger,
    align = 'left',
    placement = 'down',
    onchange,
  }: {
    label?: string;
    value: string;
    options: Option[];
    icon?: IconName;
    trigger?: string;
    align?: 'left' | 'right';
    placement?: 'down' | 'up';
    onchange: (value: string) => void;
  } = $props();

  let open = $state(false);
  const current = $derived(options.find((option) => option.value === value)?.label ?? value);

  function choose(next: string) {
    open = false;
    onchange(next);
  }
</script>

<div class="picker" use:clickOutside={() => (open = false)}>
  <button
    type="button"
    aria-expanded={open}
    onclick={(event) => {
      event.stopPropagation();
      open = !open;
    }}
  >
    {#if icon}<Icon name={icon} size={13} />{/if}
    {#if label}<span class="plabel">{label}</span>{/if}
    {trigger ?? current}
    <Icon name="chevron-down" size={12} />
  </button>

  {#if open}
    <div
      class="menu"
      class:right={align === 'right'}
      class:up={placement === 'up'}
      transition:fly={{ y: placement === 'up' ? 4 : -4, duration: 120 }}
    >
      {#if options.length === 0}
        <div class="menu-note">Nothing available</div>
      {/if}
      {#each options as option (option.value)}
        <button
          type="button"
          data-active={option.value === value}
          onclick={() => choose(option.value)}
        >
          <span>{option.label}</span>
          {#if option.note}<span class="menu-note" style="margin-left:auto;padding:0"
              >{option.note}</span
            >{/if}
          {#if option.value === value}<span style="margin-left:auto;padding-left:8px"
              ><Icon name="check" size={13} /></span
            >{/if}
        </button>
      {/each}
    </div>
  {/if}
</div>

<style>
  .menu {
    top: calc(100% + 6px);
    left: 0;
  }
  .menu.right {
    left: auto;
    right: 0;
  }
  .menu.up {
    top: auto;
    bottom: calc(100% + 6px);
  }
</style>
