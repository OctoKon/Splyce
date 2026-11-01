import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { constants, createWriteStream } from "node:fs";
import { resolve, dirname, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { finished } from "node:stream/promises";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const target = resolve(root, "apps/desktop/src-tauri/target");
const tools = resolve(target, "smoke-tools");
const pins = { node: "24.22.1" };
const edgeWebDriverPage =
  "https://developer.microsoft.com/en-us/microsoft-edge/tools/webdriver";
const tauriDriverInventory = resolve(
  root,
  "tests/bootstrap/tauri-driver-inventory.json",
);

export function sanitizeSmokeDiagnostics(report, driverLog) {
  const redact = (value) => {
    for (const directory of [root, process.env.USERPROFILE, process.env.HOME]) {
      if (directory) {
        value = value
          .replaceAll(directory, "<local>")
          .replaceAll(directory.replaceAll("\\", "/"), "<local>");
      }
    }
    return value
      .replace(/\b[A-Za-z]:[\\/][^\r\n"'<>]*/g, "<path>")
      .replace(/\\\\[^\r\n"'<>]+/g, "<path>")
      .replace(/(\/session\/)[^/\s"']+/g, "$1<session>")
      .replace(
        /\b(?:authorization|password|token|api[_-]?key|secret)\b[^\r\n]*/gi,
        "<redacted>",
      );
  };
  // Public CI artifacts omit DOM text, screenshots and process/path inventories.
  const fields = [
    "case",
    "passed",
    "pins",
    "appSha256",
    "driverSha256",
    "edgeSha256",
    "edgeArchiveSha256",
    "webviewVersion",
    "webviewScope",
    "edgeDriverVersion",
    "failedRequest",
    "sessionRequestElapsedMs",
    "webviewDebugging",
    "applicationElevation",
    "runnerProfile",
    "nativeSessionObservation",
    "failureProcesses",
    "failureProcessInspection",
    "nativeDriverStdout",
    "error",
    "captureError",
    "sessionCleanup",
    "driverCleanup",
    "cleanupInspection",
  ];
  const result = Object.fromEntries(
    fields
      .filter((name) => report[name] !== undefined)
      .map((name) => [name, report[name]]),
  );
  return {
    result: JSON.stringify(
      result,
      (_key, value) => (typeof value === "string" ? redact(value) : value),
      2,
    ),
    driverLog: redact(driverLog.slice(-65536)),
  };
}

export function assertGenerationUnconfigured(state) {
  assert.equal(state.connection, "unavailable");
  assert.deepEqual(state.readiness, {
    policy: "true",
    store: "true",
    receipts: "true",
  });
  assert.equal(state.banner, true);
  assert.equal(state.bannerHeading, "Generation unconfigured");
  assert.equal(state.ready, false);
  assert.equal(state.sendDisabled, true);
}

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

function processes() {
  const result = powershell(
    "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,ExecutablePath,CreationDate | ConvertTo-Json -Compress",
  );
  return JSON.parse(result || "[]");
}

export function webviewDebuggingFlags(commandLine) {
  const match = commandLine.match(
    /(?:^|\s|")--remote-debugging-port(?:=|\s+)"?(\d+)"?(?=$|\s|")/,
  );
  const port = match ? Number(match[1]) : null;
  return {
    port: Number.isInteger(port) && port >= 0 && port <= 65535 ? port : null,
    pipe: /(?:^|\s|")--remote-debugging-pipe(?:$|\s|")/.test(commandLine),
  };
}

export function webviewOverrideFlags(commandLine, requestedFolder) {
  // Respect Windows quoting so a switch inside another argument's value is not evidence.
  const args = [];
  let arg = "",
    quoted = false,
    started = false;
  for (let i = 0; i < commandLine.length; i++) {
    let slashes = 0;
    while (commandLine[i] === "\\") {
      slashes++;
      i++;
    }
    if (commandLine[i] === '"') {
      arg += "\\".repeat(Math.floor(slashes / 2));
      if (slashes % 2) arg += '"';
      else if (quoted && commandLine[i + 1] === '"') {
        arg += '"';
        i++;
      } else quoted = !quoted;
      started = true;
    } else {
      arg += "\\".repeat(slashes);
      if (i === commandLine.length) break;
      if (/\s/.test(commandLine[i]) && !quoted) {
        if (started) args.push(arg);
        arg = "";
        started = false;
      } else {
        arg += commandLine[i];
        started = true;
      }
    }
  }
  if (started) args.push(arg);
  const folderIndex = args.indexOf("--user-data-dir");
  const actualFolder =
    args.find((value) => value.startsWith("--user-data-dir="))?.slice(16) ??
    (folderIndex >= 0 ? args[folderIndex + 1] : undefined);
  return {
    disableGpu: args.includes("--disable-gpu"),
    requestedFolderMatch: requestedFolder
      ? Boolean(actualFolder) &&
        win32.normalize(actualFolder).toLowerCase() ===
          win32.normalize(requestedFolder).toLowerCase()
      : null,
  };
}

export function processElevation(candidate) {
  const unknown = { status: "unknown", elevated: null };
  const serializedDate = candidate?.CreationDate;
  const legacyDate =
    typeof serializedDate === "string" &&
    serializedDate.match(/^\/Date\((\d+)\)\/$/);
  const creationMs = legacyDate
    ? Number(legacyDate[1])
    : Date.parse(serializedDate);
  if (
    !Number.isSafeInteger(candidate?.ProcessId) ||
    candidate.ProcessId <= 0 ||
    !Number.isSafeInteger(creationMs)
  )
    return unknown;
  try {
    const result = JSON.parse(
      execFileSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-File",
          resolve(root, "tests/bootstrap/process-elevation.ps1"),
          "-ProcessId",
          String(candidate.ProcessId),
          "-CreationTimeMs",
          String(creationMs),
        ],
        { encoding: "utf8", windowsHide: true, timeout: 15000 },
      ),
    );
    return result.status === "observed" && typeof result.elevated === "boolean"
      ? { status: "observed", elevated: result.elevated }
      : unknown;
  } catch {
    return unknown;
  }
}

async function webviewDebuggingState(owned) {
  const ids = owned
    .filter((candidate) => webViewVersionFromProcess(candidate))
    .map((candidate) => candidate.ProcessId)
    .filter((id) => Number.isSafeInteger(id) && id > 0);
  if (!ids.length) return { declaredPorts: [], pipe: false, endpoints: [] };
  const filter = ids.map((id) => "ProcessId=" + id).join(" OR ");
  const commands = JSON.parse(
    powershell(
      "ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process -Filter '" +
        filter +
        "' | Select-Object ProcessId,CreationDate,CommandLine)",
    ),
  ).filter((candidate) =>
    owned.some((original) => sameProcess(candidate, original)),
  );
  const liveIds = commands.map((candidate) => candidate.ProcessId);
  if (!liveIds.length) return { declaredPorts: [], pipe: false, endpoints: [] };
  const flags = commands.map((candidate) =>
    webviewDebuggingFlags(candidate.CommandLine || ""),
  );
  const overrides = commands
    .filter(
      (candidate) =>
        typeof candidate.CommandLine === "string" &&
        candidate.CommandLine.length > 0,
    )
    .map((candidate) =>
      webviewOverrideFlags(
        candidate.CommandLine,
        process.env.WEBVIEW2_USER_DATA_FOLDER,
      ),
    );
  const sockets = JSON.parse(
    powershell(
      "ConvertTo-Json -Compress -InputObject @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.OwningProcess -in @(" +
        liveIds.join(",") +
        ") -and $_.LocalAddress -in @('127.0.0.1', '::1', '0.0.0.0', '::') } | Select-Object LocalAddress,LocalPort)",
    ),
  );
  const endpoints = await Promise.all(
    sockets
      .filter(
        (socket) =>
          Number.isInteger(socket.LocalPort) &&
          socket.LocalPort > 0 &&
          socket.LocalPort <= 65535,
      )
      .slice(0, 8)
      .map(async (socket) => {
        const host = socket.LocalAddress.includes(":") ? "[::1]" : "127.0.0.1";
        const endpoint = { host, port: socket.LocalPort };
        try {
          const response = await fetch(
            "http://" + host + ":" + socket.LocalPort + "/json/version",
            { signal: AbortSignal.timeout(1000) },
          );
          const details = await response.json().catch(() => null);
          return {
            ...endpoint,
            status: response.status,
            devtools:
              response.ok && typeof details?.webSocketDebuggerUrl === "string",
          };
        } catch (error) {
          return { ...endpoint, error: error.name };
        }
      }),
  );
  return {
    declaredPorts: [
      ...new Set(
        flags.map((flag) => flag.port).filter((port) => port !== null),
      ),
    ],
    pipe: flags.some((flag) => flag.pipe),
    observedCommandCount: overrides.length,
    disableGpu: overrides.length
      ? overrides.some((flag) => flag.disableGpu)
      : null,
    requestedFolderMatch:
      overrides.length && process.env.WEBVIEW2_USER_DATA_FOLDER
        ? overrides.some((flag) => flag.requestedFolderMatch)
        : null,
    endpoints,
  };
}

function installedWebViewRuntime() {
  const probe = resolve(root, "tests/bootstrap/webview2-runtime.ps1");
  return JSON.parse(
    execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-File", probe, "-Probe"],
      {
        encoding: "utf8",
        windowsHide: true,
        timeout: 15000,
      },
    ),
  );
}

function webViewVersionFromProcess(process) {
  return process.ExecutablePath?.match(
    /\\EdgeWebView\\Application\\(\d+(?:\.\d+){3})\\msedgewebview2\.exe$/i,
  )?.[1];
}

export function sameProcess(left, right) {
  return (
    left.ProcessId === right.ProcessId &&
    left.CreationDate === right.CreationDate
  );
}

export function assertDriverProvenance(manifest, pin, actual) {
  const version = /^\d+(?:\.\d+){3}$/;
  const sha256 = /^[0-9a-f]{64}$/;
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.tauriDriver.version, pin.version);
  assert.equal(
    manifest.tauriDriver.crateUrl,
    `https://crates.io/api/v1/crates/tauri-driver/${pin.version}/download`,
  );
  assert.equal(manifest.tauriDriver.crateSha256, pin.crateSha256);
  assert.match(manifest.tauriDriver.binarySha256, sha256);
  assert.equal(manifest.tauriDriver.binarySha256, actual.tauriDriverSha256);
  assert.equal(manifest.webview2.distribution, "Evergreen");
  assert.match(manifest.webview2.runtimeVersion, version);
  assert.equal(manifest.webview2.runtimeVersion, actual.runtimeVersion);
  assert.equal(manifest.webview2.registryScope, actual.runtimeScope);
  assert.match(manifest.edgeDriver.version, version);
  assert.equal(manifest.edgeDriver.version, actual.edgeDriverVersion);
  assert.equal(manifest.edgeDriver.sourcePage, edgeWebDriverPage);
  assert.ok(
    [
      edgeWebDriverPage,
      `https://msedgedriver.microsoft.com/LATEST_RELEASE_${manifest.edgeDriver.version.split(".")[0]}_WINDOWS`,
    ].includes(manifest.edgeDriver.versionSource),
    "Microsoft Edge WebDriver version must come from a Microsoft driver record",
  );
  assert.equal(
    manifest.edgeDriver.downloadUrl,
    `https://msedgedriver.microsoft.com/${manifest.edgeDriver.version}/edgedriver_win64.zip`,
  );
  assert.equal(
    manifest.edgeDriver.version.split(".").slice(0, 3).join("."),
    manifest.webview2.runtimeVersion.split(".").slice(0, 3).join("."),
    "Microsoft Edge WebDriver must match the installed WebView2 build",
  );
  assert.match(manifest.edgeDriver.archiveSha256, sha256);
  assert.equal(manifest.edgeDriver.archiveSha256, actual.edgeArchiveSha256);
  assert.match(manifest.edgeDriver.binarySha256, sha256);
  assert.equal(manifest.edgeDriver.binarySha256, actual.edgeDriverSha256);
}

export function ownedBy(process, owner, list) {
  const visited = new Set();
  let current = process;
  while (current && !visited.has(current.ProcessId)) {
    if (current.ParentProcessId === owner) return true;
    visited.add(current.ProcessId);
    current = list.find(
      (candidate) => candidate.ProcessId === current.ParentProcessId,
    );
  }
  return false;
}

async function until(check, description, timeout = 20000) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(200);
  }
  throw new Error(`Timed out: ${description}`, { cause: lastError });
}

async function hash(path) {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

export async function runSmoke() {
  assert.equal(
    process.platform,
    "win32",
    "Requires a real Windows desktop session",
  );
  assert.equal(
    process.version,
    `v${pins.node}`,
    "Use the qualified packaged Node 24.22.1",
  );
  const app = resolve(
    process.env.SPLYCE_SMOKE_APP ||
      resolve(target, "release/splyce-desktop.exe"),
  );
  const manifest = JSON.parse(
    await readFile(resolve(tools, "driver-manifest.json"), "utf8"),
  );
  assert.match(manifest.edgeDriver?.version || "", /^\d+(?:\.\d+){3}$/);
  const driver = resolve(tools, "bin/tauri-driver.exe");
  const edgeDirectory = resolve(tools, `edge-${manifest.edgeDriver.version}`);
  const edgeArchive = resolve(edgeDirectory, "edgedriver_win64.zip");
  const edge = resolve(edgeDirectory, "msedgedriver.exe");
  const inventory = JSON.parse(await readFile(tauriDriverInventory, "utf8"));
  const tauriDriverPin = inventory.find(
    (entry) => entry.name === "tauri-driver",
  );
  assert(tauriDriverPin, "tauri-driver source pin is required");
  const artifacts = resolve(
    target,
    "bootstrap-smoke",
    new Date().toISOString().replaceAll(":", "-"),
  );
  await mkdir(artifacts, { recursive: true });
  const report = {
    case: "bootstrap-generation-unconfigured-release",
    passed: false,
    app,
    pins: {
      node: pins.node,
      tauriDriver: tauriDriverPin.version,
      webview2: manifest.webview2.runtimeVersion,
      edgeDriver: manifest.edgeDriver.version,
    },
    checks: [],
  };
  const logs = createWriteStream(resolve(artifacts, "driver.log"));
  let child;
  let session;
  let application;
  let engine;
  let sessionRequestStartedAt;
  const port = 4444;
  const base = `http://127.0.0.1:${port}`;
  async function request(method, path, body) {
    report.lastRequest = { method, path };
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(20000),
    });
    const result = await response.json();
    if (!response.ok || result.value?.error)
      throw new Error(JSON.stringify(result));
    return result.value;
  }
  const execute = (script) =>
    request("POST", `/session/${session}/execute/sync`, { script, args: [] });
  const state = () =>
    execute(`const shell = document.querySelector('[data-testid="app-shell"]'); return {
    connection: shell?.dataset.connectionState,
    readiness: {policy:shell?.dataset.readinessPolicy,store:shell?.dataset.readinessStore,receipts:shell?.dataset.readinessReceipts},
    banner: !!document.querySelector('[data-testid="unavailable-banner"]'),
    bannerHeading: document.querySelector('[data-testid="unavailable-banner"] h2')?.textContent,
    sendDisabled: document.querySelector('form[aria-label="Composer"] button[type="submit"]')?.disabled,
    ready: !!document.querySelector('.workspace-view'),
    text: document.body.innerText,
    origin: location.origin
  };`);
  async function screenshot(name) {
    const png = await request("GET", `/session/${session}/screenshot`);
    await writeFile(
      resolve(artifacts, `${name}.png`),
      Buffer.from(png, "base64"),
    );
  }
  try {
    report.appSha256 = await hash(app);
    report.driverSha256 = await hash(driver);
    report.edgeSha256 = await hash(edge);
    report.edgeArchiveSha256 = await hash(edgeArchive);
    report.driverVersion = tauriDriverPin.version;
    report.edgeVersion = execFileSync(edge, ["--version"], {
      encoding: "utf8",
      windowsHide: true,
    }).trim();
    const edgeVersion = report.edgeVersion.match(
      /^Microsoft Edge WebDriver (\d+(?:\.\d+){3})\b/,
    )?.[1];
    assert(edgeVersion, "msedgedriver must report its four-part version");
    const runtime = installedWebViewRuntime();
    assertDriverProvenance(manifest, tauriDriverPin, {
      tauriDriverSha256: report.driverSha256,
      edgeDriverSha256: report.edgeSha256,
      edgeArchiveSha256: report.edgeArchiveSha256,
      edgeDriverVersion: edgeVersion,
      runtimeVersion: runtime.version,
      runtimeScope: runtime.scope,
    });
    report.webviewVersion = runtime.version;
    report.webviewScope = runtime.scope;
    report.edgeDriverVersion = edgeVersion;
    const before = processes();
    assert(
      !before.some(
        (candidate) =>
          candidate.ExecutablePath?.toLowerCase() === app.toLowerCase(),
      ),
      "Close an existing instance before testing",
    );
    // Refuse another runner's listener rather than connecting to an unowned driver.
    assert.equal(
      powershell(
        `@(Get-NetTCPConnection -LocalPort ${port},4445 -State Listen -ErrorAction SilentlyContinue).Count`,
      ),
      "0",
    );
    child = spawn(driver, ["--port", String(port), "--native-driver", edge], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let spawnError;
    child.on("error", (error) => {
      spawnError = error;
    });
    child.stdout.pipe(logs, { end: false });
    child.stderr.pipe(logs, { end: false });
    await until(async () => {
      if (spawnError) throw spawnError;
      assert.equal(child.exitCode, null, "tauri-driver exited before startup");
      return (await request("GET", "/status")).ready;
    }, "owned tauri-driver startup");
    sessionRequestStartedAt = Date.now();
    const created = await request("POST", "/session", {
      capabilities: { alwaysMatch: { "tauri:options": { application: app } } },
    });
    report.sessionRequestElapsedMs = Date.now() - sessionRequestStartedAt;
    session = created.sessionId;
    assert(session, "WebDriver session ID is required");
    assert.equal(
      (await request("GET", `/session/${session}/window/handles`)).length,
      1,
    );
    const list = processes();
    application = list.find(
      (candidate) =>
        candidate.ExecutablePath?.toLowerCase() === app.toLowerCase() &&
        ownedBy(candidate, child.pid, list),
    );
    assert(
      application,
      "Packaged application must belong to the spawned driver tree",
    );
    report.application = application;
    const webview = await until(() => {
      const current = processes();
      return current.find(
        (candidate) =>
          ownedBy(candidate, child.pid, current) &&
          webViewVersionFromProcess(candidate) === runtime.version,
      );
    }, "packaged app uses the registered Evergreen WebView2 runtime");
    report.webviewProcess = webview;
    report.ownedProcesses = list.filter((candidate) =>
      ownedBy(candidate, child.pid, list),
    );
    // WebDriver can attach while native setup still verifies and starts the engine.
    engine = await until(() => {
      const current = processes();
      report.ownedProcesses = current.filter((candidate) =>
        ownedBy(candidate, child.pid, current),
      );
      return current.find(
        (candidate) =>
          candidate.ParentProcessId === application.ProcessId &&
          candidate.ExecutablePath?.toLowerCase().endsWith(
            "\\engine\\node.exe",
          ),
      );
    }, "packaged app owns the actual bundled Node engine child");
    report.engine = engine;
    report.engineSha256 = await hash(engine.ExecutablePath);
    const unavailable = await until(async () => {
      const value = await state();
      return value.connection === "unavailable" ? value : null;
    }, "native core readiness rendered with generation unavailable");
    assertGenerationUnconfigured(unavailable);
    await execute(`const input = document.querySelector('#composer-input');
      input.value = 'Bootstrap unavailable-generation check';
      input.dispatchEvent(new Event('input', {bubbles:true}));`);
    assertGenerationUnconfigured(await state());
    assert(
      [
        "http://tauri.localhost",
        "https://tauri.localhost",
        "tauri://localhost",
      ].includes(unavailable.origin),
    );
    report.checks.push({ unavailable });
    await screenshot("unavailable");
    const denied = await request("POST", `/session/${session}/execute/async`, {
      script: `const done = arguments[arguments.length-1]; window.__TAURI_INTERNALS__.invoke('send', {op:'session.start',payload:{protocolVersion:0}}).then(() => done({allowed:true}), error => done({allowed:false,code:error.code}));`,
      args: [],
    });
    assert.deepEqual(denied, { allowed: false, code: "POLICY_DENIED" });
    assertGenerationUnconfigured(await state());
    report.checks.push({ nativeDenied: denied });
    const current = processes().find((candidate) =>
      sameProcess(candidate, engine),
    );
    assert(
      current &&
        current.ParentProcessId === application.ProcessId &&
        current.ExecutablePath === engine.ExecutablePath,
      "Verify child ownership immediately before termination",
    );
    process.kill(engine.ProcessId);
    const disconnected = await until(async () => {
      const value = await state();
      return value.connection === "disconnected" ? value : null;
    }, "real engine exit changes renderer state to disconnected");
    assert.equal(disconnected.ready, false);
    assert.equal(disconnected.sendDisabled, true);
    assert.match(disconnected.text, /Engine stopped/i);
    report.checks.push({ disconnected });
    await screenshot("disconnected");
    await request("DELETE", `/session/${session}/window`);
    await until(
      () =>
        !processes().some(
          (candidate) =>
            sameProcess(candidate, application) ||
            sameProcess(candidate, engine),
        ),
      "window close cleans application and owned engine",
    );
    report.checks.push({ windowCloseCleanup: true });
    report.passed = true;
  } catch (error) {
    report.error = error.stack;
    report.failedRequest = report.lastRequest;
    if (sessionRequestStartedAt && !session)
      report.sessionRequestElapsedMs = Date.now() - sessionRequestStartedAt;
    console.error("Failed at WebDriver request:", report.failedRequest);
    try {
      const snapshot = processes();
      const owned = snapshot.filter(
        (candidate) => child?.pid && ownedBy(candidate, child.pid, snapshot),
      );
      const applications = owned.filter(
        (candidate) =>
          candidate.ExecutablePath?.toLowerCase() === app.toLowerCase(),
      );
      report.failureProcesses = {
        driverAlive: child?.exitCode === null,
        nativeDriverStarted: owned.some(
          (candidate) =>
            candidate.ExecutablePath?.toLowerCase() === edge.toLowerCase(),
        ),
        applicationStarted: applications.length > 0,
        applicationWindowStarted: applications.some(
          (candidate) =>
            Number(
              powershell(
                `(Get-Process -Id ${candidate.ProcessId} -ErrorAction Stop).MainWindowHandle`,
              ),
            ) > 0,
        ),
        webviewStarted: owned.some((candidate) =>
          webViewVersionFromProcess(candidate),
        ),
        engineStarted: owned.some((candidate) =>
          candidate.ExecutablePath?.toLowerCase().endsWith(
            "\\engine\\node.exe",
          ),
        ),
      };
      console.error("Owned process state:", report.failureProcesses);
      // Pinned tauri-driver discards native stdout; native stderr inherits our log pipe.
      report.nativeDriverStdout = "suppressed by tauri-driver 2.1.0";
      report.applicationElevation = applications.map(processElevation);
      report.webviewDebugging = await webviewDebuggingState(owned);
      console.error("Owned WebView debugging state:", report.webviewDebugging);
      const profile = process.env.USERPROFILE;
      report.runnerProfile = {
        configured: Boolean(profile),
        exists:
          Boolean(profile) &&
          (await access(profile, constants.F_OK).then(
            () => true,
            () => false,
          )),
        writeAccessCheck:
          Boolean(profile) &&
          (await access(profile, constants.W_OK).then(
            () => true,
            () => false,
          )),
        webviewFolderOverride: Boolean(process.env.WEBVIEW2_USER_DATA_FOLDER),
      };
      if (
        !session &&
        report.failedRequest?.path === "/session" &&
        child?.exitCode === null
      ) {
        // A later session is diagnostic only; the original smoke error is always rethrown.
        try {
          const sessions = await request("GET", "/sessions");
          report.nativeSessionObservation = {
            elapsedSinceSessionStartMs: Date.now() - sessionRequestStartedAt,
            sessionCount: Array.isArray(sessions) ? sessions.length : null,
          };
        } catch (observationError) {
          report.nativeSessionObservation = {
            elapsedSinceSessionStartMs: Date.now() - sessionRequestStartedAt,
            error: observationError.name,
          };
        }
      }
    } catch (inspectionError) {
      report.failureProcessInspection = String(inspectionError);
    }
    if (session) {
      try {
        await screenshot("failure");
        report.failureState = await state();
      } catch (captureError) {
        report.captureError = String(captureError);
      }
    }
    throw error;
  } finally {
    if (session) {
      try {
        await request("DELETE", `/session/${session}`);
      } catch (error) {
        report.sessionCleanup = String(error);
      }
    }
    if (child?.pid && child.exitCode === null) {
      try {
        execFileSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
          windowsHide: true,
          timeout: 15000,
        });
      } catch (error) {
        report.driverCleanup = String(error);
      }
    }
    try {
      const survivors = processes().filter((candidate) =>
        [application, engine].some(
          (owned) => owned && sameProcess(candidate, owned),
        ),
      );
      if (survivors.length) {
        report.passed = false;
        report.survivors = survivors;
        process.exitCode = 1;
      }
    } catch (error) {
      report.passed = false;
      report.cleanupInspection = String(error);
      process.exitCode = 1;
    }
    logs.end();
    await finished(logs);
    await writeFile(
      resolve(artifacts, "result.json"),
      JSON.stringify(report, null, 2),
    );
    const diagnostics = sanitizeSmokeDiagnostics(
      report,
      await readFile(resolve(artifacts, "driver.log"), "utf8"),
    );
    const diagnosticDirectory = resolve(artifacts, "diagnostics");
    await mkdir(diagnosticDirectory, { recursive: true });
    await writeFile(
      resolve(diagnosticDirectory, "result.json"),
      diagnostics.result,
    );
    await writeFile(
      resolve(diagnosticDirectory, "driver.log"),
      diagnostics.driverLog,
    );
    console.log(
      `${report.passed ? "PASS" : "FAIL"} ${report.case}: ${artifacts}`,
    );
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  runSmoke().catch((error) => {
    console.error(error.stack);
    process.exitCode = 1;
  });
}
