import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import {
  assertGenerationUnconfigured,
  ownedBy,
  sameProcess,
} from "../release-smoke.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const app = resolve(
  root,
  "apps/desktop/src-tauri/target/release/splyce-desktop.exe",
);
const artifacts = resolve(
  root,
  "apps/desktop/src-tauri/target/bootstrap-embedded",
  `${Date.now()}-${process.pid}`,
);

function powershell(script) {
  return execFileSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    {
      encoding: "utf8",
      windowsHide: true,
      timeout: 15000,
    },
  ).trim();
}

export function processes() {
  return JSON.parse(
    powershell(
      "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,ExecutablePath,CreationDate | ConvertTo-Json -Compress",
    ) || "[]",
  );
}

export async function until(check, description) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await delay(200);
  }
  throw new Error(`Timed out: ${description}`);
}

export function state() {
  return browser.execute(() => {
    const shell = document.querySelector('[data-testid="app-shell"]');
    return {
      connection: shell?.dataset.connectionState,
      readiness: {
        policy: shell?.dataset.readinessPolicy,
        store: shell?.dataset.readinessStore,
        receipts: shell?.dataset.readinessReceipts,
      },
      banner: !!document.querySelector('[data-testid="unavailable-banner"]'),
      bannerHeading: document.querySelector(
        '[data-testid="unavailable-banner"] h2',
      )?.textContent,
      sendDisabled: document.querySelector(
        'form[aria-label="Composer"] button[type="submit"]',
      )?.disabled,
      ready: !!document.querySelector(".workspace-view"),
      text: document.body.innerText,
      origin: location.origin,
    };
  });
}

export async function record(name, detail) {
  await mkdir(artifacts, { recursive: true });
  await writeFile(
    resolve(artifacts, `${name}.json`),
    JSON.stringify(detail, null, 2),
  );
  await browser.saveScreenshot(resolve(artifacts, `${name}.png`));
}

export async function connected() {
  assert.equal(
    process.platform,
    "win32",
    "Requires an interactive Windows desktop",
  );
  const unavailable = await until(async () => {
    const value = await state();
    return value.connection === "unavailable" &&
      value.readiness.policy === "true"
      ? value
      : null;
  }, "real renderer's validated bootstrap handshake");
  assertGenerationUnconfigured(unavailable);
  await browser.execute(() => {
    const input = document.querySelector("#composer-input");
    input.value = "Bootstrap unavailable-generation check";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  assertGenerationUnconfigured(await state());
  assert(
    [
      "http://tauri.localhost",
      "https://tauri.localhost",
      "tauri://localhost",
    ].includes(unavailable.origin),
  );
  const list = processes();
  const applications = list.filter(
    (candidate) =>
      candidate.ExecutablePath?.toLowerCase() === app.toLowerCase(),
  );
  assert.equal(
    applications.length,
    1,
    "Refuse ambiguous application process ownership",
  );
  const application = applications[0];
  const worker = list.find((candidate) => candidate.ProcessId === process.pid);
  const launcher = list.find(
    (candidate) => candidate.ProcessId === process.ppid,
  );
  assert(
    worker &&
      launcher &&
      worker.ParentProcessId === launcher.ProcessId &&
      launcher.ExecutablePath?.toLowerCase() === process.execPath.toLowerCase(),
    "WebDriver worker must retain its live Node launcher identity",
  );
  // The installed service starts embedded apps in launcher onPrepare, before workers.
  assert(
    application.ParentProcessId === launcher.ProcessId &&
      ownedBy(application, launcher.ProcessId, list),
    "Application must belong to this WebDriver worker's launcher",
  );
  const engine = await until(
    () =>
      processes().find(
        (candidate) =>
          candidate.ParentProcessId === application.ProcessId &&
          candidate.ExecutablePath?.toLowerCase().endsWith(
            "\\engine\\node.exe",
          ),
      ),
    "actual owned packaged Node child",
  );
  await record("unavailable", {
    worker,
    launcher,
    application,
    engine,
    state: unavailable,
  });
  return { application, engine };
}

export function verifyOwned(application, engine) {
  const list = processes();
  const currentApp = list.find((candidate) =>
    sameProcess(candidate, application),
  );
  const currentEngine = list.find((candidate) =>
    sameProcess(candidate, engine),
  );
  assert(
    currentApp && currentApp.ExecutablePath === app,
    "Application identity changed",
  );
  assert(
    currentEngine &&
      currentEngine.ParentProcessId === currentApp.ProcessId &&
      currentEngine.ExecutablePath === engine.ExecutablePath,
    "Engine ownership changed",
  );
}

export async function closeApplication(application) {
  // WM_CLOSE exercises normal native shutdown without granting window IPC to release content.
  const current = processes().find((candidate) =>
    sameProcess(candidate, application),
  );
  assert(
    current && current.ExecutablePath === app,
    "Refuse closing a reused or foreign PID",
  );
  powershell(
    `Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class SplyceClose { [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam); }'; $owned = Get-Process -Id ${application.ProcessId} -ErrorAction Stop; if ($owned.MainWindowHandle -eq 0) { throw 'Owned app has no native window' }; if (-not [SplyceClose]::PostMessage($owned.MainWindowHandle, 16, [IntPtr]::Zero, [IntPtr]::Zero)) { throw 'Native close failed' }`,
  );
}

export async function assertGone(...identities) {
  await until(
    () =>
      !processes().some((candidate) =>
        identities.some((identity) => sameProcess(candidate, identity)),
      ),
    "native close cleans owned application and engine",
  );
  // The embedded server exited with the app; WDIO cannot delete its dead session.
  browser.sessionId = undefined;
}
