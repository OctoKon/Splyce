import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import test from "node:test";
import {
  encodeFrame,
  readFrames,
} from "../packages/splyce-pi/src/engine-host.mjs";

const source = fileURLToPath(
  new URL("../packages/splyce-pi/src/engine-host.mjs", import.meta.url),
);

test("source host exposes only sessionless setup metadata and denies malformed setup", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "splyce-setup-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const frame = {
    frame: "setup",
    command: "metadata",
    requestId: "setup1",
    payload: {},
  };
  const invalid = [
    { ...frame, command: "unknown" },
    { ...frame, extra: true },
    { ...frame, sessionId: "s1" },
    { ...frame, payload: { extra: true } },
  ];
  const requests = [
    {
      id: "native-bootstrap",
      method: "native.bootstrap",
      params: { appDataDir: directory },
    },
    {
      id: "admit",
      method: "native.workspace.admit",
      params: {
        canonicalPath: "C:\\native-folder",
        volumeSerial: "1",
        fileId: "2",
      },
    },
    ...[frame, ...invalid].map((params, i) => ({
      id: `send${i}`,
      method: "send",
      params,
    })),
    { id: "shutdown", method: "shutdown", params: {} },
  ];
  const result = spawnSync(process.execPath, [source], {
    input: Buffer.concat(requests.map(encodeFrame)),
    timeout: 15000,
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr.toString());
  const replies = [];
  for await (const reply of readFrames(Readable.from([result.stdout])))
    replies.push(reply);
  assert.equal(replies[1].ok, true);
  assert.deepEqual(Object.keys(replies[1].value).sort(), [
    "admittedAt",
    "displayName",
    "revision",
    "workspaceId",
  ]);
  assert.deepEqual(replies[2].value.workspaces, [replies[1].value]);
  assert.deepEqual(Object.keys(replies[2].value).sort(), [
    "readiness",
    "workspaces",
  ]);
  assert.ok(
    Object.values(replies[2].value.readiness.ports).every(
      (value) => value === false,
    ),
  );
  for (const reply of replies.slice(3, 7))
    assert.equal(reply.error.code, "POLICY_DENIED");
  assert.equal(replies[3].error.correlationId, "setup1");
});
