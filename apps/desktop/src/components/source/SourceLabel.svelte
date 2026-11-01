<script lang="ts">
  import { isUntrusted, SOURCE_VIEWS, type SourceKind } from "./source-kinds";

  let {
    kind,
    sourceId = null,
    untrusted,
  }: { kind: SourceKind; sourceId?: string | null; untrusted?: boolean } =
    $props();

  const view = $derived(
    Object.hasOwn(SOURCE_VIEWS, kind) ? SOURCE_VIEWS[kind] : null,
  );
  // Unknown kinds are never presented as a trusted source.
  const risky = $derived(view === null ? true : isUntrusted(kind, untrusted));
  const text = $derived(view?.label ?? "Unknown source");
  const name = $derived(
    `Source: ${text}${risky ? ", untrusted" : ""}${sourceId ? `, id ${sourceId}` : ""}`,
  );
</script>

<span
  class="source-label"
  class:untrusted={risky}
  data-testid="source-label"
  data-kind={view ? kind : "unknown"}
  role="group"
  aria-label={name}
  title={sourceId ?? undefined}
>
  <span class="glyph" aria-hidden="true">{view?.glyph ?? "?"}</span>
  <span class="text" aria-hidden="true">{text}</span>
  {#if risky}<span class="mark" aria-hidden="true" data-testid="untrusted-mark"
      >(untrusted)</span
    >{/if}
</span>

<style>
  .source-label {
    display: inline-flex;
    gap: 0.25em;
    align-items: baseline;
    max-width: 100%;
    overflow-wrap: anywhere;
    user-select: text;
  }
  .glyph {
    font-weight: 700;
    border: 1px solid currentColor;
    border-radius: 3px;
    padding: 0 0.3em;
  }
  .untrusted {
    border-bottom: 2px dashed currentColor;
  }
</style>
