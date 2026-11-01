<script lang="ts" module>
  export const STATE_KINDS = [
    "loading",
    "empty",
    "error",
    "stale",
    "unavailable",
  ] as const;
  export type StateKind = (typeof STATE_KINDS)[number];
</script>

<script lang="ts">
  import type { Snippet } from "svelte";

  // Inert presentation: no handlers here; the parent flow owns actions.
  let {
    kind,
    title,
    detail,
    action,
  }: {
    kind: StateKind;
    title: string;
    detail?: string;
    action?: Snippet;
  } = $props();

  const LABEL: Readonly<Record<StateKind, string>> = {
    loading: "Loading",
    empty: "Nothing here yet",
    error: "Error",
    stale: "Out of date",
    unavailable: "Unavailable",
  };
  const GLYPH: Readonly<Record<StateKind, string>> = {
    loading: "…",
    empty: "○",
    error: "✕",
    stale: "↻",
    unavailable: "⊘",
  };
</script>

<div
  class="state state-{kind}"
  role={kind === "error" ? "alert" : "status"}
  aria-busy={kind === "loading" ? "true" : undefined}
  data-testid="state-message"
  data-kind={kind}
>
  <p class="kind">
    <span aria-hidden="true">{GLYPH[kind]}</span>
    <span data-testid="state-kind">{LABEL[kind]}</span>
  </p>
  <p class="title">{title}</p>
  {#if detail}<p class="detail">{detail}</p>{/if}
  {#if action}<div class="action">{@render action()}</div>{/if}
</div>

<style>
  .state {
    border: 1px solid currentColor;
    padding: 12px;
    overflow-wrap: anywhere;
  }
  .kind {
    font-weight: 600;
    margin: 0;
  }
</style>
