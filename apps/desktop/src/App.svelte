<script lang="ts">
  import { onMount, tick, untrack } from "svelte";
  import { validatePermissionResult } from "@splyce/pi/contracts";
  import type {
    Handshake,
    PortAvailability,
    SplyceEvent,
  } from "@splyce/pi/contracts";
  import Composer from "./components/Composer.svelte";
  import SessionTree from "./components/SessionTree.svelte";
  import SessionActions from "./components/SessionActions.svelte";
  import TurnStream from "./components/TurnStream.svelte";
  import Workbench from "./components/shell/Workbench.svelte";
  import Icon from "./components/shell/Icon.svelte";
  import MemoryList from "./components/memory/MemoryList.svelte";
  import ModelCatalog from "./components/model/ModelCatalog.svelte";
  import type { ModelSummary, ModelsListResult } from "@splyce/pi/model-data";
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
    confirmedPermissionModeRequest,
    acknowledgeMode,
    rejectMode,
    PERMISSION_MODE_LABELS,
    type PermissionMode,
    type PermissionModeContext,
  } from "./stores/permission-mode";
  import {
    connectionState,
    cancelSession,
    handshake,
    invoke,
    onEvent,
    portAvailability,
    selectWorkspace,
    sendSetup,
    readModels,
    subscribe,
    type EngineConnectionState,
    type SelectedWorkspace,
  } from "./stores/engine";
  import {
    configuredProfileResult,
    profileSelectPayload,
    providerConfigurePayload,
    sessionStartPayload,
    setupErrorCopy,
    validateProfileSelectionResult,
    validateSessionStartResult,
    readProfiles,
    type ConfiguredProfile,
    type ProfileSelectionResult,
    type ProviderSetupDraft,
    type SessionStartResult,
  } from "./stores/profiles";
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
    listSessions,
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

  type View = "work" | "runs" | "memory" | "models" | "extensions" | "settings";
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

  // Snapshot seam: the only thing allowed to complete a session load. Readiness proves nothing about sessions.
  let {
    loadSessions,
  }: { loadSessions?: () => Promise<readonly SplyceEvent[]> } = $props();

  let view = $state<View>("work");
  let nav = $state.raw<SessionNavState>(createSessionNav());
  // sessionId -> scopeId, as carried by the engine's own events; never invented.
  const scopes = new Map<string, string>();
  const dispatchNav = (action: SessionNavAction) => {
    nav = untrack(() => reduceSessionNav(nav, action));
  };

  let status = $state<EngineConnectionState>("disconnected");
  let readiness = $state<Handshake["readiness"] | null>(null);
  let ports = $state<PortAvailability | null>(null);
  let startedSession = $state<SessionStartResult | null>(null);
  let sessionPortWitness = $state(false);
  let generationReady = $derived(
    ports === null || (startedSession !== null && !sessionPortWitness)
      ? undefined
      : ports.generation && ports.provider,
  );
  let engineConnected = $state(false);
  // Only the id and display name of the admitted project; never its path or selection ref.
  let workspace = $state<SelectedWorkspace | null>(null);
  let choosing = $state(false);
  let chooserError = $state<string | null>(null);
  let profiles = $state<ConfiguredProfile[]>([]);
  let profileSelection = $state<ProfileSelectionResult | null>(null);
  let startReplay = $state<{
    requestId: string;
    payload: ReturnType<typeof sessionStartPayload>;
  } | null>(null);
  let activeRunId = $state<string | null>(null);
  let promptPending = $state(false);
  let cancelPending = $state(false);
  let profilePending = $state(false);
  let configuring = $state(false);
  let profileStatus = $state<string | null>(null);
  let setupEpoch = 0;
  let catalogEpoch = 0;
  let catalog = $state<ModelsListResult | null>(null);
  let catalogStatus = $state("Choose a configured profile to load its models.");
  let catalogProfileId = $state("");
  let catalogPending = $state(false);
  let switchPending = $state(false);

  async function loadCatalog(profileId: string) {
    const project = workspace;
    const epoch = ++catalogEpoch;
    catalogProfileId = profileId;
    catalog = null;
    if (!project || !profileId) {
      catalogStatus = "Choose a configured profile to load its models.";
      return;
    }
    catalogPending = true;
    catalogStatus = "Loading models…";
    try {
      const result = await readModels(
        project.workspaceId,
        profileId,
        crypto.randomUUID(),
      );
      if (epoch !== catalogEpoch) return;
      catalog = result;
      catalogStatus = result.truncated
        ? "The catalog is truncated; some models may be missing."
        : "Models loaded.";
    } catch (error) {
      if (epoch === catalogEpoch)
        catalogStatus =
          (error as { code?: string })?.code === "MODEL_CATALOG_DENIED"
            ? "Access to this catalog was denied. Select the configured profile and start a session, then try again."
            : "The model catalog could not be loaded. Try again.";
    } finally {
      if (epoch === catalogEpoch) catalogPending = false;
    }
  }

  async function useModel(model: ModelSummary) {
    const project = workspace;
    const profile = profiles.find((p) => p.profileId === catalogProfileId);
    if (
      !project ||
      !profile?.providerConnectionId ||
      !profile.connectionRevision ||
      !profile.endpointRevision ||
      !profile.endpoint ||
      !profile.locality ||
      !profile.apiFamily ||
      profile.credential !== "configured" ||
      switchPending ||
      profilePending ||
      configuring
    )
      return;
    const known = model.modelId === profile.modelId ? profile.model : undefined;
    const context = model.contextWindow ?? known?.contextWindow;
    if (!context) {
      catalogStatus =
        "This model has no context limit. It cannot be configured safely.";
      return;
    }
    const epoch = ++setupEpoch;
    ++catalogEpoch;
    switchPending = true;
    sessionPortWitness = false;
    startedSession = null;
    profileStatus = "Saving model…";
    catalogStatus = "Saving model…";
    const requestId = crypto.randomUUID();
    try {
      const result = configuredProfileResult(
        await sendSetup("provider.configure", requestId, {
          requestId,
          workspaceId: project.workspaceId,
          providerConnectionId: profile.providerConnectionId,
          profileId: profile.profileId,
          apiFamily: profile.apiFamily,
          endpoint: profile.endpoint,
          locality: profile.locality,
          chat: {
            modelId: model.modelId,
            model: {
              contextWindow: context,
              maxOutputTokens: Math.min(8192, context),
              reasoning: known?.reasoning ?? false,
              input: known?.input ?? ["text"],
            },
          },
          accountScopeRef: "provider-default",
          credential: { kind: "keep" },
          expectedConnectionRevision: profile.connectionRevision,
          expectedProfileRevision: profile.profileRevision,
          expectedEndpointRevision: profile.endpointRevision,
        }),
      );
      if (epoch !== setupEpoch) return;
      if (result.profileId !== profile.profileId)
        throw new Error("Invalid profile");
      profiles = profiles.map((p) =>
        p.profileId === result.profileId
          ? { ...p, ...result, modelId: model.modelId }
          : { ...p, configRevision: result.configRevision },
      );
      catalogStatus = "Model saved. Selecting profile…";
      await useProfile({ ...profile, ...result, modelId: model.modelId }, true);
      if (setupEpoch !== epoch + 1) return;
      try {
        const refreshed = await readProfiles(
          project.workspaceId,
          crypto.randomUUID(),
        );
        if (setupEpoch !== epoch + 1) return;
        if (!refreshed.profiles.some((p) => p.profileId === profile.profileId))
          throw new Error("Profile missing");
        profiles = refreshed.profiles;
        catalogStatus = "Model selection finished. Check session status.";
      } catch {
        if (setupEpoch !== epoch + 1) return;
        profiles = profiles.map(
          ({
            providerConnectionId: _id,
            connectionRevision: _connection,
            endpointRevision: _endpointRevision,
            endpoint: _endpoint,
            locality: _locality,
            model: _model,
            ...p
          }) => p,
        );
        catalogStatus =
          "Model selection finished, but profile details could not be refreshed. Reload before switching again.";
      }
    } catch (error) {
      if (epoch === setupEpoch) {
        catalogStatus = setupErrorCopy(error);
        profileStatus =
          "Model change could not be confirmed. Sending stays blocked.";
      }
    } finally {
      if (setupEpoch === epoch || setupEpoch === epoch + 1)
        switchPending = false;
    }
  }
  let composerKey = $state(0);
  let permissionModeState = $state(initialPermissionMode(null));
  let permissionKnown = $state(false);
  const permissionOptions: readonly PermissionMode[] = [
    "manual",
    "auto",
    "bypass",
  ];
  const permissionContext: PermissionModeContext = $derived({
    engine:
      permissionKnown &&
      startedSession &&
      $selectedSession?.sessionId === startedSession.sessionId &&
      readiness?.state === "ready" &&
      permissionModeState.status !== "pending"
        ? "ready"
        : "unavailable",
    engineReason: "Start a ready session to change permissions.",
    configRevision: profileSelection?.configRevision ?? null,
    policyRevision: startedSession?.policyRevision ?? null,
  });

  function invalidateSetup() {
    setupEpoch++;
    catalogEpoch++;
    catalog = null;
    catalogProfileId = "";
    catalogPending = false;
    switchPending = false;
    catalogStatus = "Choose a configured profile to load its models.";
    sessionPortWitness = false;
    startReplay = null;
    activeRunId = null;
    promptPending = false;
    cancelPending = false;
    profiles = [];
    profileSelection = null;
    startedSession = null;
    permissionModeState = initialPermissionMode(null);
    permissionKnown = false;
    profilePending = false;
    configuring = false;
    profileStatus = null;
  }
  const chooserReason = $derived(
    readiness?.state === "ready"
      ? null
      : "The engine is not connected. A project cannot be chosen yet.",
  );
  const providerUnavailable = $derived(
    profilePending || configuring || switchPending
      ? "Provider setup is already in progress."
      : readiness?.state !== "ready"
        ? "The engine is not connected. Nothing can be saved."
        : workspace === null
          ? "Choose a project first. Provider setup is saved for a project."
          : undefined,
  );

  async function chooseProject() {
    if (choosing || chooserReason) return;
    choosing = true;
    chooserError = null;
    try {
      const chosen = await selectWorkspace();
      // Cancel (null) keeps the current project.
      if (chosen && chosen.workspaceId !== workspace?.workspaceId) {
        loadEpoch++;
        nav = createSessionNav();
        scopes.clear();
        invalidateSetup();
        clearSession();
        workspace = chosen;
        void readSetup(chosen);
      }
    } catch {
      chooserError = "Could not open the project. Nothing changed.";
    } finally {
      choosing = false;
    }
  }

  async function readSetup(project: SelectedWorkspace) {
    const epoch = ++setupEpoch;
    const requestId = crypto.randomUUID();
    try {
      const result = await readProfiles(project.workspaceId, requestId);
      if (epoch !== setupEpoch) return;
      profiles = result.profiles;
      profileSelection = result.selection;
      startedSession = null;
      profileStatus = "Saved profiles loaded. Start a session before sending.";
    } catch {
      if (epoch === setupEpoch)
        profileStatus = "Saved profiles could not be loaded.";
    }
  }

  // The secret lives only in this one send; the payload object is not kept.
  async function configureProvider(draft: ProviderSetupDraft) {
    if (
      !workspace ||
      readiness?.state !== "ready" ||
      configuring ||
      profilePending
    )
      throw new Error("Setup unavailable");
    const project = workspace;
    const epoch = ++setupEpoch;
    configuring = true;
    profileSelection = null;
    startedSession = null;
    profileStatus = null;
    const requestId = crypto.randomUUID();
    try {
      const result = configuredProfileResult(
        await sendSetup(
          "provider.configure",
          requestId,
          providerConfigurePayload(draft, project.workspaceId, requestId),
        ),
      );
      if (epoch !== setupEpoch) throw { code: "WORKSPACE_SUPERSEDED" };
      profiles = [
        ...profiles
          .filter((p) => p.profileId !== result.profileId)
          .map((p) => ({ ...p, configRevision: result.configRevision })),
        result,
      ];
      try {
        const refreshed = await readProfiles(
          project.workspaceId,
          crypto.randomUUID(),
        );
        if (epoch !== setupEpoch) throw { code: "WORKSPACE_SUPERSEDED" };
        if (refreshed.profiles.some((p) => p.profileId === result.profileId))
          profiles = refreshed.profiles;
      } catch (error) {
        if (epoch !== setupEpoch) throw error;
        profileStatus =
          "Provider saved, but profile details could not be refreshed.";
      }
    } finally {
      if (epoch === setupEpoch) configuring = false;
    }
  }

  async function useProfile(profile: ConfiguredProfile, fromSwitch = false) {
    if (
      !workspace ||
      readiness?.state !== "ready" ||
      profilePending ||
      configuring ||
      (switchPending && !fromSwitch) ||
      profile.credential === "missing"
    )
      return;
    const project = workspace;
    const epoch = ++setupEpoch;
    profilePending = true;
    sessionPortWitness = false;
    startReplay = null;
    activeRunId = null;
    profileSelection = null;
    startedSession = null;
    profileStatus = "Selecting profile…";
    try {
      const requestId = crypto.randomUUID();
      const selected = validateProfileSelectionResult(
        await sendSetup(
          "profile.select",
          requestId,
          profileSelectPayload(profile, project.workspaceId, requestId),
        ),
      );
      if (epoch !== setupEpoch) return;
      if (selected.selectedProfileId !== profile.profileId)
        throw new Error("Invalid selection");
      profileSelection = selected;
      clearSession();
      profiles = profiles.map((p) => ({
        ...p,
        configRevision: selected.configRevision,
        ...(p.profileId === selected.selectedProfileId && {
          profileRevision: selected.profileRevision,
        }),
      }));
      // A saved profile never proves session readiness. Only this native receipt can.
      profileStatus = "Starting session…";
      const startRequestId = crypto.randomUUID();
      const startPayload = sessionStartPayload(
        selected,
        project.workspaceId,
        startRequestId,
      );
      startReplay = { requestId: startRequestId, payload: startPayload };
      const started = validateSessionStartResult(
        await sendSetup("session.start", startRequestId, startPayload),
      );
      if (epoch !== setupEpoch) return;
      startedSession = started;
      permissionModeState = {
        ...initialPermissionMode(started.sessionId),
        effective: started.permissionMode ?? "manual",
      };
      permissionKnown = true;
      startReplay = { requestId: startRequestId, payload: startPayload };
      if (started.readiness.state === "ready") {
        profileStatus = "Checking engine readiness…";
        try {
          const verified = await handshake();
          if (epoch !== setupEpoch) return;
          readiness = verified.readiness;
          sessionPortWitness = true;
          selectSession({
            sessionId: started.sessionId,
            scopeId: project.workspaceId,
          });
          profileStatus = "Profile selected. Session ready.";
        } catch {
          if (epoch !== setupEpoch) return;
          profileStatus =
            "Profile selected. Engine readiness could not be confirmed. Sending stays blocked.";
        }
      } else {
        profileStatus =
          "Profile selected. The session is unavailable. Sending stays blocked.";
      }
    } catch (error) {
      if (epoch === setupEpoch) {
        startedSession = null;
        profileStatus = profileSelection
          ? `Profile selected. Session could not be started. ${setupErrorCopy(error)}`
          : setupErrorCopy(error);
      }
    } finally {
      if (epoch === setupEpoch) profilePending = false;
    }
  }
  async function changeMode(mode: PermissionMode) {
    const project = workspace;
    const session = startedSession;
    if (
      !project ||
      !session ||
      permissionModeState.sessionId !== session.sessionId ||
      (mode !== "manual" && mode !== "auto" && mode !== "bypass")
    )
      return;
    const request = confirmedPermissionModeRequest(
      permissionModeState,
      mode,
      permissionContext,
    );
    if (request.kind !== "requested") return;
    const epoch = setupEpoch;
    permissionModeState = request.state;
    const requestId = crypto.randomUUID();
    try {
      const payload = {
        requestId,
        workspaceId: project.workspaceId,
        sessionId: session.sessionId,
        mode,
      };
      validatePermissionResult(
        await sendSetup("permission.set", requestId, payload),
        payload,
      );
      if (
        epoch !== setupEpoch ||
        permissionModeState.sessionId !== session.sessionId
      )
        return;
      permissionModeState = acknowledgeMode(permissionModeState, mode);
      permissionKnown = true;
    } catch {
      if (
        epoch === setupEpoch &&
        permissionModeState.sessionId === session.sessionId
      )
        permissionModeState = rejectMode(
          permissionModeState,
          "Permission change could not be confirmed.",
        );
    }
  }

  async function newChat(retryStart = false) {
    const project = workspace;
    const selected = profileSelection;
    if (
      !project ||
      !selected ||
      readiness?.state !== "ready" ||
      profilePending ||
      configuring ||
      activeRunId !== null ||
      promptPending
    )
      return;
    const epoch = ++setupEpoch;
    profilePending = true;
    sessionPortWitness = false;
    activeRunId = null;
    startedSession = null;
    const replay = retryStart ? startReplay : null;
    startReplay = null;
    permissionModeState = initialPermissionMode(null);
    permissionKnown = false;
    clearSession();
    turns = createTurnsState();
    if (!retryStart) composerKey++;
    view = "work";
    profileStatus = "Starting session…";
    const requestId = replay?.requestId ?? crypto.randomUUID();
    const payload =
      replay?.payload ??
      sessionStartPayload(selected, project.workspaceId, requestId);
    startReplay = { requestId, payload };
    try {
      const started = validateSessionStartResult(
        await sendSetup("session.start", requestId, payload),
      );
      if (epoch !== setupEpoch) return;
      startedSession = started;
      permissionModeState = {
        ...initialPermissionMode(started.sessionId),
        effective: started.permissionMode ?? "manual",
      };
      permissionKnown = true;
      startReplay = { requestId, payload };
      if (started.readiness.state !== "ready")
        throw new Error("Session unavailable");
      const verified = await handshake();
      if (epoch !== setupEpoch) return;
      readiness = verified.readiness;
      sessionPortWitness = true;
      selectSession({
        sessionId: started.sessionId,
        scopeId: project.workspaceId,
      });
      profileStatus = "Profile selected. Session ready.";
      void runLoad();
    } catch (error) {
      if (epoch === setupEpoch)
        profileStatus = `Session could not be started. ${setupErrorCopy(error)}`;
    } finally {
      if (epoch === setupEpoch) profilePending = false;
    }
  }
  function isOpaqueId(value: string) {
    return (
      !/[\uD800-\uDFFF]/u.test(value) &&
      value.length > 0 &&
      value.length <= 128 &&
      !/[\s\p{Cc}\p{Cf}\/\\]/u.test(value)
    );
  }

  async function refreshStaleSession(epoch: number) {
    const previous = startedSession;
    const project = workspace;
    sessionPortWitness = false;
    if (!project || !previous) return;
    const requestId = crypto.randomUUID();
    try {
      const refreshed = validateSessionStartResult(
        await sendSetup("session.resume", requestId, {
          requestId,
          workspaceId: project.workspaceId,
          sessionId: previous.sessionId,
        }),
      );
      if (epoch !== setupEpoch) return;
      if (
        refreshed.sessionId !== previous.sessionId ||
        refreshed.sessionRevision !== previous.sessionRevision ||
        refreshed.readiness.state !== "ready"
      )
        throw new Error("Invalid readiness refresh");
      const verified = await handshake();
      if (epoch !== setupEpoch) return;
      startedSession = refreshed;
      permissionModeState = {
        ...initialPermissionMode(refreshed.sessionId),
        effective: refreshed.permissionMode ?? "manual",
      };
      permissionKnown = true;
      readiness = verified.readiness;
      sessionPortWitness = true;
      retry();
    } catch {
      if (epoch === setupEpoch)
        profileStatus =
          "Session readiness could not be refreshed. Sending stays blocked.";
    }
  }

  let stopped = $derived(engineConnected && status === "disconnected");
  let mounted = false;
  let turns = $state.raw<TurnsState>(createTurnsState());
  let subscription = $state<BindingStatus>({ state: "idle" });
  let retry = $state<() => void>(() => {});
  let currentRun = $derived(
    turns.currentRunId ? turns.runs[turns.currentRunId] : undefined,
  );
  let transcriptEnd: HTMLDivElement | undefined = $state();
  $effect(() => {
    turns.lastSeq;
    if (view === "work")
      void tick().then(() =>
        transcriptEnd?.scrollIntoView?.({ block: "nearest" }),
      );
  });
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

  let loadEpoch = 0;
  async function runLoad() {
    const project = workspace;
    const epoch = ++loadEpoch;
    dispatchNav({ type: "refresh" });
    try {
      if (loadSessions) {
        const events = await loadSessions();
        if (epoch !== loadEpoch) return;
        for (const event of events) applyTree(event);
        dispatchNav({ type: "loaded" });
      } else if (project) {
        const snapshot = await listSessions(
          project.workspaceId,
          crypto.randomUUID(),
        );
        if (
          epoch !== loadEpoch ||
          workspace?.workspaceId !== project.workspaceId
        )
          return;
        for (const session of snapshot.sessions)
          scopes.set(session.sessionId, project.workspaceId);
        dispatchNav({ type: "snapshot", sessions: snapshot.sessions });
      }
    } catch (e) {
      if (
        epoch !== loadEpoch ||
        workspace?.workspaceId !== project?.workspaceId
      )
        return;
      dispatchNav({
        type: "failed",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // Readiness never completes a load: without a snapshot the previous navigation state is kept, selection included.
  $effect(() => {
    if (
      !loadSessions &&
      readiness?.state === "ready" &&
      (status === "ready" || status === "busy" || status === "unavailable")
    ) {
      if (workspace) void runLoad();
      else if (untrack(() => Object.keys(nav.branches).length > 0))
        dispatchNav({ type: "loaded" });
      else nav = createSessionNav();
    } else if (status === "ready") {
      if (loadSessions) void runLoad();
      else if (untrack(() => Object.keys(nav.branches).length > 0))
        dispatchNav({ type: "loaded" });
    } else if (
      status === "error" ||
      (status === "unavailable" && readiness?.state !== "ready")
    )
      dispatchNav({ type: "failed", message: "Engine unavailable." });
  });

  function onSelect(key: string) {
    if (activeRunId !== null || promptPending) return;
    dispatchNav({ type: "select", key });
    const node = visibleNodes(nav).find((n) => n.key === key);
    const scopeId = node && scopes.get(node.sessionId);
    if (node && scopeId) {
      permissionModeState = initialPermissionMode(node.sessionId);
      permissionKnown = false;
      selectSession({ sessionId: node.sessionId, scopeId });
      view = "work";
      if (startedSession?.sessionId !== node.sessionId) {
        startedSession = null;
        sessionPortWitness = false;
        void resumeSession(scopeId, node.sessionId);
      } else {
        void readPermission(scopeId, node.sessionId);
      }
    }
  }

  async function resumeSession(workspaceId: string, sessionId: string) {
    if (
      !profileSelection ||
      workspace?.workspaceId !== workspaceId ||
      readiness?.state !== "ready"
    ) {
      profileStatus = "Select a profile to resume this session.";
      void readPermission(workspaceId, sessionId);
      return;
    }
    const epoch = ++setupEpoch;
    profilePending = true;
    profileStatus = "Resuming session…";
    const requestId = crypto.randomUUID();
    try {
      const resumed = validateSessionStartResult(
        await sendSetup("session.resume", requestId, {
          requestId,
          workspaceId,
          sessionId,
        }),
      );
      if (
        epoch !== setupEpoch ||
        $selectedSession?.sessionId !== sessionId ||
        workspace?.workspaceId !== workspaceId
      )
        return;
      if (
        resumed.sessionId !== sessionId ||
        resumed.readiness.state !== "ready"
      )
        throw new Error("Session unavailable");
      const verified = await handshake();
      if (
        epoch !== setupEpoch ||
        $selectedSession?.sessionId !== sessionId ||
        workspace?.workspaceId !== workspaceId
      )
        return;
      startedSession = resumed;
      permissionModeState = {
        ...initialPermissionMode(sessionId),
        effective: resumed.permissionMode ?? "manual",
      };
      permissionKnown = true;
      readiness = verified.readiness;
      sessionPortWitness = true;
      profileStatus = "Session ready.";
    } catch {
      if (epoch === setupEpoch && $selectedSession?.sessionId === sessionId) {
        profileStatus =
          "Could not resume this session. Select it again to retry.";
        void readPermission(workspaceId, sessionId);
      }
    } finally {
      if (epoch === setupEpoch) profilePending = false;
    }
  }

  // The selected branch vanished from the latest snapshot: drop the selection with it.
  $effect(() => {
    if (nav.lostSelection) clearSession();
  });

  async function readPermission(workspaceId: string, sessionId: string) {
    const requestId = crypto.randomUUID();
    try {
      const payload = { requestId, workspaceId, sessionId };
      const { mode } = validatePermissionResult(
        await sendSetup("permission.read", requestId, payload),
        payload,
      );
      if (
        permissionModeState.sessionId !== sessionId ||
        workspace?.workspaceId !== workspaceId
      )
        return;
      permissionModeState = {
        ...initialPermissionMode(sessionId),
        effective: mode,
      };
      permissionKnown = true;
    } catch {
      if (permissionModeState.sessionId === sessionId)
        profileStatus = "Session permission mode could not be read.";
    }
  }

  function canRespond(actionId: string) {
    return (
      !!workspace &&
      !!profileSelection &&
      !!startedSession &&
      (status === "ready" || status === "busy") &&
      subscription.state === "live" &&
      !turns.stale &&
      !turns.needsResync &&
      $selectedSession?.sessionId === startedSession.sessionId &&
      $selectedSession?.scopeId === workspace.workspaceId &&
      currentRun?.actions.some(
        (action) =>
          action.actionId === actionId &&
          action.approval?.state === "requested",
      ) === true
    );
  }

  async function onApproval(
    approvalRequestId: string,
    runId: string,
    actionId: string,
    decision: "approve" | "deny",
  ) {
    const project = workspace;
    const selected = profileSelection;
    const session = startedSession;
    if (
      !project ||
      !selected ||
      !session ||
      currentRun?.runId !== runId ||
      !canRespond(actionId) ||
      !currentRun.actions.some(
        (action) =>
          action.actionId === actionId &&
          action.approval?.approvalRequestId === approvalRequestId &&
          action.approval.runId === runId,
      )
    )
      throw new Error("Approval unavailable");
    await invoke(
      "approval.respond",
      { approvalRequestId, runId, actionId, decision },
      {
        sessionId: session.sessionId,
        scopeId: project.workspaceId,
        expectedConfigRevision: selected.configRevision,
        expectedProfileRevision: selected.profileRevision,
        expectedPolicyRevision: session.policyRevision,
      },
    );
  }

  async function connect() {
    invalidateSetup();
    readiness = null;
    try {
      const verified = await handshake();
      if (!mounted) return;
      readiness = status === "disconnected" ? null : verified.readiness;
      engineConnected = true;
      if (workspace && readiness?.state === "ready") void readSetup(workspace);
    } catch {
      // The engine store publishes the unavailable/error state.
    }
  }

  onMount(() => {
    mounted = true;
    // This component is the workbench: the only writer of the session-selection store.
    const transport = createTurnStreamTransport({
      onState: (next) => {
        turns = next;
        if (
          activeRunId &&
          ["completed", "failed", "canceled", "stopped"].includes(
            next.runs[activeRunId]?.status ?? "",
          )
        )
          activeRunId = null;
      },
      onResync: (fromSeq, sessionId) => {
        void binding.resubscribe(sessionId, fromSeq);
      },
    });
    const binding = bindSelection(transport, subscribe);
    const unsubState = connectionState.subscribe((val) => {
      status = val;
      if (val === "disconnected") {
        invalidateSetup();
        readiness = null;
        ports = null;
      }
    });
    const unsubPorts = portAvailability.subscribe((val) => {
      ports = val;
    });
    const unsubBinding = binding.status.subscribe((next) => {
      subscription = next;
    });
    retry = () => void binding.retry();
    const unsubEvents = onEvent((event) => {
      applyTree(event);
      transport.enqueue(event);
    });

    void connect();

    return () => {
      mounted = false;
      setupEpoch++;
      catalogEpoch++;
      unsubState();
      unsubPorts();
      unsubEvents();
      unsubBinding();
      binding.dispose();
      transport.dispose();
      clearSession();
    };
  });
  const selectedProfile = $derived(
    profiles.find((p) => p.profileId === profileSelection?.selectedProfileId),
  );
  $effect(() => {
    if (
      view === "models" &&
      startedSession?.readiness.state === "ready" &&
      profileSelection &&
      untrack(() => catalogProfileId) !== profileSelection.selectedProfileId
    )
      void loadCatalog(profileSelection.selectedProfileId);
  });
  const providerLabel = $derived(
    `${profileSelection ? (selectedProfile?.endpointOrigin ?? "Selected provider") : "No provider selected"} · no automatic fallback`,
  );
  async function unavailableForget() {
    throw new Error("The memory feed is unavailable.");
  }
</script>

<div
  data-testid="app-shell"
  data-connection-state={status}
  data-readiness-policy={readiness ? readiness.policy : "unknown"}
  data-readiness-store={readiness ? readiness.store : "unknown"}
  data-readiness-receipts={readiness ? readiness.receipts : "unknown"}
  data-readiness-generation={ports ? ports.generation : "unknown"}
>
  <Workbench
    {view}
    onNewChat={() => void newChat()}
    newChatUnavailable={!workspace ||
      !profileSelection ||
      readiness?.state !== "ready" ||
      profilePending ||
      configuring ||
      activeRunId !== null ||
      promptPending}
    effectiveMode={permissionKnown
      ? PERMISSION_MODE_LABELS[permissionModeState.effective]
      : "Unknown"}
    onNavigate={(next) => (view = next)}
    workspaceName={workspace?.displayName}
    {choosing}
    projectUnavailable={chooserReason !== null || choosing}
    projectStatus={chooserReason ?? chooserError}
    onChooseProject={() => void chooseProject()}
    engineReady={readiness?.state === "ready"}
    engineStatus={stopped
      ? "Engine stopped"
      : readiness?.state === "ready"
        ? "Pi engine · local"
        : "Pi engine · unavailable"}
  >
    <div class="work-panel" hidden={view !== "work"}>
      <div class="page work-page" class:has-session={$selectedSession !== null}>
        <div class="work-stage">
          <header class="page-head">
            {#if $selectedSession === null && !currentRun}
              <h1 class="work-motto">
                Barebones by default.<br />Modular by choice.<br /><em
                  >Evidence by design.</em
                >
              </h1>
            {:else}
              <div>
                <div class="eyebrow">
                  Work · {workspace?.displayName ?? "Project unavailable"}
                </div>
                <h1>Session</h1>
                <p class="sub">{$selectedSession?.sessionId}</p>
              </div>
            {/if}
            <button
              type="button"
              disabled={!workspace ||
                !profileSelection ||
                readiness?.state !== "ready" ||
                profilePending ||
                configuring ||
                activeRunId !== null ||
                promptPending}
              onclick={() => void newChat()}>+ New chat</button
            >
          </header>
          {#if activeRunId}<p role="status">
              Stop the active turn before starting a new chat.
            </p>{/if}
          {#if profileStatus && !startedSession}
            <p role="status">{profileStatus}</p>
            {#if startReplay && !profilePending}<button
                type="button"
                onclick={() => void newChat(true)}>Retry session start</button
              >{/if}
          {/if}
          <ApprovalSurface
            requests={approvalRequests}
            context={approvalContext}
          />
          {#if subscription.state === "failed"}
            <div class="notice" role="alert" data-testid="subscribe-error">
              <span
                >Could not subscribe to the session: {subscription.error}</span
              ><button type="button" onclick={retry}>Retry</button>
            </div>
          {/if}
          {#if currentRun}
            <section class="turn-pane" aria-label="Transcript">
              {#each Object.values(turns.runs) as run (run.runId)}
                <TurnStream
                  {run}
                  stale={turns.stale ||
                    turns.needsResync ||
                    (status !== "ready" && status !== "busy")}
                  {canRespond}
                  {onApproval}
                />
              {/each}
              <div bind:this={transcriptEnd}></div>
            </section>
          {:else if $selectedSession}
            <p class="session-empty">
              No transcript events have been received for this session.
            </p>
          {/if}
          {@render composer()}
          {#if view !== "runs"}<section
              class="work-recents"
              aria-labelledby="recents-label"
            >
              <h2 class="recents-label" id="recents-label">Recents</h2>
              {@render sessions()}
            </section>{/if}
          <div class="work-hint">
            <span
              ><Icon name="shield" size={11} /> Policy checked before dispatch</span
            ><span><Icon name="lock" size={11} /> {providerLabel}</span>
          </div>
          <p class="locality-note">
            Local workspace and engine. Requests use your explicitly selected
            provider.
          </p>
          {@render engineNotice()}
          {#if view !== "runs"}<details class="session-details">
              <summary>Session actions and evidence</summary><SessionActions
                context={sessionActionContext}
              />
              <p>No changes or evidence available.</p>
            </details>{/if}
        </div>
      </div>
    </div>
    {#if view !== "work"}
      <div class="page settings-page">
        <header class="page-head">
          <div>
            <div class="eyebrow">Your workspace</div>
            <h1>
              {{
                runs: "Runs",
                memory: "Memory",
                models: "Models",
                extensions: "Extensions",
                settings: "Settings",
              }[view]}
            </h1>
            <p class="sub">
              {{
                runs: "Sessions reported by the engine.",
                memory: "Remembered items, with their source and scope.",
                models:
                  "Connect a provider and select a profile for this project.",
                extensions:
                  "Optional modules. Install and enable only what you choose.",
                settings: "Setup, permissions and usage for your workspace.",
              }[view]}
            </p>
          </div>
        </header>
        {#if view === "runs"}
          <div class="surface-card">
            {@render sessions()}<SessionActions
              context={sessionActionContext}
            />
          </div>
        {:else if view === "memory"}
          <div class="surface-card">
            <MemoryList
              entries={[]}
              status="unavailable"
              onForget={unavailableForget}
            />
            <p>
              The renderer memory feed is not connected. Stored engine memory is
              not shown here.
            </p>
          </div>
        {:else if view === "models"}
          <div class="surface-card providers" data-testid="providers-view">
            <Providers
              connections={[]}
              families={[]}
              {profiles}
              workspaceSelected={workspace !== null}
              selectedProfileId={profileSelection?.selectedProfileId ?? null}
              selectProfile={useProfile}
              {profilePending}
              {profileStatus}
              credentialSubmit={providerUnavailable
                ? undefined
                : configureProvider}
              credentialUnavailable={providerUnavailable}
            />
          </div>
          <div class="surface-card">
            <ModelCatalog
              {profiles}
              {catalogProfileId}
              {catalog}
              {catalogStatus}
              {catalogPending}
              {switchPending}
              onLoad={loadCatalog}
              onUse={useModel}
            />
          </div>
          <SupportStatus cells={null} />
        {:else if view === "extensions"}
          <div class="surface-card">
            <Modules
              snapshot={moduleSnapshot}
              onConfigureProvider={() => (view = "models")}
            />
          </div>
        {:else if view === "settings"}
          <div class="surface-card">
            <Setup
              snapshot={moduleSnapshot}
              onEnterWorkbench={() => (view = "work")}
              onOpenModules={() => (view = "extensions")}
              onConfigureProvider={() => (view = "models")}
            />
          </div>
          <section
            class="surface-card supervisor"
            aria-label="Supervisor"
            data-testid="supervisor"
          >
            <h2>Supervisor</h2>
            <p>Saved for this workspace and used by new chats.</p>
            <PermissionModeSelect
              modeState={permissionModeState}
              context={permissionContext}
              options={permissionOptions}
              onChange={(mode) => void changeMode(mode)}
            />
          </section>
          <div class="surface-card">
            <UsageView usage={null} status="unavailable" />
          </div>
        {/if}
      </div>
    {/if}
  </Workbench>
</div>

{#snippet sessions()}
  <SessionTree
    {nav}
    {onSelect}
    unavailableReason={!loadSessions &&
    nav.load === "loading" &&
    readiness?.state === "ready"
      ? "Session history is unavailable until the engine delivers session records."
      : undefined}
    canRetry={readiness?.state === "ready" && (!!loadSessions || !!workspace)}
    onFocus={(key) => dispatchNav({ type: "focus", key })}
    onMove={(to) => dispatchNav({ type: "move", to })}
    onRetry={() => {
      if (readiness?.state === "ready" && (loadSessions || workspace))
        void runLoad();
    }}
  />
{/snippet}

{#snippet engineNotice()}
  {#if status !== "ready" && status !== "busy"}
    <div
      class="notice engine-notice"
      data-testid="unavailable-banner"
      role="status"
      aria-live="polite"
    >
      <h2>
        {stopped
          ? "Engine stopped"
          : readiness?.state === "ready"
            ? "Generation unconfigured"
            : "Engine Unavailable"}
      </h2>
      <p>
        {stopped
          ? "The native engine exited. Reconnect to resume or restart the app; the last transcript may be incomplete."
          : readiness?.state === "ready"
            ? "Generation requires a configured provider and workspace."
            : "The native engine is unavailable. Open the desktop app to connect your project and provider."}
      </p>
      {#if stopped || status === "unavailable" || status === "error"}<button
          type="button"
          onclick={() => void connect()}>Retry</button
        >{/if}
    </div>
  {/if}
{/snippet}

{#snippet composer()}
  {#if ports && !ports.workspace}
    <p role="status">Workspace tools unavailable</p>
  {/if}
  {#key composerKey}
    <Composer
      workspaceName={workspace?.displayName}
      runtimeName={selectedProfile?.modelId}
      onChooseProject={() => void chooseProject()}
      projectUnavailable={chooserReason !== null || choosing}
      onOpenModels={() => (view = "models")}
      connection={status}
      sessionId={startedSession?.sessionId ??
        $selectedSession?.sessionId ??
        null}
      {generationReady}
      workspaceSelected={workspace !== null}
      profileSelected={profileSelection !== null}
      sessionReadiness={startedSession?.readiness.state}
      stale={turns.stale || turns.needsResync}
      unavailable={subscription.state !== "live" ||
      $selectedSession?.sessionId !== startedSession?.sessionId ||
      $selectedSession?.scopeId !== workspace?.workspaceId
        ? "Session subscription is unavailable. Sending stays blocked."
        : activeRunId
          ? "A turn is running."
          : undefined}
      cancellable={activeRunId !== null && !cancelPending}
      cancel={async () => {
        if (!startedSession || !activeRunId || cancelPending) return;
        const epoch = setupEpoch;
        const sessionId = startedSession.sessionId;
        const runId = activeRunId;
        cancelPending = true;
        try {
          await cancelSession(sessionId);
          if (epoch === setupEpoch && activeRunId === runId) activeRunId = null;
        } catch {
          if (epoch === setupEpoch)
            profileStatus = "Cancellation could not be confirmed.";
        } finally {
          if (epoch === setupEpoch) cancelPending = false;
        }
      }}
      send={async (payload) => {
        const project = workspace;
        const selected = profileSelection;
        const session = startedSession;
        const epoch = setupEpoch;
        if (
          !project ||
          !selected ||
          !session ||
          status !== "ready" ||
          generationReady !== true ||
          subscription.state !== "live" ||
          !sessionPortWitness ||
          turns.stale ||
          turns.needsResync ||
          $selectedSession?.sessionId !== session.sessionId ||
          $selectedSession?.scopeId !== project.workspaceId
        )
          throw new Error("Session unavailable");
        promptPending = true;
        try {
          const result = await invoke("session.prompt", payload, {
            sessionId: session.sessionId,
            scopeId: project.workspaceId,
            expectedConfigRevision: selected.configRevision,
            expectedProfileRevision: selected.profileRevision,
            expectedPolicyRevision: session.policyRevision,
          });
          if (
            result === null ||
            typeof result !== "object" ||
            Array.isArray(result) ||
            Object.keys(result).length !== 3 ||
            (result as { accepted?: unknown }).accepted !== true ||
            typeof (result as { runId?: unknown }).runId !== "string" ||
            !isOpaqueId((result as { runId: string }).runId) ||
            typeof (result as { turnId?: unknown }).turnId !== "string" ||
            !isOpaqueId((result as { turnId: string }).turnId)
          )
            throw new Error("Invalid acknowledgement");
          if (epoch !== setupEpoch) throw new Error("Session changed");
          const runId = (result as { runId: string }).runId;
          if (
            !["completed", "failed", "canceled", "stopped"].includes(
              turns.runs[runId]?.status ?? "",
            )
          )
            activeRunId = runId;
        } catch (error) {
          if (
            epoch === setupEpoch &&
            error !== null &&
            typeof error === "object" &&
            Object.hasOwn(error, "code") &&
            (error as { code?: unknown }).code === "STALE_REVISION"
          )
            void refreshStaleSession(epoch);
          throw error;
        } finally {
          if (epoch === setupEpoch) promptPending = false;
        }
      }}
    >
      {#snippet modeControl()}
        <PermissionModeSelect
          compact
          id="composer-permission-mode"
          modeState={permissionModeState}
          context={permissionContext}
          options={permissionOptions}
          onChange={(mode) => void changeMode(mode)}
        />
      {/snippet}
    </Composer>
  {/key}
{/snippet}
