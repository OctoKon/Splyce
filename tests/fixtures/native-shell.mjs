// This Cargo test target exposes the same private registry used by the engine reader.
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { NativeControl } from "../../packages/splyce-pi/src/native-control.mjs";
let binary;
export function shellFixturePath() {
  if (binary) return binary;
  const manifest = fileURLToPath(
    new URL("../../apps/desktop/src-tauri/Cargo.toml", import.meta.url),
  );
  const build = spawnSync(
    "cargo",
    [
      "test",
      "--manifest-path",
      manifest,
      "--no-run",
      "--test",
      "shell_control_fixture",
      "--message-format=json",
    ],
    { windowsHide: true, encoding: "utf8", maxBuffer: 32 << 20 },
  );
  if (build.error || build.status !== 0)
    throw new Error(build.error?.message ?? build.stderr + build.stdout);
  return (binary = build.stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .findLast(
      (row) => row.target?.name === "shell_control_fixture" && row.executable,
    )?.executable);
}
export function shellPeer(accept, onClose, { path, onFrame } = {}) {
  const exe =
    process.platform === "win32" ? (path ?? shellFixturePath()) : undefined;
  let child, ended;
  return {
    send(frame, maySend) {
      if (maySend && !maySend()) return;
      if (!child) {
        child = spawn(exe, ["--serve"], {
          stdio: ["pipe", "pipe", "inherit"],
          windowsHide: true,
        });
        ended = new Promise((resolve) => child.once("close", resolve));
        createInterface({ input: child.stdout }).on("line", (line) =>
          accept(JSON.parse(line)),
        );
        child.once("exit", onClose);
        child.once("error", onClose);
        child.stdin.on("error", onClose);
      }
      onFrame?.(frame);
      return new Promise((resolve, reject) =>
        child.stdin.write(JSON.stringify(frame) + "\n", (e) =>
          e ? reject(e) : resolve(),
        ),
      );
    },
    close() {
      child?.stdin.end();
      return ended;
    },
  };
}
export function nativeShellFixture(options = {}) {
  const peer = shellPeer(
    (frame) => control.accept(frame),
    () => control.shutdown(),
    options,
  );
  const control = new NativeControl(peer.send);
  return {
    execute: (...args) => control.shell(...args),
    close: () => {
      control.shutdown();
      return peer.close();
    },
  };
}
