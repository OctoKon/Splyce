// Actual SQLite producer joined to the unmodified GUI consumer at its recorded
// commit. This contract fixture does not qualify the current/installed renderer.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import test from "node:test";
import { ConfigAuthority } from "../packages/splyce-pi/dist/config.js";
import { Store } from "../packages/splyce-pi/dist/store.js";
import { createNativeHost } from "../packages/splyce-pi/src/native-host.mjs";
import { createNativeProviderSetup } from "../packages/splyce-pi/src/native-provider-setup.mjs";
import { configuredProfileResult as currentConfiguredProfileResult } from "../apps/desktop/src/stores/profiles.ts";
import {
  configuredProfileResult,
  profileSelectPayload,
  validateProfileSelectionResult,
} from "./fixtures/native-provider-view/gui-profiles.ts";

const provenance = JSON.parse(
  readFileSync(
    new URL("./fixtures/native-provider-view/provenance.json", import.meta.url),
    "utf8",
  ),
);
assert.equal(provenance.commit, "2c997666d83b65b2bc33ce66df7ac2e21dbd87ef");
assert.equal(
  createHash("sha256")
    .update(
      readFileSync(
        new URL(
          "./fixtures/native-provider-view/gui-profiles.ts",
          import.meta.url,
        ),
      ),
    )
    .digest("hex"),
  provenance.excerptSha256,
);

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "splyce-provider-view-"));
  const workspacePath = join(directory, "workspace");
  mkdirSync(workspacePath);
  const host = createNativeHost(directory);
  const store = Store.open(join(directory, "splyce", "store.db"));
  t.after(() => {
    host.close();
    store.close();
    const actual = resolve(directory);
    assert.equal(
      dirname(actual).toLowerCase(),
      resolve(tmpdir()).toLowerCase(),
    );
    assert.ok(basename(actual).startsWith("splyce-provider-view-"));
    rmSync(actual, { recursive: true, force: true });
  });
  const workspace = host.admitWorkspace({
    canonicalPath: workspacePath,
    volumeSerial: "1",
    fileId: "2",
  });
  const metadata = {
    requestId: "view-request",
    workspaceId: workspace.workspaceId,
    providerConnectionId: "view-connection",
    profileId: "view-profile",
    apiFamily: "openai-completions",
    endpoint: "https://example.test/v1",
    locality: "hosted",
    chat: {
      modelId: "custom/model",
      model: {
        contextWindow: 8192,
        maxOutputTokens: 1024,
        reasoning: false,
        input: ["text"],
      },
    },
    accountScopeRef: "provider-default",
    expectedConnectionRevision: null,
    expectedProfileRevision: null,
    expectedEndpointRevision: null,
    credentialKind: "new",
  };
  const setup = createNativeProviderSetup(store, join(directory, "splyce"));
  const prepared = setup.prepare(metadata);
  assert.equal(prepared.state, "prepared");
  const input = { metadata, credentialRef: prepared.credentialRef };
  const caller = {
    sessionId: "view-fixture",
    configRevision: "cfg-0",
    profileRevision: "cfg-0",
    policyRevision: "cfg-0",
    resolveReference: () => true,
  };
  const advance = () =>
    new ConfigAuthority(store).apply(
      {
        scopeId: metadata.workspaceId,
        transitionId: "view-transition",
        expectedConfigRevision: "cfg-0",
        acceptedConfigRevision: "cfg-after-setup",
        intentRef: "view-intent",
        changedValuesArtifactId: "view-changes",
      },
      caller,
    );
  return { host, store, setup, metadata, input, caller, advance };
}

for (const route of ["commit", "read", "prepare-replay"]) {
  test(`real provider ${route} view passes the exact GUI consumer and selection caller`, (t) => {
    const f = fixture(t);
    const committed = f.setup.commit(f.input);
    assert.equal(committed.state, "committed");
    const response =
      route === "commit"
        ? committed
        : route === "read"
          ? f.setup.read(f.input)
          : f.setup.prepare(f.metadata);
    const parsed = configuredProfileResult(response.view);
    assert.deepEqual(currentConfiguredProfileResult(response.view), parsed);
    assert.equal(
      parsed.configRevision,
      f.store.configRevision(f.metadata.workspaceId),
    );
    const payload = profileSelectPayload(
      parsed,
      f.metadata.workspaceId,
      `select-${route}`,
    );
    const proof = f.store.prepareNativeSessionSetup("profile.select", payload);
    const selected = f.store.commitNativeProfileSelection(proof, f.caller);
    const publicSelection = validateProfileSelectionResult(selected.result);
    assert.equal(publicSelection.selectedProfileId, parsed.profileId);
    assert.equal(publicSelection.profileRevision, parsed.profileRevision);
    assert.equal(
      publicSelection.configRevision,
      f.store.configRevision(f.metadata.workspaceId),
    );
  });
  test(`real provider ${route} uses current config after a prior setup instead of its profile snapshot`, (t) => {
    const f = fixture(t);
    const committed = f.setup.commit(f.input);
    f.advance();
    assert.equal(committed.view.configRevision, "cfg-0");
    const before = f.store.cursor();
    const response =
      route === "commit"
        ? f.setup.commit(f.input)
        : route === "read"
          ? f.setup.read(f.input)
          : f.setup.prepare(f.metadata);
    const parsed = configuredProfileResult(response.view);
    assert.deepEqual(currentConfiguredProfileResult(response.view), parsed);
    assert.equal(parsed.configRevision, "cfg-after-setup");
    assert.equal(f.store.cursor(), before, "replay/read must not write");
    assert.equal(
      f.store
        .readSetupState(f.metadata.workspaceId)
        .records.find(({ kind }) => kind === "profileSnapshot").record
        .configRevision,
      "cfg-0",
    );
    assert.equal(
      f.store.readSetupState(f.metadata.workspaceId).configRevision,
      "cfg-after-setup",
    );
    const selection = f.store.prepareNativeSessionSetup(
      "profile.select",
      profileSelectPayload(
        parsed,
        f.metadata.workspaceId,
        `select-current-${route}`,
      ),
    );
    assert.equal(
      validateProfileSelectionResult(
        f.store.commitNativeProfileSelection(selection, {
          ...f.caller,
          configRevision: parsed.configRevision,
        }).result,
      ).selectedProfileId,
      parsed.profileId,
    );
  });
}

test("a superseded workspace cannot expose a historical ready-to-select provider view", (t) => {
  const f = fixture(t);
  f.setup.commit(f.input);
  const admitted = f.store.readSetupState(f.metadata.workspaceId).workspace;
  f.store.admitWorkspace(
    { canonicalPath: admitted.canonicalPath, volumeSerial: "1", fileId: "3" },
    f.caller,
    { readmit: true },
  );
  const before = f.store.cursor();
  for (const call of [
    () => f.setup.commit(f.input),
    () => f.setup.read(f.input),
    () => f.setup.prepare(f.metadata),
  ]) {
    assert.throws(
      call,
      (error) =>
        error.code === "SETUP_WORKSPACE_UNAVAILABLE" &&
        error.message === "Provider setup unavailable",
    );
    assert.equal(f.store.cursor(), before);
  }
});
