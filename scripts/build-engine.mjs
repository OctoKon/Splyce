import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { build } from "esbuild";
import { dirname, join, relative } from "node:path";
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
const entry = join(root, "packages", "splyce-pi", "src", "engine-host.mjs");
const pins = JSON.parse(
  await readFile(join(root, "runtime-pins.json"), "utf8"),
);
const nodeVersion = (
  await readFile(join(root, ".node-version"), "utf8")
).trim();
if (
  nodeVersion !== pins.node.version ||
  pins.pi.revision !== "d5b3de22d0e24a3e9c38a9410d3329b099717283"
) {
  throw new Error(
    "The engine source pins disagree with the selected runtime inputs.",
  );
}
for (const required of [join(engineDir, "node.exe"), entry]) {
  if (!(await lstat(required).catch(() => null))?.isFile()) {
    throw new Error(
      `Required engine input is missing: ${relative(root, required)}`,
    );
  }
}

await mkdir(engineDir, { recursive: true });
await build({
  entryPoints: [entry],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  // Source aliases would duplicate Pi's private ownership maps alongside dist.
  tsconfigRaw: { compilerOptions: {} },
  banner: {
    js: 'import { createRequire as __splyceCreateRequire } from "node:module";const require = __splyceCreateRequire(import.meta.url);',
  },
  outfile: join(engineDir, "host.mjs"),
});

async function inventory(directory, parent = "") {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === "manifest.json") continue;
    const path = join(directory, entry.name);
    const relativePath = [parent, entry.name].filter(Boolean).join("/");
    if (entry.isSymbolicLink())
      throw new Error(
        `Engine resources cannot contain symlinks: ${relativePath}`,
      );
    if (entry.isDirectory())
      result.push(...(await inventory(path, relativePath)));
    else if (entry.isFile()) {
      result.push({
        path: relativePath,
        sha256: createHash("sha256")
          .update(await readFile(path))
          .digest("hex"),
      });
    } else throw new Error(`Unsupported engine resource: ${relativePath}`);
  }
  return result;
}

const files = (await inventory(engineDir)).sort((a, b) =>
  a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
);
if (
  !files.some(({ path }) => path === "node.exe") ||
  !files.some(({ path }) => path === "host.mjs")
) {
  throw new Error(
    "The engine resource inventory must contain node.exe and host.mjs.",
  );
}
const manifest = Buffer.from(
  `${JSON.stringify({ schemaVersion: 1, piRevision: pins.pi.revision, files }, null, 2)}\n`,
);
await writeFile(join(engineDir, "manifest.json"), manifest);
console.log(
  `ENGINE_MANIFEST_SHA256=${createHash("sha256").update(manifest).digest("hex")}`,
);
