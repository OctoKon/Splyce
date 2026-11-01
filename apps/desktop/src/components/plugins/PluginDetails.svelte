<script lang="ts">
  import { projectStatus } from "../../status-view";
  import SourceLabel from "../source/SourceLabel.svelte";
  import type { Compatibility, PluginRecord } from "./compat";

  let {
    record,
    compatibility = null,
    trusted = true,
  }: {
    record: PluginRecord;
    compatibility?: Compatibility | null;
    trusted?: boolean;
  } = $props();

  const install = $derived(projectStatus("packageInstallation", record));
  // Anything but an explicit compatible/incompatible result is unknown.
  const compat = $derived.by(() => {
    const c = compatibility;
    if (c?.kind === "compatible") return { text: "Compatible", reason: "" };
    if (c?.kind === "incompatible")
      return { text: "Incompatible", reason: c.reason };
    return { text: "Compatibility unknown", reason: "" };
  });
</script>

<section
  class="plugin"
  aria-label={`Plugin ${record.packageId}`}
  data-testid="plugin-details"
>
  <h3>{record.packageId}</h3>
  <dl>
    <dt>Revision</dt>
    <dd data-testid="plugin-revision">{record.installationRevision}</dd>
    <dt>Source</dt>
    <dd>
      <SourceLabel kind="plugin" sourceId={record.sourceRef} />
      <span data-testid="plugin-source-revision"
        >{record.sourceRevisionOrSnapshot}</span
      >
    </dd>
    <dt>Content digest</dt>
    <dd data-testid="plugin-digest">{record.contentDigest}</dd>
    <dt>Install state</dt>
    <dd data-testid="plugin-install">{install.label}</dd>
    <dt>Compatibility</dt>
    <dd data-testid="plugin-compat">
      {compat.text}{#if compat.reason}:
        <span data-testid="plugin-compat-reason">{compat.reason}</span>{/if}
    </dd>
  </dl>
  {#if trusted}
    <p role="note" data-testid="plugin-not-sandboxed">
      Runs with full app permissions (not sandboxed). Install only code you
      trust.
    </p>
  {/if}
</section>

<style>
  .plugin dd {
    overflow-wrap: anywhere;
    margin-inline-start: 0;
  }
</style>
