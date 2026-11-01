<script lang="ts">
  import { onMount, untrack } from "svelte";
  import type { SplyceEvent } from "@splyce/pi/contracts";
  import Composer from "./components/Composer.svelte";
  import SessionTree from "./components/SessionTree.svelte";
  import SessionActions from "./components/SessionActions.svelte";
  import TurnStream from "./components/TurnStream.svelte";
  import Shell from "./components/shell/Shell.svelte";
  import UsageView from "./components/usage/UsageView.svelte";
  import ApprovalSurface from "./components/ApprovalSurface.svelte";
  import PermissionModeSelect from "./components/PermissionModeSelect.svelte";
  import SupportStatus from "./components/SupportStatus.svelte";
  import Providers from "./routes/Providers.svelte";
  import Setup from "./routes/Setup.svelte";
  import Modules from "./routes/Modules.svelte";
  import { unavailableModuleSnapshot } from "./stores/modules";
  import type {
    ApprovalContext,
    ApprovalRequestView,
  } from "./stores/approvals";
  import {
    initialPermissionMode,
    type PermissionModeContext,
  } from "./stores/permission-mode";
  import {
    connectionState,
    handshake,
    onEvent,
    subscribe,
    type EngineConnectionState,
  } from "./stores/engine";
  import {
    bindSelection,
    clearSession,
    selectedSession,
    selectSession,
    type BindingStatus,
  } from "./stores/session-selection";
  import {
    createSessionNav,
    reduceSessionNav,
    visibleNodes,
    type SessionNavAction,
    type SessionNavState,
    type TreeEventLike,
  } from "./stores/sessions";
  import type { SessionActionsContext } from "./stores/session-actions";
  import {
    createTurnStreamTransport,
    createTurnsState,
    type TurnsState,
  } from "./stores/turns";

  type View = "conversation" | "setup" | "modules" | "providers" | "usage";
  const VIEWS: readonly (readonly [View, string])[] = [
    ["conversation", "Conversation"],
    ["setup", "Setup"],
    ["modules", "Modules"],
    ["providers", "Providers"],
    ["usage", "Usage"],
  ];

  // No setup/module service is connected: the screens stay honest and disabled
  // instead of implying a catalog, plan or installation.
  const moduleSnapshot = unavailableModuleSnapshot(
    "No setup or module service is connected.",
  );

  // TD-30: the turns store carries tool-call approvals for the inline
  // ApprovalCard, but no request carries the config/profile/policy revisions it
  // was issued against, and the dialog must not ask about a target it cannot
  // verify. The surface therefore shows only requests with a known revision:
  // there are none today, so the shell never claims an approval is pending.
  const approvalRequests: readonly ApprovalRequestView[] = [];
  const approvalContext: ApprovalContext = {
    engine: "unavailable",
    engineReason: "Session revisions are not delivered to the renderer yet.",
    sessionId: null,
    scopeId: null,
    runId: null,
    actionId: null,
    targetScope: null,
    normalizedTarget: null,
    revision: null,
    runCanceled: false,
    nowMs: 0,
  };

  // TD-30 Supervisor: a mode change is engine-admitted, and without the session
  // revisions it cannot be admitted at all. The selector is visibly disabled
  // with that reason instead of pretending a selection could take effect.
  const permissionContext: PermissionModeContext = {
    engine: "unavailable",
    engineReason: "Session revisions are not delivered to the renderer yet",
    configRevision: null,
    policyRevision: null,
  };

  // Snapshot seam: the only thing allowed to complete a session load. Readiness proves nothing about sessions.
  let {
    loadSessions,
  }: { loadSessions?: () => Promise<readonly SplyceEvent[]> } = $props();

  let view = $state<View>("conversation");
  let nav = $state.raw<SessionNavState>(createSessionNav());
  // sessionId -> scopeId, as carried by the engine's own events; never invented.
  const scopes = new Map<string, string>();
  const dispatchNav = (action: SessionNavAction) => {
    nav = untrack(() => reduceSessionNav(nav, action));
  };

  let status = $state<EngineConnectionState>("disconnected");
  let turns = $state.raw<TurnsState>(createTurnsState());
  let subscription = $state<BindingStatus>({ state: "idle" });
  let retry = $state<() => void>(() => {});
  let currentRun = $derived(
    turns.currentRunId ? turns.runs[turns.currentRunId] : undefined,
  );
  // A different session starts on the safe mode: no mode or pending request
  // carries over from the previous one.
  const permissionModeState = $derived(
    initialPermissionMode($selectedSession?.sessionId ?? null),
  );

  // TD-33: the actions target the branch the tree actually selected. The engine
  // still does not deliver the revisions a lifecycle request needs, and a
  // rewind/code restore is not admitted yet, so every action is visibly disabled
  // with its own reason instead of pretending to run.
  const sessionActionContext: SessionActionsContext = $derived.by(() => {
    const key = nav.selectedKey;
    const node =
      key === null ? undefined : visibleNodes(nav).find((n) => n.key === key);
    return {
      engine: {
        status: "unavailable",
        reason: "Session revisions are not delivered to the renderer yet.",
      },
      rewind: {
        status: "unavailable",
        reason:
          "A rewind request is not admitted yet: TD-25 restore receipts are not wired.",
      },
      codeRestore: {
        status: "unavailable",
        reason:
          "Code restore is not available yet: TD-25 restore receipts are not wired.",
      },
      selected: node
        ? {
            sessionId: node.sessionId,
            branchAnchorId: node.branchAnchorId,
            leaves: node.leaves,
          }
        : null,
      draft: "",
    };
  });

  function applyTree(event: SplyceEvent) {
    if (event.kind !== "session.tree_updated") return;
    scopes.set(event.sessionId, event.scopeId);
    dispatchNav({ type: "event", event: event as TreeEventLike });
  }

  async function runLoad() {
    dispatchNav({ type: "refresh" });
    try {
      for (const event of await loadSessions!()) applyTree(event);
      dispatchNav({ type: "loaded" });
    } catch (e) {
      dispatchNav({
        type: "failed",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // Readiness never completes a load: without a snapshot the previous navigation state is kept, selection included.
  $effect(() => {
    if (status === "ready") {
      if (loadSessions) void runLoad();
      else if (untrack(() => Object.keys(nav.branches).length > 0))
        dispatchNav({ type: "loaded" });
    } else if (status === "unavailable" || status === "error")
      dispatchNav({ type: "failed", message: "Engine unavailable." });
  });

  function onSelect(key: string) {
    dispatchNav({ type: "select", key });
    const node = visibleNodes(nav).find((n) => n.key === key);
    const scopeId = node && scopes.get(node.sessionId);
    if (node && scopeId) selectSession({ sessionId: node.sessionId, scopeId });
  }

  // The selected branch vanished from the latest snapshot: drop the selection with it.
  $effect(() => {
    if (nav.lostSelection) clearSession();
  });

  function onApproval() {
    // Session context arrives with the workbench (TD-08/TD-30); never invent revisions here.
  }

  onMount(() => {
    // This component is the workbench: the only writer of the session-selection store.
    const transport = createTurnStreamTransport({
      onState: (next) => {
        turns = next;
      },
      onResync: (fromSeq, sessionId) => {
        void binding.resubscribe(sessionId, fromSeq);
      },
    });
    const binding = bindSelection(transport, subscribe);
    const unsubState = connectionState.subscribe((val) => {
      status = val;
    });
    const unsubBinding = binding.status.subscribe((next) => {
      subscription = next;
    });
    retry = () => void binding.retry();
    const unsubEvents = onEvent((event) => {
      applyTree(event);
      transport.enqueue(event);
    });

    handshake().catch(() => {
      // Handshake rejection leaves status in 'unavailable' or 'error'
    });

    return () => {
      unsubState();
      unsubEvents();
      unsubBinding();
      binding.dispose();
      transport.dispose();
      clearSession();
    };
  });
</script>

<Shell {rail} {transcript} {composer} {evidence} />

{#snippet rail()}
  <div class="brand">
    <h1>Splyce</h1>
    <span class="status-badge" class:ready={status === "ready"} class:unavailable={status !== "ready"}>
      {status}
    </span>
  </div>
  <nav aria-label="Views">
    {#each VIEWS as [id, label] (id)}
      <button type="button" aria-current={view === id ? "page" : undefined} onclick={() => (view = id)}>
        {label}
      </button>
    {/each}
  </nav>
  <SessionTree
    {nav}
    {onSelect}
    onFocus={(key) => dispatchNav({ type: "focus", key })}
    onMove={(to) => dispatchNav({ type: "move", to })}
    onRetry={() => {
      if (status === "ready" && loadSessions) void runLoad();
      else handshake().catch(() => {});
    }}
  />
  <SessionActions context={sessionActionContext} />
  <section class="supervisor" aria-label="Supervisor" data-testid="supervisor">
    <h2>Supervisor</h2>
    <PermissionModeSelect modeState={permissionModeState} context={permissionContext} />
  </section>
{/snippet}

{#snippet transcript()}
  <!-- TD-30: engine-facing approval mount. Empty until requests carry revisions. -->
  <ApprovalSurface requests={approvalRequests} context={approvalContext} />
  {#if subscription.state === "failed"}
    <div class="subscribe-error" role="alert" data-testid="subscribe-error">
      <span>Could not subscribe to the session: {subscription.error}</span>
      <button type="button" onclick={retry}>Retry</button>
    </div>
  {/if}
  {#if view === "providers"}
    <!-- No profile service is connected: the list is empty and the add form is disabled, not faked. -->
    <fieldset disabled data-testid="providers-view">
      <Providers connections={[]} families={[]} onAddCustom={() => {}} />
      <p role="status">Provider connections are unavailable: no profile service is connected.</p>
    </fieldset>
    <SupportStatus cells={null} />
  {:else if view === "setup"}
    <Setup
      snapshot={moduleSnapshot}
      onEnterWorkbench={() => (view = "conversation")}
      onOpenModules={() => (view = "modules")}
      onConfigureProvider={() => (view = "providers")}
    />
  {:else if view === "modules"}
    <Modules
      snapshot={moduleSnapshot}
      onConfigureProvider={() => (view = "providers")}
    />
  {:else if view === "usage"}
    <UsageView usage={null} status="unavailable" />
  {:else}
    <div class="app-content" class:conversation={currentRun !== undefined}>
      {#if currentRun}
        <section class="turn-pane" aria-label="Transcript">
          <TurnStream
            run={currentRun}
            stale={turns.stale || turns.needsResync || status !== "ready"}
            showApprovalControls={false}
            canRespond={() => false}
            {onApproval}
          />
        </section>
      {:else if status === "ready"}
        <div class="workspace-view">
          <p>Ready for workspace execution.</p>
        </div>
      {:else}
        <div class="unavailable-view" data-testid="unavailable-banner">
          <h2>Engine unavailable</h2>
          <p>Required engine services are unavailable. Task execution is disabled.</p>
        </div>
      {/if}
    </div>
  {/if}
{/snippet}

{#snippet composer()}
  <!-- stale: config/profile/policy revisions are not delivered to the renderer yet, so
       sending is disabled. generationReady is deliberately omitted: the engine does not
       report readiness.ports.generation yet, and an omitted flag means "not reported",
       not "unconfigured". Wire it the moment the parser lands in stores/engine.ts. -->
  <Composer
    connection={status}
    sessionId={$selectedSession?.sessionId ?? null}
    unavailable="Sending is not available yet"
    send={async () => {
      throw new Error("Sending is unavailable: session revisions are not wired.");
    }}
  />
{/snippet}

{#snippet evidence()}
  <p>No changes or evidence available.</p>
{/snippet}

<style>
  :global(html),
  :global(body) {
    margin: 0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    color: #111827;
    background: #f9fafb;
  }
  .brand {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px;
  }
  .brand h1 {
    font-size: 1.125rem;
    margin: 0;
    font-weight: 700;
  }
  .status-badge {
    padding: 2px 8px;
    border-radius: 9999px;
    font-size: 0.75rem;
    font-weight: 600;
    text-transform: uppercase;
    background: #f3f4f6;
    color: #4b5563;
  }
  .status-badge.ready {
    background: #d1fae5;
    color: #065f46;
  }
  .status-badge.unavailable {
    background: #fee2e2;
    color: #991b1b;
  }
  [aria-current="page"] {
    font-weight: 700;
  }
  .supervisor {
    display: grid;
    gap: 8px;
    padding: 12px;
    border-top: 1px solid #e5e7eb;
    margin-top: 8px;
  }
  .supervisor h2 {
    margin: 0;
    font-size: 0.75rem;
    font-weight: 700;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: #4b5563;
  }
  fieldset {
    border: 0;
    margin: 0;
    padding: 12px;
  }
  .subscribe-error {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 8px 20px;
    background: #fee2e2;
    color: #991b1b;
    font-size: 0.875rem;
  }
  .app-content {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    min-height: 100%;
    box-sizing: border-box;
  }
  .app-content.conversation {
    align-items: stretch;
    justify-content: flex-start;
  }
  .turn-pane {
    width: 100%;
    max-width: 880px;
    margin: 0 auto;
  }
  .unavailable-view {
    max-width: 480px;
    text-align: center;
    padding: 32px;
    background: #ffffff;
    border: 1px solid #e5e7eb;
    border-radius: 8px;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);
  }
  .unavailable-view h2 {
    margin-top: 0;
    color: #b91c1c;
  }
  .unavailable-view p {
    color: #4b5563;
    font-size: 0.875rem;
    line-height: 1.5;
  }
</style>
