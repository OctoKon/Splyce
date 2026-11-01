<script lang="ts">
  /**
   * Test-only seam for the TD-30 approval surface.
   *
   * Holds the delivered request list in reactive state so a test can push a new
   * engine snapshot into the SAME mounted surface (no remount at the test
   * level), which is what proves the surface reacts to replacement requests.
   */
  import { untrack } from "svelte";
  import ApprovalSurface from "../../src/components/ApprovalSurface.svelte";
  import type {
    ApprovalContext,
    ApprovalRequestView,
    ApprovalResponsePayload,
  } from "../../src/stores/approvals";

  interface Props {
    initialRequests: readonly ApprovalRequestView[];
    initialContext: ApprovalContext;
    onRespond?: (payload: ApprovalResponsePayload) => void;
    onDismiss?: (approvalRequestId: string) => void;
  }

  let { initialRequests, initialContext, ...callbacks }: Props = $props();

  let requests = $state<readonly ApprovalRequestView[]>(
    untrack(() => initialRequests),
  );
  let context = $state<ApprovalContext>(untrack(() => initialContext));

  export function push(
    nextRequests: readonly ApprovalRequestView[],
    nextContext?: ApprovalContext,
  ) {
    requests = nextRequests;
    if (nextContext) context = nextContext;
  }
</script>

<ApprovalSurface {requests} {context} {...callbacks} />
