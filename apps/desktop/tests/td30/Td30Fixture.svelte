<script lang="ts">
  /**
   * TD-30 e2e host for the approval surface.
   *
   * It mounts the same ApprovalSurface the app will mount and exposes only what
   * the browser test needs: push the context the engine reported, or push the
   * next request while a prompt is open. No decisions are made here - the calls
   * array records exactly what the surface handed back.
   */
  import { onMount } from "svelte";
  import ApprovalSurfaceHarness from "./ApprovalSurfaceHarness.svelte";
  import type {
    ApprovalContext,
    ApprovalRequestView,
    ApprovalResponsePayload,
  } from "../../src/stores/approvals";
  import {
    approvalEngineUnavailable,
    approvalExpired,
    approvalMatching,
    approvalRequest,
    approvalRunCanceled,
    approvalStaleRevision,
    approvalWrongTarget,
  } from "./fixtures";

  type Call = { readonly name: string; readonly args: readonly unknown[] };

  const CONTEXTS: Record<string, ApprovalContext> = {
    matching: approvalMatching,
    "wrong-target": approvalWrongTarget,
    "stale-revision": approvalStaleRevision,
    "run-canceled": approvalRunCanceled,
    "engine-unavailable": approvalEngineUnavailable,
    expired: approvalExpired,
  };

  /** The next target the engine could ask about while the first prompt is open. */
  const replacement: ApprovalRequestView = {
    ...approvalRequest,
    request: {
      ...approvalRequest.request,
      approvalRequestId: "apr-2",
      runId: "run-2",
      actionId: "act-2",
      normalizedTarget: "src/other.ts",
      riskRationale: "Removes the selected workspace file.",
    },
    receivedSeq: 2,
    receivedAtMs: 2_000,
  };

  const replacementContext: ApprovalContext = {
    ...approvalMatching,
    runId: "run-2",
    actionId: "act-2",
    normalizedTarget: "src/other.ts",
    nowMs: 3_000,
  };

  let harness = $state<ApprovalSurfaceHarness>();
  const calls: Call[] = [];

  function respond(payload: ApprovalResponsePayload) {
    calls.push({ name: "onRespond", args: [payload] });
  }

  function dismiss(approvalRequestId: string) {
    calls.push({ name: "onDismiss", args: [approvalRequestId] });
  }

  /** Report a new reconciliation context for the already-delivered request. */
  function setContext(name: keyof typeof CONTEXTS) {
    const context = CONTEXTS[name];
    if (!context) throw new Error(`unknown context ${name}`);
    harness?.push([approvalRequest], context);
  }

  /** A newer request with its own matching context arrives while the dialog is open. */
  function replace() {
    harness?.push([approvalRequest, replacement], replacementContext);
  }

  onMount(() => {
    (
      window as unknown as {
        __td30: {
          setContext: typeof setContext;
          replace: typeof replace;
          calls: () => readonly Call[];
          clear: () => void;
        };
      }
    ).__td30 = {
      setContext,
      replace,
      calls: () => calls.map((call) => ({ ...call })),
      clear: () => {
        calls.length = 0;
      },
    };
  });
</script>

<ApprovalSurfaceHarness
  bind:this={harness}
  initialRequests={[approvalRequest]}
  initialContext={approvalMatching}
  onRespond={respond}
  onDismiss={dismiss}
/>
