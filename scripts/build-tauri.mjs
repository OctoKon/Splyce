import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const engineDir = join(
  root,
  "apps",
  "desktop",
  "src-tauri",
  "resources",
  "engine",
);
const manifestBytes = await readFile(join(engineDir, "manifest.json"));
const manifest = JSON.parse(manifestBytes);
if (
  manifest.schemaVersion !== 1 ||
  manifest.piRevision !== "d5b3de22d0e24a3e9c38a9410d3329b099717283" ||
  !Array.isArray(manifest.files)
) {
  throw new Error(
    "The engine resource manifest has an unsupported schema or Pi revision.",
  );
}
const seen = new Set();
for (const file of manifest.files) {
  if (
    typeof file.path !== "string" ||
    !/^[0-9a-f]{64}$/.test(file.sha256) ||
    file.path
      .split("/")
      .some(
        (part) => !part || part === "." || part === ".." || part.includes("\\"),
      )
  ) {
    throw new Error(`Invalid engine manifest entry: ${JSON.stringify(file)}`);
  }
  const path = resolve(engineDir, file.path);
  const relativePath = relative(engineDir, path);
  if (
    isAbsolute(relativePath) ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    seen.has(file.path)
  ) {
    throw new Error(`Unsafe or duplicate engine manifest path: ${file.path}`);
  }
  seen.add(file.path);
  if (!(await lstat(path).catch(() => null))?.isFile())
    throw new Error(`Missing engine resource: ${file.path}`);
  const digest = createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
  if (digest !== file.sha256)
    throw new Error(`Engine resource digest mismatch: ${file.path}`);
}

const require = createRequire(import.meta.url);
const cli = require.resolve("@tauri-apps/cli/tauri.js");
const result = spawnSync(
  process.execPath,
  [cli, "build", ...process.argv.slice(2)],
  {
    cwd: join(root, "apps", "desktop"),
    env: {
      ...process.env,
      SPLYCE_ENGINE_MANIFEST_SHA256: createHash("sha256")
        .update(manifestBytes)
        .digest("hex"),
    },
    stdio: "inherit",
  },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
