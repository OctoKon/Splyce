import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
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
    "tests/integration/provider-profiles.ts",
    "tests/integration/provider-profile-cas.ts",
    "tests/integration/crash-matrix.ts",
    "tests/integration/snapshots.ts",
    "tests/integration/events.ts",
    "tests/integration/credentials.ts",
    "tests/integration/grants.ts",
    "tests/integration/policy-grants.ts",
  ];
} else if (args.length === 2 && args[0] === "--case") {
  if (args[1] === "J0_store_contract") files = ["tests/integration/store.ts"];
  else if (args[1] === "C1_reconnect_cursor")
    files = ["tests/integration/receipts.ts"];
  // Needs the built Pi SessionManager (build:pi), so it is a named case only.
  else if (args[1] === "C1_session_catalog")
    files = ["tests/integration/session-map.ts"];
  else if (args[1] === "C2_desktop_bridge")
    files = ["tests/integration/bridge.ts"];
  else if (args[1] === "C3_crash_matrix")
    files = ["tests/integration/crash-matrix.ts"];
  else if (args[1] === "C4_config_transition")
    files = [
      "tests/integration/config.ts",
      "tests/integration/provider-profiles.ts",
      "tests/integration/provider-profile-cas.ts",
    ];
  else if (args[1] === "C5_dirty_snapshot")
    files = ["tests/integration/snapshots.ts"];
  else if (args[1] === "C6_event_ledger")
    files = ["tests/integration/events.ts"];
  else if (args[1] === "C4_credential_resolution")
    files = ["tests/integration/credentials.ts"];
  else if (args[1] === "C2_grants_store")
    files = ["tests/integration/grants.ts"];
  else if (args[1] === "C2_policy_grants")
    files = ["tests/integration/policy-grants.ts"];
  else {
    console.error(`unknown case ${args[1]}`);
    process.exit(2);
  }
} else {
  console.error(
    "Usage: node scripts/run-store.mjs [--case J0_store_contract | --case C1_reconnect_cursor | --case C1_session_catalog | --case C2_desktop_bridge | --case C3_crash_matrix | --case C4_config_transition | --case C4_credential_resolution | --case C2_grants_store | --case C2_policy_grants | --case C5_dirty_snapshot | --case C6_event_ledger]",
  );
  process.exit(2);
}

const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);
const tsc = join(dirname(dirname(require.resolve("typescript"))), "bin", "tsc");
for (const command of [
  [tsc, "-p", "packages/splyce-pi/tsconfig.json"],
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
