import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

// TD-09/TD-15/TD-51 integration runner. One file per named case so a case
// can never pass with zero matched tests: J0_store_contract runs the whole
// store suite (all assertions, no name filtering); C1_reconnect_cursor runs
// the receipts suite; C3_crash_matrix runs the crash/migration matrix; the
// C5_dirty_snapshot case runs the stale-verification snapshot suite. Root npm
// wiring is TD-11's (serial handoff per itachi).

const args = process.argv.slice(2);
let files;
if (args.length === 0) {
  files = [
    "tests/integration/store.ts",
    "tests/integration/receipts.ts",
    "tests/integration/bridge.ts",
    "tests/integration/config.ts",
    "tests/integration/crash-matrix.ts",
    "tests/integration/snapshots.ts",
    "tests/integration/credentials.ts",
  ];
} else if (args.length === 2 && args[0] === "--case") {
  if (args[1] === "J0_store_contract") files = ["tests/integration/store.ts"];
  else if (args[1] === "C1_reconnect_cursor")
    files = ["tests/integration/receipts.ts"];
  else if (args[1] === "C2_desktop_bridge")
    files = ["tests/integration/bridge.ts"];
  else if (args[1] === "C3_crash_matrix")
    files = ["tests/integration/crash-matrix.ts"];
  else if (args[1] === "C4_config_transition")
    files = ["tests/integration/config.ts"];
  else if (args[1] === "C4_credential_resolution")
    files = ["tests/integration/credentials.ts"];
  else if (args[1] === "C5_dirty_snapshot")
    files = ["tests/integration/snapshots.ts"];
  else {
    console.error(`unknown case ${args[1]}`);
    process.exit(2);
  }
} else {
  console.error(
    "Usage: node scripts/run-store.mjs [--case J0_store_contract | --case C1_reconnect_cursor | --case C2_desktop_bridge | --case C3_crash_matrix | --case C4_config_transition | --case C4_credential_resolution | --case C5_dirty_snapshot]",
  );
  process.exit(2);
}

const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);
for (const command of [
  [
    require.resolve("typescript/bin/tsc"),
    "-p",
    "packages/splyce-pi/tsconfig.json",
  ],
  ["--test", "--test-timeout=120000", ...files],
]) {
  const result = spawnSync(process.execPath, command, {
    cwd: root,
    stdio: "inherit",
  });
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}
