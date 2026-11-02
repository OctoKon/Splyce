import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const appDir = dirname(fileURLToPath(import.meta.url));
const appBinaryPath = resolve(
  appDir,
  "src-tauri/target/release/splyce-desktop.exe",
);

export const config = {
  runner: "local",
  specs: [resolve(appDir, "../../tests/bootstrap/embedded/**/*.spec.mjs")],
  maxInstances: 1,
  capabilities: [
    {
      browserName: "tauri",
      "tauri:options": { application: appBinaryPath },
    },
  ],
  services: [
    [
      "@wdio/tauri-service",
      { appBinaryPath, driverProvider: "embedded", embeddedPort: 4445 },
    ],
  ],
  framework: "mocha",
  reporters: ["spec"],
  mochaOpts: { timeout: 60000 },
  logLevel: "warn",
};
