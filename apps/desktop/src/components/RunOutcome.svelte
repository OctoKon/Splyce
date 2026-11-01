<script lang="ts">
  import type { SplyceErrorPayload } from "@splyce/pi/contracts";
  import { projectStatus, type StatusProjectionRecords } from "../status-view";
  import UsageView from "./usage/UsageView.svelte";
  import type { UsageInput } from "./usage/usage";

  let {
    outcome,
    error = null,
    usage = null,
    onRetry,
  }: {
    outcome: StatusProjectionRecords["outcome"];
    error?: SplyceErrorPayload | null;
    usage?: UsageInput | null;
    onRetry?: () => void;
  } = $props();

  // Fixed copy only: error.message may carry paths, secrets or stack text and
  // is deliberately never rendered.
  const CODE_COPY: Readonly<Record<string, string>> = Object.freeze({
    POLICY_DENIED: "Policy blocked this action. Nothing was run.",
    UNSUPPORTED_PROVIDER:
      "The selected provider does not support this request.",
    ENGINE_CRASH: "The engine stopped unexpectedly.",
    UNCERTAIN_EFFECT:
      "The effect could not be confirmed. Check the target before doing anything else.",
    STALE_REVISION:
      "The content changed since this was requested. Refresh and try again.",
    TIMEOUT: "The operation timed out.",
  });
  const GENERIC = "Something went wrong. Technical details are hidden.";
  const GLYPH: Readonly<Record<string, string>> = Object.freeze({
    completed: "✓",
    failed: "✕",
    denied: "⊘",
    canceled: "–",
    "timed-out": "⏱",
    uncertain: "?",
    "cleanup-pending": "…",
  });

  const base = $derived(projectStatus("outcome", outcome));
  // A reported error beside a "success" outcome is contradictory: show uncertain.
  const status = $derived(
    error && base.status === "completed"
      ? projectStatus("outcome", {
          effectState: "uncertain",
          cleanupState: outcome.cleanupState,
          errorClass: "none",
        })
      : base,
  );
  const uncertain = $derived(status.status === "uncertain");
  const copy = $derived(
    error
      ? Object.hasOwn(CODE_COPY, error.code)
        ? CODE_COPY[error.code]!
        : GENERIC
      : uncertain
        ? CODE_COPY.UNCERTAIN_EFFECT!
        : status.status === "cleanup-pending"
          ? "The action succeeded; cleanup is still pending."
          : status.status === "failed"
            ? GENERIC
            : null,
  );
  const canRetry = $derived(
    !!onRetry &&
      !uncertain &&
      error?.retryable === true &&
      error.suggestedAction === "RETRY_SAFE",
  );
</script>

<section
  class="run-outcome tone-{status.tone}"
  aria-label="Run outcome"
  data-testid="run-outcome"
  data-status={status.status}
>
  <p class="status" role={status.tone === "negative" ? "alert" : "status"}>
    <span aria-hidden="true">{GLYPH[status.status] ?? "?"}</span>
    <span data-testid="run-outcome-label">{status.label}</span>
  </p>
  {#if copy}<p class="copy" data-testid="run-outcome-copy">{copy}</p>{/if}
  {#if error}
    <details data-testid="run-outcome-details">
      <summary>Details</summary>
      <p>Reference: <code>{error.correlationId}</code></p>
    </details>
  {/if}
  {#if canRetry}
    <button type="button" onclick={onRetry} data-testid="run-outcome-retry"
      >Retry</button
    >
  {/if}
  <UsageView {usage} />
</section>

<style>
  .run-outcome {
    border: 1px solid currentColor;
    padding: 8px 12px;
  }
  .status {
    font-weight: 600;
    margin: 0 0 4px;
  }
  summary:focus-visible,
  button:focus-visible {
    outline: 2px solid currentColor;
    outline-offset: 2px;
  }
</style>
