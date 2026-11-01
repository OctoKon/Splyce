<script lang="ts">
  /**
   * TD-30 e2e host for the permission-mode selector (U1_permission_mode).
   *
   * It plays the parent the app will provide: it only submits the requested
   * mode, then reports the engine's pending/acknowledged/rejected state back
   * into the same mounted selector. No mode becomes effective here.
   */
  import { onMount } from "svelte";
  import PermissionModeSelect from "../../src/components/PermissionModeSelect.svelte";
  import {
    acknowledgeMode,
    confirmedPermissionModeRequest,
    initialPermissionMode,
    rejectMode,
    type PermissionMode,
    type PermissionModeContext,
    type PermissionModeState,
  } from "../../src/stores/permission-mode";

  type Call = { readonly name: string; readonly args: readonly unknown[] };

  const readyContext: PermissionModeContext = {
    engine: "ready",
    engineReason: null,
    configRevision: "cfg-1",
    policyRevision: "pol-1",
  };

  let modeState = $state<PermissionModeState>(initialPermissionMode("ses-1"));
  let context = $state<PermissionModeContext>({ ...readyContext });

  const calls: Call[] = [];

  function change(mode: PermissionMode) {
    calls.push({ name: "onChange", args: [mode] });
    // The component only calls this for a mode it may request: either it needs
    // no confirmation, or the user just gave the separate bypass confirmation.
    const request = confirmedPermissionModeRequest(modeState, mode, context);
    if (request.kind === "requested") modeState = request.state;
  }

  function dismissConfirm() {
    calls.push({ name: "onDismissConfirm", args: [] });
  }

  function setEngine(engine: "ready" | "unavailable", reason: string | null) {
    context = {
      ...context,
      engine,
      engineReason: reason,
      configRevision: engine === "ready" ? "cfg-1" : context.configRevision,
      policyRevision: engine === "ready" ? "pol-1" : context.policyRevision,
    };
  }

  function setRevisions(configRevision: string | null, policyRevision: string | null) {
    context = { ...context, configRevision, policyRevision };
  }

  /** The engine accepted the pending request. */
  function acknowledge() {
    if (modeState.requested) modeState = acknowledgeMode(modeState, modeState.requested);
  }

  /** The engine refused the pending request. */
  function reject(reason: string) {
    modeState = rejectMode(modeState, reason);
  }

  /** A different session starts: nothing may carry over. */
  function newSession(sessionId: string) {
    modeState = initialPermissionMode(sessionId);
  }

  onMount(() => {
    (
      window as unknown as {
        __td30p: {
          calls: () => readonly Call[];
          setEngine: typeof setEngine;
          setRevisions: typeof setRevisions;
          acknowledge: typeof acknowledge;
          reject: typeof reject;
          newSession: typeof newSession;
        };
      }
    ).__td30p = {
      calls: () => calls.map((call) => ({ ...call })),
      setEngine,
      setRevisions,
      acknowledge,
      reject,
      newSession,
    };
  });
</script>

<button id="behind" data-testid="behind" type="button">Behind the modal</button>

<PermissionModeSelect
  {modeState}
  {context}
  onChange={change}
  onDismissConfirm={dismissConfirm}
/>
