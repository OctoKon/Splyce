import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
if (
  args.length &&
  (args.length !== 2 || args[0] !== "--case" || args[1] !== "TD-01")
) {
  console.error("Usage: npm run test:contracts -- [--case TD-01]");
  process.exit(2);
}

const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);
const tsc = join(dirname(dirname(require.resolve("typescript"))), "bin", "tsc");
for (const command of [
  [tsc, "-p", "packages/splyce-pi/tsconfig.json"],
  [
    tsc,
    "--noEmit",
    "--strict",
    "--target",
    "ES2024",
    "--module",
    "NodeNext",
    "tests/provider-admission.types.ts",
  ],
  ["--test", "tests/contracts.test.mjs"],
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
