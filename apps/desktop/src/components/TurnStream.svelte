<script lang="ts">
  import ToolCard from "./ToolCard.svelte";
  import { projectTurnStatus } from "../status-view";
  import type { TurnView } from "../stores/turns";

  type ApprovalDecision = "approve" | "deny";

  let {
    run,
    stale = false,
    showApprovalControls = true,
    // Fail closed unless the caller supplies a live, revision-bound responder.
    canRespond = () => false,
    onApproval,
  }: {
    run: TurnView;
    stale?: boolean;
    showApprovalControls?: boolean;
    canRespond?: (actionId: string) => boolean;
    onApproval: (
      approvalRequestId: string,
      runId: string,
      actionId: string,
      decision: ApprovalDecision,
    ) => void | Promise<void>;
  } = $props();

  let actions = $derived(
    new Map(run.actions.map((action) => [action.actionId, action])),
  );
  let runStatus = $derived(projectTurnStatus(run.status));
</script>

{#if run.userPrompt !== undefined}
  <article class="user-turn" aria-label="User message" data-testid="turn-user">
    <span class="user-label">USER</span>
    <p>{run.userPrompt}</p>
  </article>
{/if}

<article
  class="turn"
  class:stale
  data-testid="turn-stream"
  data-run-id={run.runId}
  data-status={run.status}
  data-stale={stale}
  aria-label="Assistant turn"
>
  <header class="turn-head">
    <span class="status" data-status={run.status} data-tone={runStatus.tone}>
      {runStatus.label}
    </span>
    {#if stale}
      <span class="stale-badge">Stale</span>
    {/if}
  </header>

  {#if stale}
    <p class="banner" role="status">This transcript may be incomplete.</p>
  {/if}

  <div class="transcript" aria-busy={run.status === "streaming"}>
    {#each run.blocks as block (block.id)}
      {#if block.type === "thought"}
        <details class="thought" data-kind="thought">
          <summary>Thought</summary>
          <p data-testid="turn-thought">{block.text}</p>
        </details>
      {:else if block.type === "text"}
        <p class="text" data-testid="turn-text" data-kind="text">
          {block.text}
        </p>
      {:else}
        {@const action = actions.get(block.actionId)}
        {#if action}
          <ToolCard
            {action}
            {stale}
            {showApprovalControls}
            {canRespond}
            {onApproval}
          />
        {/if}
      {/if}
    {/each}
  </div>

  {#if run.status === "canceled"}
    <p class="terminal" role="alert">Run was canceled.</p>
  {:else if run.status === "failed"}
    <p class="terminal" role="alert">
      Run failed{run.error ? `: ${run.error.message}` : ""}.
    </p>
  {:else if run.status === "stopped"}
    <p class="terminal" role="status">Run stopped.</p>
  {/if}
</article>

<style>
  .user-turn {
    align-self: flex-end;
    margin: 1rem 0 1rem auto;
    max-width: 85%;
    width: fit-content;
    padding: 0.75rem 1rem;
    border-radius: 1rem 1rem 0.25rem 1rem;
    border: 1px solid var(--splyce-border-default, #e5e7eb);
    background: var(--splyce-surface-raised, #ffffff);
    color: var(--splyce-text-primary, #111827);
  }

  .user-label {
    font-size: 0.7rem;
    font-weight: 600;
    color: var(--splyce-text-secondary, #4b5563);
  }

  .user-turn p {
    margin: 0.25rem 0 0;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .turn {
    display: flex;
    flex-direction: column;
    gap: var(--splyce-space-3, 0.75rem);
    color: var(--splyce-text-primary, #111827);
    font-family: var(
      --splyce-font-family-ui,
      -apple-system,
      BlinkMacSystemFont,
      "Segoe UI",
      system-ui,
      sans-serif
    );
    font-size: var(--splyce-font-size-base, 1rem);
    line-height: var(--splyce-line-height-normal, 1.5);
  }

  .turn-head {
    display: flex;
    align-items: center;
    gap: var(--splyce-space-2, 0.5rem);
  }

  .status,
  .stale-badge {
    font-size: var(--splyce-font-size-xs, 0.75rem);
    padding: var(--splyce-space-1, 0.25rem) var(--splyce-space-2, 0.5rem);
    border-radius: 999px;
    border: 1px solid var(--splyce-border-default, #e5e7eb);
    color: var(--splyce-text-secondary, #4b5563);
  }

  .status[data-status="streaming"] {
    color: var(--splyce-status-pending, #7c3aed);
    border-color: var(--splyce-status-pending, #7c3aed);
  }

  .status[data-status="waiting_approval"] {
    color: var(--splyce-status-warning, #b45309);
    border-color: var(--splyce-status-warning, #b45309);
  }

  .status[data-status="completed"] {
    color: var(--splyce-status-success, #047857);
    border-color: var(--splyce-status-success, #047857);
  }

  .status[data-status="failed"] {
    color: var(--splyce-status-danger, #b91c1c);
    border-color: var(--splyce-status-danger, #b91c1c);
  }

  .stale-badge {
    color: var(--splyce-status-warning, #b45309);
    border-color: var(--splyce-status-warning, #b45309);
  }

  .banner,
  .terminal {
    margin: 0;
    padding: var(--splyce-space-2, 0.5rem) var(--splyce-space-3, 0.75rem);
    border: 1px solid var(--splyce-border-default, #e5e7eb);
    border-radius: var(--splyce-space-2, 0.5rem);
    background: var(--splyce-surface-raised, #ffffff);
    color: var(--splyce-text-secondary, #4b5563);
    font-size: var(--splyce-font-size-sm, 0.875rem);
  }

  .transcript {
    display: flex;
    flex-direction: column;
    gap: var(--splyce-space-3, 0.75rem);
  }

  .text {
    margin: 0;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .thought {
    border-left: 2px solid var(--splyce-border-subtle, #f3f4f6);
    padding-left: var(--splyce-space-3, 0.75rem);
    color: var(--splyce-text-secondary, #4b5563);
    font-size: var(--splyce-font-size-sm, 0.875rem);
  }

  .thought summary {
    cursor: pointer;
    color: var(--splyce-text-muted, #6b7280);
  }

  .thought p {
    margin: var(--splyce-space-2, 0.5rem) 0 0;
    white-space: pre-wrap;
  }

  @media (prefers-reduced-motion: reduce) {
    * {
      transition: none;
    }
  }
</style>
