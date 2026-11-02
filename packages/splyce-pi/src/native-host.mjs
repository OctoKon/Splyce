import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { RevisionFence } from "../dist/admission.js";
import { ConfigAuthority } from "../dist/config.js";
import { createProviderProfiles } from "../dist/provider-profiles.js";
import { Receipts } from "../dist/receipts.js";
import { captureMemoryAfterTurn as captureTurn } from "../dist/agent-context-tools.js";
import { createNativeProviderSetup } from "./native-provider-setup.mjs";
import { createNativeSessionSetup } from "./native-session-setup.mjs";
import { NativeControl } from "./native-control.mjs";
import { PI_REVISION } from "../dist/contracts.js";
import {
  PageReadError,
  validatePageReadRequest,
  validatePageReadResult,
} from "../dist/page-data.js";
import {
  NATIVE_POLICY_REVISION,
  currentNativePolicyRevision,
} from "../dist/policy.js";
import {
  INITIAL_CONFIG_REVISION,
  Store,
  workspaceView,
} from "../dist/store.js";

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function opaqueId(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    /\s|[\\/]/u.test(value)
  )
    fail("NATIVE_INVALID_ID");
}

function lazyFactory(options) {
  let instance;
  let loading;
  const listeners = new Set();
  const get = async () => {
    loading ??= import("./native-session-factory.mjs").then(
      ({ createNativeSessionFactory }) => {
        instance = createNativeSessionFactory(options);
        for (const listener of listeners)
          listener.release = instance.onEvents?.(listener.fn);
        return instance;
      },
    );
    return loading;
  };
  const existing = () => {
    if (!instance) fail("NATIVE_SESSION_UNAVAILABLE");
    return instance;
  };
  return {
    get hasReadySession() {
      return instance?.hasReadySession === true;
    },
    get hasWorkspaceReadySession() {
      return instance?.hasWorkspaceReadySession === true;
    },
    isScopeReady(scopeId) {
      return instance?.isScopeReady(scopeId) === true;
    },
    onEvents(fn) {
      const listener = { fn, release: instance?.onEvents?.(fn) };
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        listener.release?.();
      };
    },
    async prepare(...args) {
      return (await get()).prepare(...args);
    },
    async restore(...args) {
      return (await get()).restore(...args);
    },
    bind(...args) {
      return existing().bind(...args);
    },
    dispose(...args) {
      return existing().dispose(...args);
    },
    preparePrompt(...args) {
      return existing().preparePrompt(...args);
    },
    cancel(...args) {
      return existing().cancel(...args);
    },
    respondApproval(...args) {
      return existing().respondApproval(...args);
    },
    subscribe(...args) {
      return existing().subscribe(...args);
    },
    unsubscribe(...args) {
      return existing().unsubscribe(...args);
    },
    drainEvents(...args) {
      return existing().drainEvents(...args);
    },
  };
}

// Private entrypoint: only Rust's first bootstrap frame supplies this path.
export function createNativeHost(appDataDir, nativeControl, sessionFactory) {
  if (
    typeof appDataDir !== "string" ||
    !isAbsolute(appDataDir) ||
    !appDataDir.isWellFormed() ||
    appDataDir.includes("\0") ||
    (process.platform === "win32" &&
      !/^[A-Za-z]:[\\/]/u.test(appDataDir.replace(/^\\\\\?\\/u, "")))
  )
    fail("NATIVE_APP_DATA_INVALID");
  if (process.platform === "win32")
    appDataDir = appDataDir.replace(/^\\\\\?\\/u, "");
  const directory = join(appDataDir, "splyce");
  mkdirSync(directory, { recursive: true });
  const store = Store.open(join(directory, "store.db"));
  const config = new ConfigAuthority(store);
  const receipts = new Receipts(store);
  const profiles = createProviderProfiles({ store, config });
  const providerSetup = createNativeProviderSetup(store, directory);
  const indexes = new Map();
  const memories = new Map();
  const openMemories = new Set();
  const pendingContext = new Set();
  let contextClosed = false;

  function requireOpen() {
    if (contextClosed) fail("NATIVE_CONTEXT_CLOSED");
  }
  function contextWorkspace(workspaceId) {
    requireOpen();
    opaqueId(workspaceId);
    const workspace = store
      .listWorkspaces()
      .find((w) => w.workspaceId === workspaceId);
    if (!workspace) fail("NATIVE_WORKSPACE_UNAVAILABLE");
    let stat, canonical;
    try {
      stat = lstatSync(workspace.canonicalPath, { bigint: true });
      canonical = realpathSync.native(workspace.canonicalPath);
    } catch {
      fail("NATIVE_WORKSPACE_CHANGED");
    }
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      String(stat.dev) !== workspace.volumeSerial ||
      String(stat.ino) !== workspace.fileId ||
      (process.platform === "win32"
        ? canonical.toLowerCase() !== workspace.canonicalPath.toLowerCase()
        : canonical !== workspace.canonicalPath)
    )
      fail("NATIVE_WORKSPACE_CHANGED");
    return workspace;
  }

  async function contextFor(cache, workspaceId, open) {
    contextWorkspace(workspaceId);
    let loading = cache.get(workspaceId);
    if (!loading) {
      loading = open();
      cache.set(workspaceId, loading);
      pendingContext.add(loading);
      loading.then(
        () => pendingContext.delete(loading),
        () => {
          pendingContext.delete(loading);
          cache.delete(workspaceId);
        },
      );
    }
    const resource = await loading;
    contextWorkspace(workspaceId);
    return resource;
  }

  // Optional modules are imported only when the native factory requests them.
  async function codeIndexFor(workspaceId) {
    return contextFor(indexes, workspaceId, async () => {
      const { CodeIndex } = await import("../../splyce-index/dist/index.js");
      const workspace = contextWorkspace(workspaceId);
      const index = await CodeIndex.open({
        root: workspace.canonicalPath,
        cacheDir: join(
          directory,
          "code-index",
          createHash("sha256").update(workspaceId).digest("hex"),
        ),
        maxFiles: 2000,
        maxFileBytes: 128 * 1024,
      });
      return new Proxy(index, {
        get(target, key) {
          contextWorkspace(workspaceId);
          const value = Reflect.get(target, key, target);
          if (typeof value !== "function") return value;
          return (...args) => {
            contextWorkspace(workspaceId);
            const result = value.apply(target, args);
            return result instanceof Promise
              ? result.then((output) => {
                  contextWorkspace(workspaceId);
                  return output;
                })
              : result;
          };
        },
      });
    });
  }

  async function codeToolsFor(workspaceId) {
    const index = await codeIndexFor(workspaceId);
    const { codeIndexTools } = await import("../../splyce-index/dist/index.js");
    contextWorkspace(workspaceId);
    return codeIndexTools(index);
  }

  async function memoryFor(workspaceId) {
    return contextFor(memories, workspaceId, async () => {
      const { Memory } = await import("../../splyce-memory/dist/memory.js");
      contextWorkspace(workspaceId);
      const path = join(
        directory,
        "memory",
        createHash("sha256").update(workspaceId).digest("hex"),
      );
      mkdirSync(path, { recursive: true });
      const memory = Memory.open(store, join(path, "memory.db"));
      openMemories.add(memory);
      const assertScope = (scopeId) => {
        contextWorkspace(workspaceId);
        if (scopeId !== workspaceId) fail("NATIVE_MEMORY_SCOPE_MISMATCH");
      };
      return Object.freeze({
        list(scopeId, limit) {
          assertScope(scopeId);
          const rows = memory.list(scopeId, limit);
          assertScope(scopeId);
          return rows;
        },
        async query(scopeId, ...args) {
          assertScope(scopeId);
          const hits = await memory.query(scopeId, ...args);
          assertScope(scopeId);
          return hits;
        },
        capture(scopeId, sessionId) {
          assertScope(scopeId);
          opaqueId(sessionId);
          return memory.capture(scopeId, sessionId);
        },
      });
    });
  }

  async function captureMemoryAfterTurn(workspaceId, sessionId) {
    opaqueId(sessionId);
    const memory = await memoryFor(workspaceId);
    contextWorkspace(workspaceId);
    return captureTurn(memory, workspaceId, sessionId);
  }

  function closeContext() {
    contextClosed = true;
    for (const memory of openMemories) memory.close();
    openMemories.clear();
    memories.clear();
    indexes.clear();
  }
  const providerCapability = (selected) => {
    const workspaceId = selected.state.workspace.workspaceId;
    const { apiFamily, adapterRevision } = selected.connection;
    if (
      !["openai-completions", "openai-responses"].includes(apiFamily) ||
      adapterRevision !== PI_REVISION
    )
      fail("NATIVE_CAPABILITY_UNAVAILABLE");
    const capabilityId = `native-provider:${apiFamily}:${adapterRevision}`;
    const descriptor = {
      kind: "native-provider-capability",
      capabilityId,
      capabilityVersion: adapterRevision,
      apiFamily,
      implementation: "NativeProviderRequests",
    };
    const bytes = Buffer.from(JSON.stringify(descriptor));
    const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    const recordId = `native-capability:${createHash("sha256").update(`${workspaceId}\0${capabilityId}`).digest("hex")}`;
    const observe = () => {
      const state = store.readSetupState(workspaceId);
      const rows = state.records.filter(
        ({ record }) =>
          record.recordId === recordId || record.artifactId === capabilityId,
      );
      return { state, rows };
    };
    const observation = observe();
    if (observation.rows.length === 0)
      store.appendBatch(
        [
          {
            kind: "artifact",
            record: {
              schemaVersion: 1,
              recordId,
              artifactId: capabilityId,
              scopeId: workspaceId,
              createdAt: new Date().toISOString(),
              sourceIds: [],
              mediaType: "application/vnd.splyce.provider-capability+json",
              retentionClass: "workspace",
              digest,
              byteLength: bytes.length,
              descriptor,
            },
          },
        ],
        {
          sessionId: "native-capability-registration",
          configRevision: selected.effective.configRevision,
          profileRevision: selected.effective.profileRevision,
          policyRevision: currentNativePolicyRevision(workspaceId),
        },
        undefined,
        undefined,
        { scopeId: workspaceId, revision: selected.effective.configRevision },
        undefined,
        { expectedDeletionEpoch: observation.state.deletionEpoch },
      );
    const { state, rows } = observe();
    const record = rows[0]?.record;
    if (
      rows.length !== 1 ||
      rows[0].kind !== "artifact" ||
      state.deletedRecordIds.includes(recordId) ||
      record.recordId !== recordId ||
      record.artifactId !== capabilityId ||
      record.scopeId !== workspaceId ||
      record.digest !== digest ||
      record.byteLength !== bytes.length ||
      record.retentionClass !== "workspace" ||
      record.mediaType !== "application/vnd.splyce.provider-capability+json" ||
      JSON.stringify(record.descriptor) !== JSON.stringify(descriptor)
    )
      fail("NATIVE_CAPABILITY_UNAVAILABLE");
    return Object.freeze({ capabilityId, capabilityVersion: adapterRevision });
  };
  const factory =
    sessionFactory ??
    (nativeControl instanceof NativeControl
      ? lazyFactory({
          store,
          profiles,
          control: nativeControl,
          directory,
          providerCapability,
          codeIndexFor,
          codeToolsFor,
          memoryFor,
          captureMemoryAfterTurn,
          currentPolicyRevision: currentNativePolicyRevision,
        })
      : undefined);
  const sessions = createNativeSessionSetup({
    store,
    control: nativeControl,
    factory,
    currentPolicyRevision: currentNativePolicyRevision,
  });
  try {
    store.audit();
    receipts.durableCursor();
    mkdirSync(join(directory, "snapshots"), { recursive: true });
  } catch (error) {
    store.close();
    throw error;
  }

  function fence(scopeId, profileId) {
    opaqueId(scopeId);
    if (profileId !== undefined) opaqueId(profileId);
    const observation = store.readAuthority(scopeId);
    const { records, deletedRecordIds } = observation;
    const applied = records.filter(
      ({ kind, record }) =>
        kind === "configurationTransition" && record.state === "applied",
    );
    const latest = applied.at(-1)?.record;
    const selected = applied.findLast(
      ({ record }) => record.profileId !== undefined,
    )?.record;
    if (
      [latest, selected].some(
        (record) => record && deletedRecordIds.includes(record.recordId),
      )
    )
      fail("NATIVE_CONFIG_UNAVAILABLE");
    const revision = latest?.acceptedConfigRevision ?? INITIAL_CONFIG_REVISION;
    if (profileId !== undefined && selected?.profileId !== profileId)
      fail(selected ? "NATIVE_PROFILE_STALE" : "NATIVE_PROFILE_UNAVAILABLE");
    if (selected) {
      const snapshot = records.find(
        ({ kind, record }) =>
          kind === "profileSnapshot" &&
          record.profileId === selected.profileId &&
          record.profileRevision === selected.profileRevision,
      );
      if (!snapshot || deletedRecordIds.includes(snapshot.record.recordId))
        fail("NATIVE_PROFILE_UNAVAILABLE");
    }
    const effective = profiles.effective(scopeId, observation);
    const profileRevision =
      effective?.profileRevision ?? INITIAL_CONFIG_REVISION;
    // Only a currently bound native session opens this scope's command gate.
    return new RevisionFence(
      { effectiveRevision: () => revision },
      {
        scopeId,
        profileRevision,
        policyRevision: currentNativePolicyRevision(scopeId),
        grantIds: [],
        planMode: factory?.isScopeReady?.(scopeId) !== true,
      },
    );
  }

  function sessionMetadata(workspaceId) {
    const snapshot = store.audit();
    const deleted = new Set(snapshot.deletedRecordIds);
    const sessions = new Map();
    const runs = new Map();
    const created = new Map();
    // Fold latest records before filtering tombstones, so deletion never revives history.
    const anchors = new Map();
    for (const { kind, record } of snapshot.records) {
      if (record.scopeId !== workspaceId) continue;
      if (kind === "branchAnchor" || kind === "run") {
        const first = created.get(record.piSessionId);
        if (first === undefined || record.createdAt < first)
          created.set(record.piSessionId, record.createdAt);
      }
      if (kind === "branchAnchor") {
        anchors.delete(record.branchAnchorId);
        anchors.set(record.branchAnchorId, record);
      }
      if (kind === "run") {
        runs.delete(record.runId);
        runs.set(record.runId, record);
      }
    }
    const add = (record, branchAnchorId = null, state = "idle") => {
      const previous = sessions.get(record.piSessionId);
      sessions.set(record.piSessionId, {
        sessionId: record.piSessionId,
        branchAnchorId: branchAnchorId ?? previous?.branchAnchorId ?? null,
        createdAt: created.get(record.piSessionId),
        updatedAt:
          previous?.updatedAt > record.createdAt
            ? previous.updatedAt
            : record.createdAt,
        state: state === "idle" ? (previous?.state ?? "idle") : state,
      });
    };
    for (const record of anchors.values())
      if (!deleted.has(record.recordId)) add(record, record.branchAnchorId);
    let runCount = 0;
    for (const record of runs.values()) {
      if (deleted.has(record.recordId)) continue;
      runCount++;
      add(record, record.branchAnchorId, record.state);
    }
    for (const { kind, record } of snapshot.records) {
      if (
        kind !== "event" ||
        record.scopeId !== workspaceId ||
        [record.recordId, ...record.sourceIds].some((id) => deleted.has(id))
      )
        continue;
      const session = sessions.get(record.envelope.sessionId);
      if (session && record.createdAt > session.updatedAt)
        session.updatedAt = record.createdAt;
    }
    return {
      sessions: [...sessions.values()].sort(
        (a, b) =>
          b.updatedAt.localeCompare(a.updatedAt) ||
          a.sessionId.localeCompare(b.sessionId),
      ),
      runCount,
    };
  }

  async function readPage(op, raw) {
    const input = validatePageReadRequest(op, raw);
    try {
      contextWorkspace(input.workspaceId);
      let result;
      if (op === "sessions.list" || op === "usage.read") {
        const { sessions, runCount } = sessionMetadata(input.workspaceId);
        result =
          op === "sessions.list"
            ? {
                sessions: sessions.slice(0, 100),
                truncated: sessions.length > 100,
              }
            : {
                // Store receipts contain no billing telemetry; missing usage is never zero.
                semantics: "unavailable",
                inputTokens: null,
                outputTokens: null,
                costUsd: null,
                sessionCount: sessions.length,
                runCount,
              };
      } else {
        const memory = await memoryFor(input.workspaceId);
        const limit = op === "memory.search" ? 50 : 100;
        const rows =
          op === "memory.search"
            ? await memory.query(input.workspaceId, input.query, limit + 1)
            : memory.list(input.workspaceId, limit + 1);
        const deleted = new Set(store.audit().deletedRecordIds);
        const live = rows.filter(
          (row) =>
            ![row.observationId, row.claimArtifactId, ...row.sourceIds].some(
              (id) => deleted.has(id),
            ),
        );
        result = {
          entries: live.slice(0, limit).map((row) => ({
            observationId: row.observationId,
            sessionId: row.sessionId,
            createdAt: row.createdAt,
            sourceCount: row.sourceIds.length,
          })),
          truncated: live.length > limit,
        };
      }
      contextWorkspace(input.workspaceId);
      return validatePageReadResult(op, result);
    } catch {
      throw new PageReadError("PAGE_READ_UNAVAILABLE");
    }
  }

  return Object.freeze({
    get handshakeReadiness() {
      receipts.durableCursor();
      return Object.freeze({
        state: "ready",
        policy: true,
        store: true,
        receipts: true,
        ports: Object.freeze({
          generation: factory?.hasReadySession === true,
          provider: factory?.hasReadySession === true,
          workspace: factory?.hasWorkspaceReadySession === true,
          modules: false,
        }),
      });
    },
    current(scopeId, profileId) {
      return fence(scopeId, profileId).current();
    },
    assertCurrent(scopeId, queued, profileId) {
      fence(scopeId, profileId).assertCurrent(queued);
    },
    listWorkspaces() {
      return store.listWorkspaceViews();
    },
    admitWorkspace(input) {
      requireOpen();
      return workspaceView(
        store.admitWorkspace(input, {
          sessionId: "native-workspace-admission",
          configRevision: INITIAL_CONFIG_REVISION,
          profileRevision: INITIAL_CONFIG_REVISION,
          policyRevision: NATIVE_POLICY_REVISION,
        }),
      );
    },
    resolveWorkspace(id) {
      opaqueId(id);
      return store
        .listWorkspaces()
        .find(({ workspaceId }) => workspaceId === id);
    },
    codeIndexFor,
    codeToolsFor,
    memoryFor,
    async listModels(input, signal) {
      if (contextClosed) fail("MODEL_CATALOG_UNAVAILABLE");
      const operation = import("./native-live-catalog.mjs").then(
        ({ createLiveModelCatalog }) => {
          if (contextClosed) fail("MODEL_CATALOG_UNAVAILABLE");
          return createLiveModelCatalog({
            store,
            profiles,
            control: nativeControl,
            directory,
            providerCapability,
            currentPolicyRevision: currentNativePolicyRevision,
          })(input, signal);
        },
      );
      pendingContext.add(operation);
      try {
        return await operation;
      } finally {
        pendingContext.delete(operation);
      }
    },
    readPage,
    captureMemoryAfterTurn,
    prepareProviderSetup(...args) {
      requireOpen();
      return providerSetup.prepare(...args);
    },
    commitProviderSetup(...args) {
      requireOpen();
      return providerSetup.commit(...args);
    },
    readProviderSetup: providerSetup.read,
    readSetup(input, requestId, signal) {
      return sessions.handle("setup.read", input, requestId, signal);
    },
    selectProfile(input, requestId, signal) {
      return sessions.handle("profile.select", input, requestId, signal);
    },
    startSession(input, requestId, signal) {
      return sessions.handle("session.start", input, requestId, signal);
    },
    resumeSession(input, requestId, signal) {
      return sessions.handle("session.resume", input, requestId, signal);
    },
    setPermission(input, requestId, signal) {
      return sessions.handle("permission.set", input, requestId, signal);
    },
    readPermission(input, requestId, signal) {
      return sessions.handle("permission.read", input, requestId, signal);
    },
    preparePrompt(command, signal) {
      requireOpen();
      if (!factory?.preparePrompt) fail("NATIVE_SESSION_UNAVAILABLE");
      return factory.preparePrompt(command, signal);
    },
    cancelSession(input) {
      if (!factory?.cancel) fail("NATIVE_SESSION_UNAVAILABLE");
      return factory.cancel(input);
    },
    respondApproval(command) {
      requireOpen();
      if (!factory?.respondApproval) fail("NATIVE_SESSION_UNAVAILABLE");
      return factory.respondApproval(command);
    },
    subscribeSession(sessionId, afterSeq) {
      if (!factory?.subscribe) fail("NATIVE_SESSION_UNAVAILABLE");
      return factory.subscribe(sessionId, afterSeq);
    },
    unsubscribeSession(sessionId) {
      if (!factory?.unsubscribe) fail("NATIVE_SESSION_UNAVAILABLE");
      return factory.unsubscribe(sessionId);
    },
    drainSessionEvents(sessionId) {
      if (!factory?.drainEvents) fail("NATIVE_SESSION_UNAVAILABLE");
      return factory.drainEvents(sessionId);
    },
    onSessionEvents(listener) {
      return factory?.onEvents?.(listener) ?? (() => {});
    },
    async shutdown() {
      contextClosed = true;
      let failure;
      try {
        await sessions.close();
      } catch (error) {
        failure = error;
        if (error?.code === "SETUP_OUTCOME_UNKNOWN") {
          try {
            store.assertShellCleanup();
          } catch (fence) {
            if (fence?.code === "OWNERSHIP_CONFLICT")
              fail("SHELL_CLEANUP_UNCERTAIN");
            throw fence;
          }
        }
      }
      await Promise.allSettled([...pendingContext]);
      try {
        closeContext();
      } finally {
        store.close();
      }
      if (failure) throw failure;
    },
    close() {
      if (factory || pendingContext.size > 0)
        fail("NATIVE_ASYNC_SHUTDOWN_REQUIRED");
      try {
        closeContext();
      } finally {
        store.close();
      }
    },
  });
}
