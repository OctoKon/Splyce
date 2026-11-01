<script lang="ts">
  /**
   * Test-only seam for the TD-29 route tests.
   *
   * It keeps the snapshot reactive so a test can push the engine's next
   * authoritative snapshot into the SAME mounted Setup component. That proves
   * the reviewing -> operating -> outcome/recovering progression is driven by
   * operation updates, not by a remount or by the confirm click.
   */
  import { untrack } from "svelte";
  import Setup from "../../src/routes/Setup.svelte";
  import type { ModuleSnapshot } from "../../src/stores/modules";

  interface Props {
    initial: ModuleSnapshot;
    onConfirmInstall?: (request: {
      requestId: string;
      planId: string;
      enableRequested: boolean;
      executionGranted: boolean;
    }) => void;
    onCancelOperation?: (operationId: string) => void;
    onRetryOperation?: (
      operationId: string,
      request: { requestId: string },
    ) => void;
    onEnterWorkbench?: () => void;
  }

  let { initial, ...callbacks }: Props = $props();
  let snapshot = $state<ModuleSnapshot>(untrack(() => initial));

  export function pushSnapshot(next: ModuleSnapshot) {
    snapshot = next;
  }
</script>

<Setup {snapshot} initialStep="selecting" {...callbacks} />
