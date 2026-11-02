import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Store } from "../packages/splyce-pi/dist/store.js";
import { createNativeHost } from "../packages/splyce-pi/src/native-host.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const node = join(root, "apps/desktop/src-tauri/resources/engine/node.exe");
const expected = JSON.parse(
  readFileSync(
    new URL("./fixtures/contracts/handshake.json", import.meta.url),
    "utf8",
  ),
);

function frame(value) {
  const data = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(4);
  header.writeUInt32BE(data.length);
  return Buffer.concat([header, data]);
}

function responses(bytes) {
  const result = [];
  for (let offset = 0; offset < bytes.length;) {
    assert.ok(offset + 4 <= bytes.length, "complete response header");
    const length = bytes.readUInt32BE(offset);
    assert.ok(length > 0 && length + 4 <= 262144, "bounded response");
    offset += 4;
    assert.ok(offset + length <= bytes.length, "complete response payload");
    result.push(
      JSON.parse(bytes.subarray(offset, offset + length).toString("utf8")),
    );
    offset += length;
  }
  return result;
}

const ready = {
  ...expected,
  readiness: {
    ...expected.readiness,
    state: "ready",
    policy: true,
    store: true,
    receipts: true,
  },
};
const bootstrap = (appDataDir) => ({
  id: "native-bootstrap",
  method: "native.bootstrap",
  params: { appDataDir },
});

for (const [name, path, runtime] of [
  [
    "loaded SDK source host",
    "packages/splyce-pi/src/engine-host.mjs",
    process.execPath,
  ],
  [
    "packaged engine host",
    "apps/desktop/src-tauri/resources/engine/host.mjs",
    node,
  ],
]) {
  test(`${name}: trusted Store bootstrap stays closed to runnable effects`, () => {
    const fixture = mkdtempSync(join(tmpdir(), "splyce-native-host-"));
    const appDataDir = join(fixture, "native-data");
    try {
      const version = spawnSync(runtime, ["--version"], { encoding: "utf8" });
      assert.equal(version.error, undefined);
      assert.equal(version.stdout.trim(), "v24.22.1");
      const result = spawnSync(runtime, [join(root, path)], {
        cwd: fixture,
        env: {
          ...(process.env.SystemRoot
            ? { SystemRoot: process.env.SystemRoot }
            : {}),
          HOME: fixture,
          USERPROFILE: fixture,
          TEMP: fixture,
          TMP: fixture,
          PI_CODING_AGENT_DIR: fixture,
        },
        input: Buffer.concat([
          frame(bootstrap(appDataDir)),
          frame({
            id: "check-1",
            method: "handshake",
            params: { protocolVersion: 2 },
          }),
          frame({
            id: "check-2",
            method: "send",
            params: {
              op: "session.start",
              payload: { initialPrompt: "do not execute" },
            },
          }),
          frame({ id: "check-3", method: "shutdown", params: {} }),
        ]),
        timeout: 15000,
        maxBuffer: 1048576,
        windowsHide: true,
      });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0, result.stderr?.toString());
      assert.equal(result.stderr.length, 0);
      const replies = responses(result.stdout);
      assert.equal(replies.length, 4);
      assert.deepEqual(replies[0], {
        id: "native-bootstrap",
        ok: true,
        value: { state: "initialized" },
      });
      assert.deepEqual(replies[1], {
        id: "check-1",
        ok: true,
        value: ready,
      });
      assert.equal(replies[2].id, "check-2");
      assert.equal(replies[2].ok, false);
      assert.equal(replies[2].error.code, "POLICY_DENIED");
      assert.equal(replies[2].error.retryable, false);
      assert.deepEqual(replies[3], {
        id: "check-3",
        ok: true,
        value: { state: "stopped" },
      });
      assert.deepEqual(
        readdirSync(fixture),
        ["native-data"],
        "ambient paths must not create session/resources",
      );
      const store = Store.open(join(appDataDir, "splyce", "store.db"));
      try {
        assert.equal(
          store.cursor(),
          0,
          "bootstrap must not invent authority or sessions",
        );
        assert.deepEqual(store.audit().scopeIds, []);
      } finally {
        store.close();
      }
    } finally {
      rmSync(fixture, { recursive: true });
    }
  });

  for (const [route, requests] of [
    [
      "renderer path before bootstrap",
      (nativePath, otherPath) => [
        {
          id: "renderer",
          method: "handshake",
          params: { protocolVersion: 2, appDataDir: otherPath },
        },
      ],
    ],
    ["relative native path", () => [bootstrap("relative-data")]],
    [
      "duplicate native bootstrap",
      (nativePath, otherPath) => [bootstrap(nativePath), bootstrap(otherPath)],
    ],
  ]) {
    test(`${name}: ${route} cannot select a new Store`, () => {
      const fixture = mkdtempSync(join(tmpdir(), "splyce-native-provenance-"));
      try {
        const result = spawnSync(runtime, [join(root, path)], {
          cwd: fixture,
          input: Buffer.concat(
            requests(
              join(fixture, "native-data"),
              join(fixture, "renderer-data"),
            ).map(frame),
          ),
          timeout: 15000,
          windowsHide: true,
        });
        assert.equal(result.error, undefined);
        assert.equal(result.status, 1);
        assert.equal(result.stderr.toString(), "Engine bootstrap failed\n");
        assert.deepEqual(
          readdirSync(fixture),
          route === "duplicate native bootstrap" ? ["native-data"] : [],
        );
      } finally {
        rmSync(fixture, { recursive: true });
      }
    });
  }
}

test("loaded SDK source host: deleted applied config denies without stopping host", () => {
  const fixture = mkdtempSync(join(tmpdir(), "splyce-native-denial-"));
  const appDataDir = join(fixture, "native-data");
  try {
    const host = createNativeHost(appDataDir);
    host.close();
    const storePath = join(appDataDir, "splyce", "store.db");
    const store = Store.open(storePath);
    const records = JSON.parse(
      readFileSync(
        new URL("./fixtures/contracts/records.json", import.meta.url),
        "utf8",
      ),
    );
    store.append(
      {
        kind: "configurationTransition",
        record: {
          ...records.configurationTransition,
          expectedConfigRevision: "cfg-0",
        },
      },
      {
        sessionId: "s1",
        configRevision: "cfg-0",
        profileRevision: "cfg-0",
        policyRevision: "cfg-0",
        resolveReference: () => true,
      },
    );
    store.noteDeletion("rec-config");
    const before = store.audit();
    store.close();
    const result = spawnSync(
      process.execPath,
      [join(root, "packages/splyce-pi/src/engine-host.mjs")],
      {
        input: Buffer.concat([
          frame(bootstrap(appDataDir)),
          frame({
            id: "send",
            method: "send",
            params: {
              scopeId: "w-demo",
              expectedConfigRevision: "cfg2",
              expectedProfileRevision: "cfg-0",
              expectedPolicyRevision: "cfg-0",
            },
          }),
          frame({
            id: "handshake",
            method: "handshake",
            params: { protocolVersion: 2 },
          }),
          frame({ id: "shutdown", method: "shutdown", params: {} }),
        ]),
        timeout: 15000,
        windowsHide: true,
      },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr.toString());
    assert.equal(result.stderr.length, 0);
    const replies = responses(result.stdout);
    assert.equal(replies.length, 4);
    assert.equal(replies[1].error.code, "POLICY_DENIED");
    assert.equal(replies[1].error.retryable, false);
    assert.deepEqual(replies[2], { id: "handshake", ok: true, value: ready });
    assert.deepEqual(replies[3], {
      id: "shutdown",
      ok: true,
      value: { state: "stopped" },
    });
    const reopened = Store.open(storePath);
    try {
      assert.deepEqual(reopened.audit(), before);
      assert.equal(reopened.deletionEpoch(), 1);
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
