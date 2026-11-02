<script lang="ts">
  import type { IconName } from "./icons";

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
  {#if name === "chevron-down"}
    <path d="m6 9 6 6 6-6" />
  {:else if name === "chevron-left"}
    <path d="m15 6-6 6 6 6" />
  {:else if name === "chevron-right"}
    <path d="m9 6 6 6-6 6" />
  {:else if name === "x"}
    <path d="M6 6l12 12M18 6L6 18" />
  {:else if name === "arrow-up"}
    <path d="M12 20V4M6 10l6-6 6 6" />
  {:else if name === "menu"}
    <path d="M4 7h16M4 12h16M4 17h16" />
  {:else if name === "terminal"}
    <path d="m4 7 4 5-4 5M11 17h9" />
  {:else if name === "shield"}
    <path d="M12 3l7 3v5.5c0 4.2-3 7.6-7 9.5-4-1.9-7-5.3-7-9.5V6z" />
    <path d="m9 12 2 2 4-4" />
  {:else if name === "database"}
    <ellipse cx="12" cy="6" rx="7" ry="3" />
    <path
      d="M5 6v6c0 1.7 3.1 3 7 3s7-1.3 7-3V6M5 12v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6"
    />
  {:else if name === "cpu"}
    <rect x="7" y="7" width="10" height="10" rx="1.5" />
    <path d="M10 2v3M14 2v3M10 19v3M14 19v3M2 10h3M2 14h3M19 10h3M19 14h3" />
  {:else if name === "settings"}
    <circle cx="12" cy="12" r="3" />
    <path
      d="M19 12a7 7 0 0 0-.1-1.2l2-1.5-2-3.4-2.3 1a7 7 0 0 0-2-1.2L14.2 3h-4l-.4 2.5a7 7 0 0 0-2 1.2l-2.3-1-2 3.4 2 1.5a7 7 0 0 0 0 2.4l-2 1.5 2 3.4 2.3-1a7 7 0 0 0 2 1.2l.4 2.5h4l.4-2.5a7 7 0 0 0 2-1.2l2.3 1 2-3.4-2-1.5c.1-.4.1-.8.1-1.2z"
    />
  {:else if name === "layers"}
    <path d="m12 3 9 5-9 5-9-5zM3 13l9 5 9-5M3 18l9 5 9-5" />
  {:else if name === "clock"}
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  {:else if name === "folder"}
    <path d="M3 6h6l2 2h10v11H3z" />
  {:else if name === "lock"}
    <rect x="5" y="10" width="14" height="10" rx="2" />
    <path d="M8 10V7a4 4 0 0 1 8 0v3" />
  {:else if name === "sun"}
    <circle cx="12" cy="12" r="4" />
    <path
      d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"
    />
  {:else if name === "moon"}
    <path d="M20 14.5A8 8 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z" />
  {/if}
</svg>
