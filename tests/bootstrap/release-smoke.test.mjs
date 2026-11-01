import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import {
  assertDriverProvenance,
  assertGenerationUnconfigured,
  ownedBy,
  sameProcess,
  sanitizeSmokeDiagnostics,
  webviewDebuggingFlags,
  webviewOverrideFlags,
  processElevation,
} from "./release-smoke.mjs";

test("WebView override observations distinguish requested from effective flags", () => {
  const folder = "C:\\private-profile\\fresh folder";
  for (const argument of [
    `--user-data-dir="${folder}"`,
    `"--user-data-dir=${folder}"`,
  ]) {
    assert.deepEqual(
      webviewOverrideFlags(`${argument} --disable-gpu`, folder.toUpperCase()),
      {
        disableGpu: true,
        requestedFolderMatch: true,
      },
    );
  }
  for (const command of [
    "",
    "--disable-gpu-sandbox",
    "--unrelated-disable-gpu",
    '--user-data-dir="C:\\different"',
    '--log-file="--disable-gpu"',
    '--log-file="prefix --disable-gpu suffix"',
    '--log-file="prefix \\" --disable-gpu suffix"',
    '--log-file="prefix --user-data-dir=C:\\private-profile\\fresh folder"',
  ]) {
    assert.deepEqual(webviewOverrideFlags(command, folder), {
      disableGpu: false,
      requestedFolderMatch: false,
    });
  }
  assert.equal(
    webviewOverrideFlags("--disable-gpu", undefined).requestedFolderMatch,
    null,
  );
});

test(
  "elevation inspection binds an owned child to its creation time",
  { skip: process.platform !== "win32" },
  async () => {
    const child = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      { windowsHide: true, stdio: "ignore" },
    );
    try {
      await once(child, "spawn");
      const candidate = JSON.parse(
        execFileSync(
          "powershell.exe",
          [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            `Get-CimInstance Win32_Process -Filter 'ProcessId=${child.pid}' | Select-Object ProcessId,CreationDate | ConvertTo-Json -Compress`,
          ],
          { encoding: "utf8", windowsHide: true, timeout: 15000 },
        ),
      );
      const observed = processElevation(candidate);
      assert.equal(observed.status, "observed");
      assert.equal(typeof observed.elevated, "boolean");
      const inheritedElevation = execFileSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)",
        ],
        { encoding: "utf8", windowsHide: true, timeout: 15000 },
      ).trim();
      assert.match(inheritedElevation, /^(True|False)$/);
      assert.equal(observed.elevated, inheritedElevation === "True");
      assert.deepEqual(Object.keys(observed).sort(), ["elevated", "status"]);
      const details = JSON.parse(
        execFileSync(
          "powershell.exe",
          [
            "-NoProfile",
            "-NonInteractive",
            "-File",
            fileURLToPath(new URL("./process-elevation.ps1", import.meta.url)),
            "-ProcessId",
            String(candidate.ProcessId),
            "-CreationTimeMs",
            candidate.CreationDate.match(/\d+/)[0],
            "-Details",
          ],
          { encoding: "utf8", windowsHide: true, timeout: 15000 },
        ),
      );
      assert.equal(details.status, "observed");
      assert.equal(details.elevated, observed.elevated);
      assert([1, 2, 3].includes(details.elevationType));
      assert(
        details.linkedTokenAvailable === null ||
          typeof details.linkedTokenAvailable === "boolean",
      );
      if (details.elevationType === 1)
        assert.equal(details.linkedTokenAvailable, false);
      assert.deepEqual(Object.keys(details).sort(), [
        "elevated",
        "elevationType",
        "linkedTokenAvailable",
        "status",
      ]);
      assert.deepEqual(
        processElevation({ ...candidate, CreationDate: "/Date(0)/" }),
        { status: "unknown", elevated: null },
      );
      assert.deepEqual(processElevation({ ...candidate, ProcessId: -1 }), {
        status: "unknown",
        elevated: null,
      });
      assert.deepEqual(
        processElevation({ ...candidate, CreationDate: "invalid" }),
        { status: "unknown", elevated: null },
      );
    } finally {
      const exited = once(child, "exit");
      child.kill();
      await exited;
    }
  },
);

test("WebView debugging diagnostics expose only valid ports and pipe flags", () => {
  assert.deepEqual(
    webviewDebuggingFlags(
      '"C:\\Users\\private-user\\browser.exe" --remote-debugging-port=9222 --remote-debugging-pipe private-credential',
    ),
    { port: 9222, pipe: true },
  );
  assert.deepEqual(webviewDebuggingFlags('--remote-debugging-port "0"'), {
    port: 0,
    pipe: false,
  });
  for (const command of [
    "--remote-debugging-port=65536",
    "--remote-debugging-port=-1",
    "--remote-debugging-port=12invalid",
    "--unrelated-remote-debugging-port=9222",
    "",
  ]) {
    assert.deepEqual(webviewDebuggingFlags(command), {
      port: null,
      pipe: false,
    });
  }
});

test("public smoke diagnostics retain the failed request and omit private data", () => {
  const diagnostic = sanitizeSmokeDiagnostics(
    {
      case: "bootstrap-unavailable-release",
      passed: false,
      applicationElevation: [
        { status: "observed", elevated: true },
        { status: "unknown", elevated: null },
      ],
      sessionRequestElapsedMs: 20001,
      webviewDebugging: {
        declaredPorts: [9222],
        pipe: false,
        endpoints: [
          { host: "127.0.0.1", port: 9222, status: 200, devtools: true },
        ],
      },
      failureProcesses: {
        nativeDriverStarted: true,
        applicationStarted: false,
        applicationWindowStarted: false,
      },
      pins: { webview2: "155.0.4283.62" },
      failedRequest: {
        method: "POST",
        path: "/session/private-session/execute/sync",
      },
      error:
        "Timeout at C:\\Users\\private-user\\Splyce\\smoke.mjs:1\nAuthorization: Bearer private-credential",
      app: "C:\\Users\\private-user\\app.exe",
      failureState: { text: "private-workspace-text" },
      ownedProcesses: [{ ExecutablePath: "private-process" }],
    },
    "driver C:\\Users\\private-user\\driver.exe\ntoken=private-credential\nPOST /session/private-session/execute/sync",
  );
  const result = JSON.parse(diagnostic.result);
  assert.equal(result.passed, false);
  assert.deepEqual(result.applicationElevation, [
    { status: "observed", elevated: true },
    { status: "unknown", elevated: null },
  ]);
  assert.equal(result.sessionRequestElapsedMs, 20001);
  assert.equal(result.webviewDebugging.endpoints[0].devtools, true);
  assert.deepEqual(result.failureProcesses, {
    nativeDriverStarted: true,
    applicationStarted: false,
    applicationWindowStarted: false,
  });
  assert.equal(result.pins.webview2, "155.0.4283.62");
  assert.deepEqual(result.failedRequest, {
    method: "POST",
    path: "/session/<session>/execute/sync",
  });
  for (const value of [diagnostic.result, diagnostic.driverLog]) {
    assert.doesNotMatch(
      value,
      /private-user|private-credential|private-workspace-text|private-process|private-session/,
    );
  }
  assert.equal(result.app, undefined);
  assert.equal(result.failureState, undefined);
  assert.equal(result.ownedProcesses, undefined);
});

test("smoke requires native core readiness with generation unavailable and Send disabled", () => {
  const state = {
    connection: "unavailable",
    readiness: { policy: "true", store: "true", receipts: "true" },
    banner: true,
    bannerHeading: "Generation unconfigured",
    ready: false,
    sendDisabled: true,
  };
  assertGenerationUnconfigured(state);
  for (const name of ["policy", "store", "receipts"]) {
    assert.throws(() =>
      assertGenerationUnconfigured({
        ...state,
        readiness: { ...state.readiness, [name]: "false" },
      }),
    );
  }
  for (const broken of [
    { connection: "ready" },
    { banner: false },
    { bannerHeading: "Engine Unavailable" },
    { sendDisabled: false },
    { sendDisabled: undefined },
    { ready: true },
    { readiness: undefined },
  ]) {
    assert.throws(() => assertGenerationUnconfigured({ ...state, ...broken }));
  }
});

test("cleanup ownership excludes unrelated processes, cycles and reused PIDs", () => {
  const driver = { ProcessId: 10, ParentProcessId: 1, CreationDate: "first" };
  const app = { ProcessId: 20, ParentProcessId: 10, CreationDate: "first" };
  const engine = { ProcessId: 30, ParentProcessId: 20, CreationDate: "first" };
  const unrelated = { ProcessId: 40, ParentProcessId: 50 };
  const cycle = { ProcessId: 50, ParentProcessId: 40 };
  const list = [driver, app, engine, unrelated, cycle];
  assert(ownedBy(engine, driver.ProcessId, list));
  assert(!ownedBy(unrelated, driver.ProcessId, list));
  assert(!ownedBy(driver, driver.ProcessId, list));
  assert(sameProcess(engine, { ...engine }));
  assert(!sameProcess(engine, { ...engine, CreationDate: "replacement" }));
});

test("driver provenance rejects tampered bytes and mismatched versions", () => {
  const pin = {
    version: "2.1.0",
    crateSha256: "a".repeat(64),
  };
  const manifest = {
    schemaVersion: 1,
    tauriDriver: {
      version: pin.version,
      crateUrl: `https://crates.io/api/v1/crates/tauri-driver/${pin.version}/download`,
      crateSha256: pin.crateSha256,
      binarySha256: "b".repeat(64),
    },
    webview2: {
      distribution: "Evergreen",
      runtimeVersion: "155.0.4283.62",
      registryScope: "user",
    },
    edgeDriver: {
      version: "155.0.4283.62",
      sourcePage:
        "https://developer.microsoft.com/en-us/microsoft-edge/tools/webdriver",
      versionSource:
        "https://msedgedriver.microsoft.com/LATEST_RELEASE_155_WINDOWS",
      downloadUrl:
        "https://msedgedriver.microsoft.com/155.0.4283.62/edgedriver_win64.zip",
      archiveSha256: "c".repeat(64),
      binarySha256: "d".repeat(64),
    },
  };
  const actual = {
    tauriDriverSha256: manifest.tauriDriver.binarySha256,
    edgeArchiveSha256: manifest.edgeDriver.archiveSha256,
    edgeDriverSha256: manifest.edgeDriver.binarySha256,
    edgeDriverVersion: manifest.edgeDriver.version,
    runtimeVersion: manifest.webview2.runtimeVersion,
    runtimeScope: manifest.webview2.registryScope,
  };
  assertDriverProvenance(manifest, pin, actual);
  assertDriverProvenance(
    {
      ...manifest,
      edgeDriver: {
        ...manifest.edgeDriver,
        versionSource: manifest.edgeDriver.sourcePage,
      },
    },
    pin,
    actual,
  );
  for (const versionSource of [
    undefined,
    "https://example.invalid/LATEST_RELEASE_155_WINDOWS",
    "https://msedgedriver.microsoft.com/LATEST_RELEASE_156_WINDOWS",
  ]) {
    assert.throws(() =>
      assertDriverProvenance(
        {
          ...manifest,
          edgeDriver: { ...manifest.edgeDriver, versionSource },
        },
        pin,
        actual,
      ),
    );
  }

  assert.throws(() =>
    assertDriverProvenance(
      {
        ...manifest,
        tauriDriver: {
          ...manifest.tauriDriver,
          crateUrl: "https://example.invalid/tauri-driver",
        },
      },
      pin,
      actual,
    ),
  );
  assert.throws(() =>
    assertDriverProvenance(manifest, pin, {
      ...actual,
      tauriDriverSha256: "e".repeat(64),
    }),
  );
  assert.throws(() =>
    assertDriverProvenance(manifest, pin, {
      ...actual,
      edgeDriverSha256: "f".repeat(64),
    }),
  );
  assert.throws(() =>
    assertDriverProvenance(manifest, pin, {
      ...actual,
      edgeArchiveSha256: "e".repeat(64),
    }),
  );
  assert.throws(() =>
    assertDriverProvenance(manifest, pin, {
      ...actual,
      edgeDriverVersion: "155.0.4284.1",
    }),
  );
  assert.throws(() =>
    assertDriverProvenance(manifest, pin, {
      ...actual,
      runtimeVersion: "155.0.4284.1",
    }),
  );
  assert.throws(() =>
    assertDriverProvenance(manifest, pin, {
      ...actual,
      runtimeScope: "machine",
    }),
  );
  assert.throws(() =>
    assertDriverProvenance(
      {
        ...manifest,
        edgeDriver: {
          ...manifest.edgeDriver,
          version: "155.0.4284.1",
          downloadUrl:
            "https://msedgedriver.microsoft.com/155.0.4284.1/edgedriver_win64.zip",
        },
      },
      pin,
      { ...actual, edgeDriverVersion: "155.0.4284.1" },
    ),
  );
});
