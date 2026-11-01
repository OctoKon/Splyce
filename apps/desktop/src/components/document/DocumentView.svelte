<script lang="ts">
  import { parseMarkdown, type Inline } from "./markdown";

  let {
    source,
    format = "markdown",
    onOpenLink,
    onCopy = (t: string) => navigator.clipboard.writeText(t),
  }: {
    source: string;
    format?: "markdown" | "text";
    onOpenLink?: (href: string) => void;
    onCopy?: (text: string) => void | Promise<void>;
  } = $props();

  const blocks = $derived(format === "text" ? [] : parseMarkdown(source));
  let copied = $state<number | null>(null);

  async function copy(i: number, v: string): Promise<void> {
    try {
      await onCopy(v);
      copied = i;
    } catch {
      copied = null;
    }
  }
</script>

{#snippet inline(items: Inline[])}
  {#each items as n, k (k)}
    {#if n.t === "text"}{n.v}
    {:else if n.t === "code"}<code>{n.v}</code>
    {:else if n.t === "strong"}<strong>{n.v}</strong>
    {:else if n.t === "em"}<em>{n.v}</em>
    {:else if n.t === "link"}
      <button type="button" class="link" onclick={() => onOpenLink?.(n.href)}>{n.v}</button>
      <span class="dest" data-testid="link-destination">({n.href})</span>
    {:else}
      {n.v} <span class="dest" data-testid="link-destination">({n.href}, not openable)</span>
    {/if}
  {/each}
{/snippet}

<div class="doc" data-testid="document-view">
  {#if format === "text"}
    <pre class="plain">{source}</pre>
  {:else}
    {#each blocks as b, i (i)}
      {#if b.t === "p"}
        <p>{@render inline(b.inl)}</p>
      {:else if b.t === "h"}
        <div role="heading" aria-level={b.level}>{@render inline(b.inl)}</div>
      {:else if b.t === "list"}
        {#if b.ordered}
          <ol>{#each b.items as it, k (k)}<li>{@render inline(it)}</li>{/each}</ol>
        {:else}
          <ul>{#each b.items as it, k (k)}<li>{@render inline(it)}</li>{/each}</ul>
        {/if}
      {:else}
        <div class="codeblock">
          <div class="codebar">
            <span>{b.lang || "text"}</span>
            <button type="button" aria-label="Copy code{b.lang ? ` (${b.lang})` : ''}" onclick={() => copy(i, b.v)}
              >{copied === i ? "Copied" : "Copy"}</button
            >
          </div>
          <pre><code>{b.v}</code></pre>
        </div>
      {/if}
    {/each}
  {/if}
</div>

<style>
  .doc { overflow-wrap: anywhere; }
  pre { white-space: pre-wrap; overflow-wrap: anywhere; margin: 0; }
  .codeblock { border: 1px solid var(--border, #e5e7eb); border-radius: var(--radius-md, 8px); }
  .codebar { display: flex; justify-content: space-between; padding: 2px 8px; }
  .link { background: none; border: 0; padding: 0; color: var(--link, #2563eb); text-decoration: underline; cursor: pointer; font: inherit; }
  .dest { color: var(--text-muted, #6b7280); }
  button:focus-visible { outline: 2px solid var(--focus, #2563eb); outline-offset: 2px; }
</style>
