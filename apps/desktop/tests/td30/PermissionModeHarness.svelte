<script lang="ts">
  /**
   * Test-only seam for the TD-30 permission-mode selector.
   *
   * It holds the state and context in reactive locals so a test can change the
   * session or revisions on the SAME mounted selector, which is the only way to
   * prove that an open confirmation reacts to a context change (a remount would
   * throw the open dialog away and prove nothing).
   */
  import { untrack } from "svelte";
  import PermissionModeSelect from "../../src/components/PermissionModeSelect.svelte";
  import type {
    PermissionMode,
    PermissionModeContext,
    PermissionModeState,
  } from "../../src/stores/permission-mode";

  interface Props {
    initialModeState: PermissionModeState;
    initialContext: PermissionModeContext;
    onChange?: (mode: PermissionMode) => void;
    onDismissConfirm?: () => void;
  }

  let { initialModeState, initialContext, ...callbacks }: Props = $props();

  let modeState = $state<PermissionModeState>(untrack(() => initialModeState));
  let context = $state<PermissionModeContext>(untrack(() => initialContext));

  export function push(
    nextState: PermissionModeState,
    nextContext?: PermissionModeContext,
  ) {
    modeState = nextState;
    if (nextContext) context = nextContext;
  }
</script>

<PermissionModeSelect {modeState} {context} {...callbacks} />
