import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import { TRANSPORT_LIMITS } from "@splyce/pi/contracts";
import {
  encodeFrame,
  readFrames,
  FrameError,
  MAX_FRAME_BYTES,
  isRequest,
} from "../packages/splyce-pi/src/engine-host.mjs";

const decode = async (chunks) =>
  Array.fromAsync(readFrames(Readable.from(chunks)));

test("transport request identity is bounded independently of payload size", () => {
  const valid = {
    id: "native-1",
    method: "handshake",
    params: { protocolVersion: 2 },
  };
  assert.equal(isRequest(valid), true);
  assert.equal(isRequest({ ...valid, id: "a".repeat(129) }), false);
  assert.equal(isRequest({ ...valid, id: "λ".repeat(65) }), false);
  assert.equal(isRequest({ ...valid, id: "a".repeat(150000) }), false);
  assert.equal(isRequest({ ...valid, extra: true }), false);
  assert.equal(isRequest({ ...valid, params: [] }), false);
});

test("native engine frames survive fragmented Unicode and adjacent messages", async () => {
  const values = [
    { id: "one", text: "λ\n日本語" },
    { id: "two", ok: false },
  ];
  const bytes = Buffer.concat(values.map(encodeFrame));
  assert.deepEqual(
    await decode([...bytes].map((byte) => Buffer.from([byte]))),
    values,
  );
  assert.deepEqual(await decode([bytes]), values);
});

test("native frame limit includes header and rejects before oversized payload allocation", async () => {
  assert.equal(MAX_FRAME_BYTES, TRANSPORT_LIMITS.maxEncodedFrameBytes);
  assert.equal(MAX_FRAME_BYTES, 262144);
  const value = "x".repeat(MAX_FRAME_BYTES - 6);
  const frame = encodeFrame(value);
  assert.equal(frame.length, MAX_FRAME_BYTES);
  assert.equal(frame.readUInt32BE(), MAX_FRAME_BYTES - 4);
  assert.deepEqual(await decode([encodeFrame(value)]), [value]);
  assert.throws(() => encodeFrame(value + "x"), FrameError);
  for (const length of [0, MAX_FRAME_BYTES - 3, 0xffffffff]) {
    const header = Buffer.alloc(4);
    header.writeUInt32BE(length);
    await assert.rejects(decode([header]), FrameError);
  }
});

test("partial frame, invalid UTF8 and malformed JSON cannot become messages", async () => {
  const complete = encodeFrame({ id: "one" });
  for (const bytes of [
    complete.subarray(0, 2),
    complete.subarray(0, -1),
    Buffer.from([0, 0, 0, 1, 0xff]),
    Buffer.from([0, 0, 0, 1, 0x7b]),
  ])
    await assert.rejects(decode([bytes]), FrameError);
  assert.deepEqual(await decode([]), []);
  assert.deepEqual(await decode([complete]), [{ id: "one" }]);
});
