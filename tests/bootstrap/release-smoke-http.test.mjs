import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import * as smoke from "./release-smoke.mjs";

test("actual session HTTP preserves responses and records headers, body, and body timeout", async () => {
  assert.equal(typeof smoke.smokeRequest, "function");
  let posts = 0;
  let mode = "immediate";
  const server = createServer((req, res) => {
    posts++;
    assert.equal(req.method, "POST");
    assert.equal(req.url, "/session");
    if (mode === "stall") {
      res.writeHead(200, { "content-type": "application/json" });
      res.write('{"value":');
    } else {
      const respond = () => {
        res.writeHead(mode === "error" ? 422 : 200, {
          "content-type": "application/json",
        });
        res.end(
          JSON.stringify({
            value: mode === "error" ? { error: "bad" } : { message: "exact" },
          }),
        );
      };
      if (mode === "delay") setTimeout(respond, 100);
      else respond();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const originalFetch = globalThis.fetch;
  let caughtBodyError;
  try {
    for (mode of ["immediate", "delay"]) {
      const report = {};
      assert.deepEqual(
        await smoke.smokeRequest(
          base,
          "POST",
          "/session",
          { test: true },
          report,
        ),
        { message: "exact" },
      );
      assert.deepEqual(
        report.parentTiming.map((entry) => entry.event),
        ["request_start", "response_headers", "body_complete"],
      );
      if (mode === "delay") assert(report.parentTiming[1].elapsedMs >= 80);
    }
    mode = "error";
    await assert.rejects(
      smoke.smokeRequest(base, "POST", "/session", {}, {}),
      /"error":"bad"/,
    );
    mode = "stall";
    globalThis.fetch = async (...args) => {
      const response = await originalFetch(...args);
      const originalJson = response.json.bind(response);
      response.json = async () => {
        try {
          return await originalJson();
        } catch (error) {
          caughtBodyError = error;
          throw error;
        }
      };
      return response;
    };
    const report = {};
    let error;
    try {
      await smoke.smokeRequest(base, "POST", "/session", {}, report);
    } catch (caught) {
      error = caught;
    }
    assert(error);
    assert.equal(error, caughtBodyError);
    assert.deepEqual(
      report.parentTiming.map((entry) => entry.event),
      ["request_start", "response_headers", "abort"],
    );
    assert(report.parentTiming[2].elapsedMs >= 19000);
    assert.equal(posts, 4);
  } finally {
    globalThis.fetch = originalFetch;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test(
  "patched driver forwards native HTTP response and emits fixed timing events",
  { skip: !process.env.SPLYCE_PROBE_DRIVER },
  async () => {
    const { spawn } = await import("node:child_process");
    const { once } = await import("node:events");
    const { resolve } = await import("node:path");
    const { createServer: createTcpServer } = await import("node:net");
    async function freePort() {
      const socket = createTcpServer();
      await new Promise((done) => socket.listen(0, "127.0.0.1", done));
      const port = socket.address().port;
      await new Promise((done) => socket.close(done));
      return port;
    }
    const nativePort = await freePort();
    let port = await freePort();
    while (port === nativePort) port = await freePort();
    const driver = spawn(
      process.env.SPLYCE_PROBE_DRIVER,
      [
        "--port",
        String(port),
        "--native-port",
        String(nativePort),
        "--native-driver",
        resolve("tests/bootstrap/fixtures/native-driver.cmd"),
      ],
      {
        env: { ...process.env, SPLYCE_PROBE_NODE: process.execPath },
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let logs = "";
    driver.stdout.on("data", (chunk) => {
      logs += chunk;
    });
    driver.stderr.on("data", (chunk) => {
      logs += chunk;
    });
    const base = `http://127.0.0.1:${port}`;
    try {
      let ready = false;
      for (let i = 0; i < 100 && !ready; i++) {
        try {
          const response = await fetch(`${base}/status`, {
            signal: AbortSignal.timeout(100),
          });
          ready = response.status > 0;
        } catch {}
        if (!ready) await new Promise((done) => setTimeout(done, 50));
      }
      assert(ready, "fixture driver did not start");
      for (const mode of ["immediate", "delay", "stall"]) {
        logs = "";
        const start = performance.now();
        const response = await fetch(`${base}/session`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            capabilities: { alwaysMatch: { probeMode: mode } },
          }),
          signal: AbortSignal.timeout(20000),
        });
        assert.equal(response.status, 201);
        assert.equal(response.headers.get("x-probe"), "preserved");
        assert.equal(response.headers.get("x-probe-request"), "preserved");
        if (mode === "stall") await assert.rejects(response.text());
        else
          assert.equal(await response.text(), '{"value":{"fixture":"exact"}}');
        if (mode === "delay") assert(performance.now() - start >= 100);
        const logDeadline = performance.now() + 1000;
        while (
          (!/SPLYCE_TIMING native_forward_start 0/.test(logs) ||
            !/SPLYCE_TIMING native_response_headers \d+/.test(logs)) &&
          performance.now() < logDeadline
        )
          await new Promise((done) => setTimeout(done, 10));
        assert.match(logs, /SPLYCE_TIMING native_forward_start 0/);
        assert.match(logs, /SPLYCE_TIMING native_response_headers \d+/);
      }
    } finally {
      if (driver.exitCode === null) {
        driver.kill();
        await once(driver, "exit");
      }
    }
  },
);
