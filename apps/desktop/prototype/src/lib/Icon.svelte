<script lang="ts">
  import type { IconName } from './icons';

  let {
    name,
    size = 16,
    stroke = 1.6,
  }: { name: IconName; size?: number; stroke?: number } = $props();
</script>

<svg
  width={size}
  height={size}
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width={stroke}
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
>
  {#if name === 'search'}
    <circle cx="11" cy="11" r="7" />
    <path d="m16.5 16.5 4 4" />
  {:else if name === 'plus'}
    <path d="M12 5v14M5 12h14" />
  {:else if name === 'plus-circle'}
    <circle cx="12" cy="12" r="9" />
    <path d="M12 8v8M8 12h8" />
  {:else if name === 'panel-left'}
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M9 4v16" />
  {:else if name === 'chevron-down'}
    <path d="m6 9 6 6 6-6" />
  {:else if name === 'chevron-left'}
    <path d="m15 6-6 6 6 6" />
  {:else if name === 'chevron-right'}
    <path d="m9 6 6 6-6 6" />
  {:else if name === 'check'}
    <path d="m4 12.5 5 5L20 6.5" />
  {:else if name === 'x'}
    <path d="M6 6l12 12M18 6L6 18" />
  {:else if name === 'arrow-right'}
    <path d="M4 12h16M14 6l6 6-6 6" />
  {:else if name === 'arrow-up-right'}
    <path d="M7 17 17 7M8 7h9v9" />
  {:else if name === 'arrow-up'}
    <path d="M12 20V4M6 10l6-6 6 6" />
  {:else if name === 'more'}
    <circle cx="5" cy="12" r="1" fill="currentColor" stroke="none" />
    <circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" />
    <circle cx="19" cy="12" r="1" fill="currentColor" stroke="none" />
  {:else if name === 'menu'}
    <path d="M4 7h16M4 12h16M4 17h16" />
  {:else if name === 'terminal'}
    <path d="m4 7 4 5-4 5M11 17h9" />
  {:else if name === 'shield'}
    <path d="M12 3l7 3v5.5c0 4.2-3 7.6-7 9.5-4-1.9-7-5.3-7-9.5V6z" />
    <path d="m9 12 2 2 4-4" />
  {:else if name === 'file'}
    <path d="M6 3h8l4 4v14H6z" />
    <path d="M14 3v4h4M9 13h6M9 17h6" />
  {:else if name === 'image'}
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <circle cx="9" cy="10" r="2" />
    <path d="m21 15-5-5L5 20" />
  {:else if name === 'camera'}
    <path d="M4 7h3l2-2h6l2 2h3v12H4z" />
    <circle cx="12" cy="13" r="4" />
  {:else if name === 'audio'}
    <rect x="9" y="3" width="6" height="11" rx="3" />
    <path d="M5 11a7 7 0 0 0 14 0M12 18v3M9 21h6" />
  {:else if name === 'video'}
    <rect x="3" y="6" width="13" height="12" rx="2" />
    <path d="m16 10 5-3v10l-5-3z" />
  {:else if name === 'branch'}
    <circle cx="6" cy="5" r="2" />
    <circle cx="6" cy="19" r="2" />
    <circle cx="18" cy="7" r="2" />
    <path d="M6 7v10M18 9c0 4-4 4-6 5.5" />
  {:else if name === 'database'}
    <ellipse cx="12" cy="6" rx="7" ry="3" />
    <path d="M5 6v6c0 1.7 3.1 3 7 3s7-1.3 7-3V6M5 12v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6" />
  {:else if name === 'cpu'}
    <rect x="7" y="7" width="10" height="10" rx="1.5" />
    <path d="M10 2v3M14 2v3M10 19v3M14 19v3M2 10h3M2 14h3M19 10h3M19 14h3" />
  {:else if name === 'settings'}
    <circle cx="12" cy="12" r="3" />
    <path
      d="M19 12a7 7 0 0 0-.1-1.2l2-1.5-2-3.4-2.3 1a7 7 0 0 0-2-1.2L14.2 3h-4l-.4 2.5a7 7 0 0 0-2 1.2l-2.3-1-2 3.4 2 1.5a7 7 0 0 0 0 2.4l-2 1.5 2 3.4 2.3-1a7 7 0 0 0 2 1.2l.4 2.5h4l.4-2.5a7 7 0 0 0 2-1.2l2.3 1 2-3.4-2-1.5c.1-.4.1-.8.1-1.2z"
    />
  {:else if name === 'layers'}
    <path d="m12 3 9 5-9 5-9-5zM3 13l9 5 9-5M3 18l9 5 9-5" />
  {:else if name === 'clock'}
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  {:else if name === 'play'}
    <path d="m8 5 11 7-11 7z" />
  {:else if name === 'stop'}
    <rect x="6" y="6" width="12" height="12" rx="1.5" />
  {:else if name === 'refresh'}
    <path d="M20 11a8 8 0 1 0-2 6.3M20 5v6h-6" />
  {:else if name === 'download'}
    <path d="M12 3v12M7 10l5 5 5-5M4 21h16" />
  {:else if name === 'folder'}
    <path d="M3 6h6l2 2h10v11H3z" />
  {:else if name === 'lock'}
    <rect x="5" y="10" width="14" height="10" rx="2" />
    <path d="M8 10V7a4 4 0 0 1 8 0v3" />
  {:else if name === 'eye'}
    <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12z" />
    <circle cx="12" cy="12" r="2.5" />
  {:else if name === 'copy'}
    <rect x="8" y="8" width="11" height="12" rx="2" />
    <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h2" />
  {:else if name === 'trash'}
    <path d="M4 7h16M9 7V5h6v2M6 7l1 14h10l1-14M10 11v6M14 11v6" />
  {:else if name === 'sun'}
    <circle cx="12" cy="12" r="4" />
    <path
      d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"
    />
  {:else if name === 'moon'}
    <path d="M20 14.5A8 8 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z" />
  {:else if name === 'alert'}
    <path d="M12 3 2.8 20h18.4zM12 9v5M12 17.5v.5" />
  {:else if name === 'external'}
    <path d="M14 4h6v6M20 4l-9 9M18 14v6H4V6h6" />
  {:else if name === 'sliders'}
    <path d="M4 7h9M17 7h3M4 17h3M11 17h9" />
    <circle cx="15" cy="7" r="2" />
    <circle cx="9" cy="17" r="2" />
  {:else if name === 'server'}
    <rect x="3" y="4" width="18" height="6" rx="1.5" />
    <rect x="3" y="14" width="18" height="6" rx="1.5" />
    <path d="M7 7h.01M7 17h.01" />
  {:else if name === 'tool'}
    <path d="M14.5 6.5a4 4 0 1 0 4 4L9 20H4v-5l9.5-9.5z" />
  {:else if name === 'receipt'}
    <path d="M5 3h14v18l-3-2-2 2-2-2-2 2-2-2-3 2z" />
    <path d="M9 8h6M9 12h6" />
  {:else if name === 'message'}
    <path d="M21 12a8 8 0 0 1-8 8H4l2-4a8 8 0 1 1 15-4z" />
  {:else if name === 'git'}
    <circle cx="12" cy="18" r="3" />
    <circle cx="6" cy="6" r="3" />
    <path d="M18 9a6 6 0 0 1-6 6M6 9v9" />
  {:else if name === 'key'}
    <circle cx="8" cy="8" r="4" />
    <path d="m11 11 9 9M16 16l2-2M19 19l2-2" />
  {:else if name === 'spark'}
    <path
      d="M12 3v4M12 17v4M4.9 4.9l2.8 2.8M16.3 16.3l2.8 2.8M3 12h4M17 12h4M4.9 19.1l2.8-2.8M16.3 7.7l2.8-2.8"
    />
  {:else if name === 'sort'}
    <path d="M7 4v16M3 16l4 4 4-4M17 20V4M13 8l4-4 4 4" />
  {/if}
</svg>
