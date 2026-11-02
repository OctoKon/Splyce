<script lang="ts">
  let { size = 24 }: { size?: number } = $props();
</script>

<svg
  class="mark"
  width={size}
  height={size}
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="1.5"
  stroke-linecap="round"
  aria-hidden="true"
>
  <path d="M2 6h3.2c4.2 0 5 6 8.3 6H22" />
  <path d="M2 18h3.2c4.2 0 5-6 8.3-6" opacity=".55" />
  <path d="M2 12h5.5c3.1 0 3.4-6 6.5-6H22" opacity=".3" />
</svg>
