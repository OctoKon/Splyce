<script lang="ts" module>
  export const SCENARIOS = [
    "states",
    "sources",
    "narrow",
    "transcript",
  ] as const;
  export type Scenario = (typeof SCENARIOS)[number];

  export const STATE_KINDS = [
    "loading",
    "empty",
    "error",
    "stale",
    "unavailable",
  ] as const;
  export type StateKind = (typeof STATE_KINDS)[number];

  export const SOURCE_KINDS = [
    "user",
    "engine",
    "tool",
    "plugin",
    "provider",
    "memory",
    "external",
  ] as const;
</script>

<script lang="ts">
  import StateMessage from "../../src/components/specimens/StateMessage.svelte";
  import SourceLabel from "../../src/components/source/SourceLabel.svelte";
  import type { SourceKind } from "../../src/components/source/source-kinds";

  interface Props {
    scenario?: Scenario;
  }

  let { scenario = "states" }: Props = $props();

  const LONG_SOURCE_ID =
    "source:urn:splyce:fixture:transcript:2026-10-27:provider:external:very-long-unbroken-identifier";
  const LONG_DETAIL =
    "diagnostic::renderer-sidecar-handshake-timeout-without-any-break-opportunity";

  const STATE_COPY: Readonly<
    Record<StateKind, { title: string; detail: string }>
  > = {
    loading: {
      title: "Checking the workspace",
      detail: LONG_DETAIL,
    },
    empty: {
      title: "Nothing here yet",
      detail: "Create a session to see transcript entries.",
    },
    error: {
      title: "The engine stopped",
      detail: LONG_DETAIL,
    },
    stale: {
      title: "This snapshot is out of date",
      detail: "Refresh before acting on it.",
    },
    unavailable: {
      title: "This feature is unavailable",
      detail: "The required module is not installed.",
    },
  };
</script>

<main data-testid="a11y-fixture" data-scenario={scenario}>
  {#if scenario === "states"}
    <h1>State messages</h1>
    {#each STATE_KINDS as kind}
      <section data-testid={`state-${kind}`}>
        {#if kind === "error"}
          <StateMessage
            {kind}
            title={STATE_COPY[kind].title}
            detail={STATE_COPY[kind].detail}
          >
            {#snippet action()}
              <button type="button" data-testid="state-action-error">
                Retry loading
              </button>
            {/snippet}
          </StateMessage>
        {:else}
          <StateMessage
            {kind}
            title={STATE_COPY[kind].title}
            detail={STATE_COPY[kind].detail}
          />
        {/if}
      </section>
    {/each}
  {/if}

  {#if scenario === "sources"}
    <h1>Source labels</h1>
    {#each SOURCE_KINDS as kind}
      <section data-testid={`source-${kind}`}>
        <SourceLabel
          {kind}
          sourceId={kind === "user" ? LONG_SOURCE_ID : `source-${kind}`}
          untrusted={kind === "tool"}
        />
      </section>
    {/each}
    <section data-testid="source-unknown">
      <SourceLabel
        kind={"unknown" as SourceKind}
        sourceId="source-unknown-kind"
      />
    </section>
  {/if}

  {#if scenario === "narrow"}
    <h1>Narrow and high-DPI fixture</h1>
    <section data-testid="narrow-state">
      <StateMessage kind="error" title="The engine stopped" detail={LONG_DETAIL}>
        {#snippet action()}
          <button type="button" data-testid="state-action-error">
            Retry loading
          </button>
        {/snippet}
      </StateMessage>
    </section>
    <section data-testid="narrow-source">
      <SourceLabel kind="external" sourceId={LONG_SOURCE_ID} />
    </section>
  {/if}

  {#if scenario === "transcript"}
    <h1>Transcript source semantics</h1>
    <ol aria-label="Transcript entries" data-testid="transcript">
      <li data-testid="transcript-user">
        <SourceLabel kind="user" sourceId="turn-1-user" />
        <p>User message</p>
      </li>
      <li data-testid="transcript-engine">
        <SourceLabel kind="engine" sourceId="turn-1-engine" />
        <p>Engine response</p>
      </li>
      <li data-testid="transcript-external">
        <SourceLabel kind="external" sourceId={LONG_SOURCE_ID} />
        <p>Fetched page text</p>
      </li>
    </ol>
  {/if}
</main>

<style>
  main {
    max-width: 760px;
    margin: 0 auto;
    padding: 24px;
  }
  h1 {
    font-size: 1.25rem;
  }
  section {
    margin-block: 16px;
  }
</style>
