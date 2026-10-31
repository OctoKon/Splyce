<script lang="ts">
  import type { Snippet } from 'svelte';
  import { onDestroy } from 'svelte';
  import Icon from './Icon.svelte';
  import type { IconName } from './icons';
  import { clickOutside } from './actions';

  type Attachment = { id: number; name: string; kind: 'image' | 'file' };
  type Source = 'photo' | 'camera' | 'file' | 'folder' | 'audio' | 'video';

  const dialOptions: { source: Source; label: string; icon: IconName }[] = [
    { source: 'photo', label: 'Photo', icon: 'image' },
    { source: 'camera', label: 'Camera', icon: 'camera' },
    { source: 'video', label: 'Video', icon: 'video' },
    { source: 'audio', label: 'Audio', icon: 'audio' },
    { source: 'file', label: 'File', icon: 'file' },
    { source: 'folder', label: 'Folder', icon: 'folder' },
  ];

  let {
    value = $bindable(''),
    placeholder = 'Describe a task…',
    onsend,
    children,
    disabled = false,
    compact = false,
    allowAttachments = false,
  }: {
    value?: string;
    placeholder?: string;
    onsend: (value: string) => void;
    children?: Snippet;
    disabled?: boolean;
    compact?: boolean;
    allowAttachments?: boolean;
  } = $props();

  let el: HTMLTextAreaElement | undefined = $state();
  let attachOpen = $state(false);
  let attachPinned = $state(false);
  let suppressHover = false;
  let attachBtn = $state<HTMLButtonElement>();
  let photoInput = $state<HTMLInputElement>();
  let cameraInput = $state<HTMLInputElement>();
  let fileInput = $state<HTMLInputElement>();
  let folderInput = $state<HTMLInputElement>();
  let audioInput = $state<HTMLInputElement>();
  let videoInput = $state<HTMLInputElement>();
  let attachments = $state<Attachment[]>([]);
  let nextAttachment = 0;
  let attachTimer: ReturnType<typeof setTimeout> | undefined;

  onDestroy(() => {
    if (attachTimer) clearTimeout(attachTimer);
  });

  $effect(() => {
    // read value so the height follows programmatic clears as well
    value;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, compact ? 120 : 180)}px`;
  });

  function submit() {
    const trimmed = value.trim();
    if ((!trimmed && attachments.length === 0) || disabled) return;
    const text = attachments.length
      ? `${trimmed}${trimmed ? '\n' : ''}Attached: ${attachments.map((file) => file.name).join(', ')}`
      : trimmed;
    onsend(text);
    value = '';
    attachments = [];
    closeAttachments();
  }

  function cancelAttachTimer() {
    if (attachTimer) clearTimeout(attachTimer);
    attachTimer = undefined;
  }

  function openAttachments() {
    if (suppressHover) return;
    cancelAttachTimer();
    attachOpen = true;
  }

  function closeAttachments() {
    cancelAttachTimer();
    attachOpen = false;
    attachPinned = false;
  }

  function scheduleAttachClose() {
    suppressHover = false;
    if (attachPinned) return;
    cancelAttachTimer();
    attachTimer = setTimeout(() => {
      attachOpen = false;
      attachPinned = false;
    }, 180);
  }

  function toggleAttachments() {
    cancelAttachTimer();
    if (attachOpen && attachPinned) {
      closeAttachments();
      return;
    }
    attachOpen = true;
    attachPinned = true;
  }

  function onAttachKey(event: KeyboardEvent) {
    if (event.key === 'Escape' && attachOpen) {
      event.stopPropagation();
      closeAttachments();
      attachBtn?.focus();
    }
  }

  function pick(source: Source) {
    suppressHover = true;
    const inputs: Record<Source, HTMLInputElement | undefined> = {
      photo: photoInput,
      camera: cameraInput,
      file: fileInput,
      folder: folderInput,
      audio: audioInput,
      video: videoInput,
    };
    closeAttachments();
    inputs[source]?.click();
    requestAnimationFrame(() => attachBtn?.focus());
  }

  function addPicked(event: Event, kind: Attachment['kind']) {
    const input = event.currentTarget as HTMLInputElement;
    const picked = Array.from(input.files ?? []);
    if (picked.length) {
      attachments = [
        ...attachments,
        ...picked.map((file) => ({
          id: ++nextAttachment,
          name: file.name,
          kind,
        })),
      ];
    }
    input.value = '';
    closeAttachments();
    attachBtn?.focus();
  }

  function removeAttachment(id: number) {
    attachments = attachments.filter((file) => file.id !== id);
    attachBtn?.focus();
  }
</script>

<div class="composer" class:compact class:shine={value.trim().length > 0}>
  <div class="c-top">
    {#if allowAttachments}
      <div class="attach" use:clickOutside={closeAttachments}>
        <button
          class="attach-btn icon-btn"
          type="button"
          aria-label="Add attachment"
          title="Add attachment"
          aria-haspopup="menu"
          aria-expanded={attachOpen}
          bind:this={attachBtn}
          onmouseenter={openAttachments}
          onmouseleave={scheduleAttachClose}
          onkeydown={onAttachKey}
          onclick={toggleAttachments}
        >
          <Icon name="plus" size={16} />
        </button>
        {#if attachOpen}
          <div
            class="menu attach-menu attach-dial"
            role="menu"
            aria-label="Add attachment"
            tabindex="-1"
            onmouseenter={cancelAttachTimer}
            onmouseleave={scheduleAttachClose}
            onkeydown={onAttachKey}
          >
            {#each dialOptions as option, i}
              <button
                type="button"
                role="menuitem"
                aria-label={option.label}
                title={option.label}
                style={`--i:${i}`}
                onmouseenter={cancelAttachTimer}
                onmouseleave={scheduleAttachClose}
                onclick={() => pick(option.source)}
              >
                <Icon name={option.icon} size={20} />
              </button>
            {/each}
          </div>
        {/if}
        <input
          hidden
          type="file"
          accept="image/*"
          multiple
          bind:this={photoInput}
          onchange={(event) => addPicked(event, 'image')}
        />
        <input
          hidden
          type="file"
          accept="image/*"
          capture="environment"
          bind:this={cameraInput}
          onchange={(event) => addPicked(event, 'image')}
        />
        <input
          hidden
          type="file"
          multiple
          bind:this={fileInput}
          onchange={(event) => addPicked(event, 'file')}
        />
        <input
          hidden
          type="file"
          webkitdirectory
          multiple
          bind:this={folderInput}
          onchange={(event) => addPicked(event, 'file')}
        />
        <input
          hidden
          type="file"
          accept="audio/*"
          multiple
          bind:this={audioInput}
          onchange={(event) => addPicked(event, 'file')}
        />
        <input
          hidden
          type="file"
          accept="video/*"
          multiple
          bind:this={videoInput}
          onchange={(event) => addPicked(event, 'file')}
        />
      </div>
    {/if}
    <textarea
      bind:this={el}
      bind:value
      {placeholder}
      rows={compact ? 1 : 2}
      aria-label={placeholder}
      onkeydown={(event) => {
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault();
          submit();
        }
      }}></textarea>
  </div>
  {#if allowAttachments && attachments.length > 0}
    <div class="c-files">
      {#each attachments as attachment (attachment.id)}
        <span class="c-file" title={attachment.name}>
          <Icon name={attachment.kind === 'image' ? 'image' : 'file'} size={12} />
          <span class="c-file-name">{attachment.name}</span>
          <button
            class="c-file-x"
            type="button"
            aria-label={`Remove ${attachment.name}`}
            onclick={() => removeAttachment(attachment.id)}
          >
            <Icon name="x" size={11} />
          </button>
        </span>
      {/each}
    </div>
  {/if}
  <div class="c-bottom">
    {#if children}{@render children()}{/if}
    <span class="spacer"></span>
    <button
      class="send"
      type="button"
      aria-label="Send"
      onclick={submit}
      disabled={(!value.trim() && attachments.length === 0) || disabled}
    >
      <Icon name="arrow-up" size={15} stroke={2} />
    </button>
  </div>
</div>

<style>
  .composer.compact {
    border-radius: var(--r-lg);
  }
</style>
