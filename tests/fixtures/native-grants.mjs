// TD-13 fixture support: real admitted workspaces and Store-minted grants for
// NativePolicy tests (no fake allow), plus an in-memory WorkspaceIdentityPort.

export const IDENTITY = Object.freeze({
  volumeSerial: "2712847316",
  fileId: "281474976713404",
});

/** In-memory native identity source; `observe` returns the current identity on every call. */
export class MemoryWorkspaceIdentity {
  #identities = new Map();
  set(workspaceId, identity) {
    this.#identities.set(workspaceId, { ...identity });
  }
  observe(workspaceId) {
    const identity = this.#identities.get(workspaceId);
    if (identity === undefined) throw new Error("WORKSPACE_UNOBSERVED");
    return { ...identity };
  }
}

/**
 * Binds the Pi session, admits a workspace and mints one once grant for the
 * permit's action. `refs` (the fixture's resolvable reference set) learns the
 * new workspace and grant IDs. Returns the run record to append.
 */
export function admitAndGrant(
  store,
  caller,
  refs,
  records,
  { actionId, argumentsDigest, capability = "fs.write" },
) {
  const workspace = store.admitWorkspace(
    { canonicalPath: "C:\\Users\\dev\\splyce-fixture", ...IDENTITY },
    caller,
  );
  refs.add(workspace.workspaceId);
  // The Pi-derived session record, kept out of the run's scope so fixture
  // scope histories stay unchanged.
  store.append(
    {
      kind: "branchAnchor",
      record: {
        ...records.branchAnchor,
        scopeId: workspace.workspaceId,
        piSessionId: caller.sessionId,
        parentAnchorId: null,
        forkPointEntryId: null,
        activeLeafEntryId: null,
      },
    },
    caller,
  );
  const identity = new MemoryWorkspaceIdentity();
  identity.set(workspace.workspaceId, IDENTITY);
  const mint = (grantActionId, digest = argumentsDigest, cap = capability) => {
    const grant = store.mintGrant(
      {
        workspaceId: workspace.workspaceId,
        sessionId: caller.sessionId,
        capability: cap,
        scope: "once",
        actionId: grantActionId,
        argumentsDigest: digest,
      },
      caller,
    );
    refs.add(grant.grantId);
    return grant.grantId;
  };
  const grantId = mint(actionId);
  return {
    workspaceId: workspace.workspaceId,
    grantId,
    identity,
    mint,
    run: {
      ...records.run,
      workspaceId: workspace.workspaceId,
      grantIds: [grantId],
    },
  };
}
