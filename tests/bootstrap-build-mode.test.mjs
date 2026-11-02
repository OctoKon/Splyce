import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const readJson = async (path) =>
  JSON.parse(await readFile(resolve(root, path), "utf8"));

test(
  "built engine keeps native persistence ownership through session.start",
  { timeout: 60_000 },
  async (t) => {
    execFileSync(process.execPath, ["scripts/build-engine.mjs"], {
      cwd: root,
      windowsHide: true,
      stdio: "pipe",
    });
    const { encodeFrame, readFrames } =
      await import("../packages/splyce-pi/src/engine-host.mjs");
    const directory = mkdtempSync(join(tmpdir(), "splyce-bundle-owner-"));
    const project = join(directory, "project");
    mkdirSync(project);
    const stat = lstatSync(project, { bigint: true });
    const child = spawn(
      process.execPath,
      [resolve(root, "apps/desktop/src-tauri/resources/engine/host.mjs")],
      {
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 30_000,
      },
    );
    const closed = once(child, "close");
    t.after(async () => {
      if (child.exitCode === null) child.kill();
      await closed;
      rmSync(directory, { recursive: true, force: true });
    });
    let stderr = "";
    child.stderr.on("data", (data) => {
      stderr += data;
    });
    let id = 0;
    const write = (method, params, requestId = `build-${++id}`) =>
      child.stdin.write(encodeFrame({ id: requestId, method, params }));
    const replies = readFrames(child.stdout)[Symbol.asyncIterator]();
    const rpc = async (method, params, requestId) => {
      write(method, params, requestId);
      for (;;) {
        const { value: frame, done } = await replies.next();
        assert.equal(done, false, stderr);
        if (frame.native) {
          const call = frame.native;
          assert.ok(
            ["credential.status", "credential.redact"].includes(call.method),
          );
          child.stdin.write(
            encodeFrame({
              native: {
                id: call.id,
                ok: true,
                value:
                  call.method === "credential.status"
                    ? { present: true }
                    : { text: call.params.text, redactedCount: 0 },
              },
            }),
          );
          continue;
        }
        assert.equal(frame.ok, true, JSON.stringify(frame));
        return frame.value;
      }
    };
    await rpc(
      "native.bootstrap",
      { appDataDir: directory },
      "native-bootstrap",
    );
    const workspace = await rpc("native.workspace.admit", {
      canonicalPath: realpathSync.native(project),
      volumeSerial: String(stat.dev),
      fileId: String(stat.ino),
    });
    const metadata = {
      requestId: "build-provider",
      workspaceId: workspace.workspaceId,
      providerConnectionId: "build-provider",
      profileId: "build-profile",
      apiFamily: "openai-completions",
      endpoint: "https://example.test/v1",
      locality: "hosted",
      chat: {
        modelId: "fixture-model",
        model: { contextWindow: 8192, maxOutputTokens: 1024 },
      },
      accountScopeRef: "provider-default",
      credentialKind: "new",
      expectedConnectionRevision: null,
      expectedProfileRevision: null,
      expectedEndpointRevision: null,
    };
    const { credentialRef } = await rpc("native.provider.prepare", metadata);
    await rpc("native.provider.commit", { metadata, credentialRef });
    const { view } = await rpc("native.provider.read", {
      metadata,
      credentialRef,
    });
    const setup = (command, payload) =>
      rpc("send", {
        frame: "setup",
        command,
        requestId: payload.requestId,
        payload,
      });
    const selected = await setup("profile.select", {
      requestId: "build-select",
      workspaceId: workspace.workspaceId,
      profileId: view.profileId,
      expectedProfileRevision: view.profileRevision,
      expectedConfigRevision: view.configRevision,
    });
    const started = await setup("session.start", {
      requestId: "build-start",
      workspaceId: workspace.workspaceId,
      profileId: view.profileId,
      expectedConfigRevision: selected.configRevision,
    });
    assert.deepEqual(started.readiness, { state: "ready" });
    await rpc("shutdown", {});
    assert.equal((await closed)[0], 0, stderr);
  },
);

test("embedded WebDriver is absent from the release build and capability", async () => {
  const manifest = "apps/desktop/src-tauri/Cargo.toml";
  const cargo = process.platform === "win32" ? "cargo.exe" : "cargo";
  const graph = (features = []) =>
    execFileSync(
      cargo,
      [
        "tree",
        "--locked",
        "--manifest-path",
        manifest,
        "--edges",
        "features",
        ...features,
      ],
      { cwd: root, encoding: "utf8", timeout: 120000 },
    );

  assert.doesNotMatch(graph(), /tauri-plugin-wdio-webdriver/);
  assert.match(graph(["--features", "e2e"]), /tauri-plugin-wdio-webdriver/);

  const release = await readJson("apps/desktop/src-tauri/tauri.conf.json");
  const e2e = await readJson("apps/desktop/src-tauri/tauri.e2e.conf.json");
  const e2eCapability = await readJson(
    "apps/desktop/src-tauri/capabilities/e2e.json",
  );
  assert.deepEqual(release.app.security.capabilities, ["main"]);
  assert.deepEqual(e2e.app.security.capabilities, ["main", "e2e"]);
  assert.equal(e2e.bundle.active, false);
  assert.deepEqual(e2eCapability.permissions, ["wdio-webdriver:default"]);
});

test("embedded WebDriver tool pins match their lockfiles", async () => {
  const inventory = await readJson(
    "apps/desktop/embedded-e2e-tool-inventory.json",
  );
  const packageJson = await readJson("package.json");
  const packageLock = await readJson("package-lock.json");
  const runtimePins = await readJson("runtime-pins.json");
  for (const tool of inventory.packages.filter(
    (item) => item.name !== "tauri-plugin-wdio-webdriver",
  )) {
    const locked = packageLock.packages[`node_modules/${tool.name}`];
    assert.equal(locked?.version, tool.version, `${tool.name} version`);
    assert.equal(locked?.license, tool.license, `${tool.name} license`);
    if (!tool.via) {
      assert.equal(
        packageJson.devDependencies[tool.name],
        tool.packageSpec ?? tool.version,
      );
      if (tool.packageSpec) {
        assert.equal(tool.name, "mocha");
        assert.equal(tool.packageSpec, "file:patches/mocha/mocha-10.8.2.tgz");
        assert.equal(locked.resolved, tool.packageSpec);
        assert.equal(locked.integrity, tool.integrity);
        const archive = await readFile(
          resolve(root, "patches/mocha/mocha-10.8.2.tgz"),
        );
        assert.equal(
          `sha512-${createHash("sha512").update(archive).digest("base64")}`,
          tool.integrity,
        );
      }
    }
  }
  const cargoLock = await readFile(
    resolve(root, "apps/desktop/src-tauri/Cargo.lock"),
    "utf8",
  );
  const crate = cargoLock
    .split("[[package]]")
    .find((entry) => entry.includes('name = "tauri-plugin-wdio-webdriver"'));
  assert.match(crate, /version = "1\.5\.1"/);
  assert.match(
    crate,
    /checksum = "5a775b0b59f6f12b38d1f28667311a89cd07f532f540e27d65c6eadfba1156d8"/,
  );
  const lockedPackages = new Set(
    [...cargoLock.matchAll(/name = "([^"]+)"\nversion = "([^"]+)"/g)].map(
      ([, name, version]) => `${name}@${version}`,
    ),
  );
  assert(inventory.cargoPackages.length > 0);
  for (const tool of inventory.cargoPackages) {
    assert(tool.license, `${tool.name} license`);
    assert(tool.repository, `${tool.name} source repository`);
    assert(lockedPackages.has(`${tool.name}@${tool.version}`));
  }
  assert.equal(inventory.runtime.node, runtimePins.node.version);
  assert.equal(inventory.runtime.npm, runtimePins.node.npm);
  assert.equal(inventory.runtime.rust, runtimePins.rust.toolchain);
});
