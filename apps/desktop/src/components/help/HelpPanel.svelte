<script lang="ts">
  import ShortcutReference from "./ShortcutReference.svelte";

  interface Props {
    onBack: () => void;
  }
  let { onBack }: Props = $props();

  // Help is inert text: it explains, it never runs an action.
  const topics = [
    { id: "start", title: "Getting started", body: "Setup connects an engine and a provider profile. Until setup completes, sessions are unavailable." },
    { id: "optional", title: "Optional modules", body: "A module that is not installed is shown as unavailable with the install choice; nothing installs implicitly." },
    { id: "recovery", title: "When something fails", body: "Failed or uncertain runs keep your prompt and partial output. Check the outcome before retrying: an external effect may already have happened." },
  ] as const;
</script>

<article aria-labelledby="help-title">
  <button type="button" onclick={onBack}>Back</button>
  <h1 id="help-title">Help</h1>
  <nav aria-label="Help topics">
    <ul>
      {#each topics as t (t.id)}
        <li><a href={`#help-${t.id}`}>{t.title}</a></li>
      {/each}
      <li><a href="#shortcut-ref-title">Keyboard shortcuts</a></li>
    </ul>
  </nav>
  {#each topics as t (t.id)}
    <section id={`help-${t.id}`} aria-labelledby={`help-${t.id}-h`}>
      <h2 id={`help-${t.id}-h`}>{t.title}</h2>
      <p>{t.body}</p>
    </section>
  {/each}
  <ShortcutReference />
</article>
