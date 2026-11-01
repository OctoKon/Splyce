"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const mocha = path.resolve(process.argv[2]);
const collect = require(path.join(mocha, "lib/cli/collect-files"));
assert.equal(
  typeof require(path.join(mocha, "lib/cli/run-helpers")).handleRequires,
  "function",
);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mocha-collect-"));
try {
  fs.mkdirSync(path.join(dir, "nested"));
  for (const name of ["keep.js", "skip.js", "nested/keep.js"])
    fs.writeFileSync(path.join(dir, name), "");
  const opts = {
    ignore: [],
    extension: ["js"],
    file: [],
    recursive: true,
    sort: true,
    spec: [dir],
  };
  const all = collect(opts).files;
  assert.equal(all.length, 3);
  const ignored = collect({ ...opts, ignore: ["**/skip.js"] }).files;
  assert.equal(ignored.length, 2);
  assert(!ignored.some((f) => f.endsWith("skip.js")));
  const windowsPattern = "**\\nested\\*.js";
  const winIgnored = collect({ ...opts, ignore: [windowsPattern] }).files;
  assert.equal(winIgnored.length, 2);
  assert(!winIgnored.includes(path.join(dir, "nested", "keep.js")));
  console.log("collection and handleRequires passed");
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
