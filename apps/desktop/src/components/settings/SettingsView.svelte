<script module lang="ts">
  export interface SettingsItem {
    readonly label: string;
    /** Real value from existing safe status; absent means not configurable yet. */
    readonly value?: string;
  }
  export interface SettingsSection {
    readonly id: string;
    readonly title: string;
    readonly items: readonly SettingsItem[];
    readonly helpTopic?: string;
  }
</script>

<script lang="ts">
  interface Props {
    sections: readonly SettingsSection[];
    onBack: () => void;
  }
  let { sections, onBack }: Props = $props();
</script>

<main aria-labelledby="settings-title">
  <button type="button" onclick={onBack}>Back</button>
  <h1 id="settings-title">Settings</h1>
  <p>Read-only. Changes are not available from this screen yet.</p>
  {#each sections as s (s.id)}
    <section aria-labelledby={`settings-${s.id}`}>
      <h2 id={`settings-${s.id}`}>{s.title}</h2>
      <dl>
        {#each s.items as item (item.label)}
          <dt>{item.label}</dt>
          <dd>{item.value ?? "Not configurable yet"}</dd>
        {/each}
      </dl>
      {#if s.helpTopic}<a href={`#help-${s.helpTopic}`}>Help: {s.title}</a>{/if}
    </section>
  {/each}
</main>
