<script lang="ts">
  import type { StatusTone } from "../status-view";

  // Takes any projection result (projectStatus/projectTurnStatus/projectToolStatus/supportView).
  let {
    view,
    live = false,
  }: { view: { label: string; tone: StatusTone }; live?: boolean } = $props();
</script>

<!-- Meaning is the text; the tone glyph/colour is only an extra cue. -->
<span class="status-label" data-tone={view.tone} role={live ? "status" : undefined}
  >{view.label}</span
>

<style>
  .status-label {
    font-weight: 600;
  }
  .status-label[data-tone="positive"]::before {
    content: "\2713 ";
  }
  .status-label[data-tone="negative"]::before {
    content: "\2717 ";
  }
  .status-label[data-tone="warning"]::before {
    content: "! ";
  }
  .status-label[data-tone="unknown"]::before {
    content: "? ";
  }
</style>
