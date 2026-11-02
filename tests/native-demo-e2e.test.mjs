import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

// Build with npm run build:engine first. Only the parent credential/filesystem
// services are supplied here; the bundled desktop engine and provider are real.
test(
  "real provider through the desktop engine host",
  {
    skip: process.env.SPLYCE_DEMO_E2E !== "1",
    timeout: 240_000,
  },
  async (t) => {
    const key = process.env.SPLYCE_DEMO_KEY;
    assert.ok(key && key.length >= 16, "SPLYCE_DEMO_KEY is required");
    const clean = (value) => String(value).split(key).join("[redacted]");
    const root = fileURLToPath(new URL("../", import.meta.url));
    const engine = join(root, "apps/desktop/src-tauri/resources/engine");
    const node = join(engine, "node.exe");
    assert.equal(
      spawnSync(node, ["--version"]).stdout?.toString().trim(),
      "v24.22.1",
    );
    const { encodeFrame, readFrames } =
      await import("../packages/splyce-pi/src/engine-host.mjs");
    const { Store } = await import("../packages/splyce-pi/dist/store.js");
    const directory = mkdtempSync(join(tmpdir(), "splyce-demo-e2e-"));
    const project = join(directory, "project");
    const appDataDir = join(directory, "data");
    mkdirSync(project);
    writeFileSync(join(project, "README.md"), "Secret word: banana.");
    const canonicalPath = realpathSync.native(project);
    const identity = lstatSync(project, { bigint: true });
    const selection = {
      canonicalPath,
      volumeSerial: String(identity.dev),
      fileId: String(identity.ino),
    };
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([name]) =>
        /^(path|systemroot|windir|comspec|temp|tmp|userprofile|pathext)$/iu.test(
          name,
        ),
      ),
    );
    const child = spawn(node, [join(engine, "host.mjs")], {
      cwd: project,
      env,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const closed = once(child, "close");
    const pending = new Map();
    const scopes = new Map();
    const events = [];
    const approvals = [];
    let sequence = 0,
      modelCalls = 0,
      credentialRef,
      fatal,
      stderr = "",
      commandContext;
    let expectedApproval;
    let finished = false;
    child.stderr.on("data", (data) => {
      stderr += clean(data);
    });
    const fail = (error) => {
      fatal ??= new Error(clean(error?.message ?? error));
      for (const { reject } of pending.values()) reject(fatal);
      pending.clear();
    };
    child.on("error", fail);
    const write = (frame) => child.stdin.write(encodeFrame(frame));
    const rpc = (method, params, id = `demo-${++sequence}`) =>
      new Promise((resolve, reject) => {
        if (fatal) return reject(fatal);
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Host timeout: ${method}`));
        }, 30_000);
        pending.set(id, {
          method: params.command ?? method,
          resolve(value) {
            clearTimeout(timer);
            resolve(value);
          },
          reject(error) {
            clearTimeout(timer);
            reject(error);
          },
        });
        write({ id, method, params });
      });
    const send = (op, payload) =>
      rpc("send", {
        protocolVersion: 2,
        correlationId: `command-${++sequence}`,
        ...commandContext,
        op,
        payload,
      });
    // The private parent lane uses only the authorized env credential and hashes
    // actual fixture files. No credential is inherited by a tool process.
    const nativeReply = ({ id, method, params }) => {
      let value;
      if (method === "credential.status") {
        assert.equal(params.target, credentialRef);
        value = { present: true };
      } else if (method === "credential.scope.open") {
        assert.equal(params.target, credentialRef);
        assert.equal(scopes.has(params.scopeId), false);
        scopes.set(params.scopeId, { binding: params, read: false });
        value = {};
      } else if (method === "credential.read") {
        const scope = scopes.get(params.scopeId);
        assert.deepEqual(params, scope?.binding);
        assert.equal(scope.read, false);
        assert.ok(modelCalls < 8, "Eight model call budget exhausted");
        scope.read = true;
        modelCalls++;
        value = { secret: key };
      } else if (method === "credential.scope.close") {
        assert.equal(scopes.delete(params.scopeId), true);
        value = {};
      } else if (method === "credential.redact") {
        const parts = params.text.split(key);
        value = {
          text: parts.join("[redacted]"),
          redactedCount: parts.length - 1,
        };
      } else if (method === "inventory.capture") {
        assert.deepEqual(params, selection);
        const current = lstatSync(project, { bigint: true });
        assert.equal(current.dev, identity.dev);
        assert.equal(current.ino, identity.ino);
        const tracked = [];
        const walk = (relative = "") => {
          for (const name of readdirSync(join(project, relative)).sort()) {
            if (name === ".git") continue;
            const path = relative ? `${relative}/${name}` : name;
            const stat = lstatSync(join(project, path));
            assert.equal(stat.isSymbolicLink(), false);
            if (stat.isDirectory()) walk(path);
            else {
              assert.equal(stat.isFile(), true);
              assert.equal(stat.nlink, 1);
              tracked.push({
                path,
                sha256: createHash("sha256")
                  .update(readFileSync(join(project, path)))
                  .digest("hex"),
              });
            }
          }
        };
        walk();
        value = {
          manifest: { tracked, untracked: [], links: [], excluded: [] },
        };
      } else throw new Error(`Unexpected native service: ${method}`);
      write({ native: { id, ok: true, value } });
    };
    const pumping = (async () => {
      for await (const frame of readFrames(child.stdout)) {
        if (frame.native) {
          nativeReply(frame.native);
          continue;
        }
        assert.equal(
          JSON.stringify(frame).includes(key),
          false,
          "Secret reached renderer frames",
        );
        if (frame.event) {
          const event = frame.event;
          assert.equal(
            event.frame,
            undefined,
            "Event delivery requires resync",
          );
          assert.equal(event.seq, (events.at(-1)?.seq ?? 0) + 1);
          events.push(event);
          if (event.kind === "approval.requested") {
            assert.equal(event.durable, true);
            assert.ok(expectedApproval, "Unexpected effect approval");
            assert.match(event.payload.capabilityId, expectedApproval);
            const args = JSON.parse(event.payload.riskRationale);
            if (
              /^workspace\.(bash|powershell)$/u.test(event.payload.capabilityId)
            ) {
              assert.equal(args.command, "echo splyce");
            } else {
              assert.equal(
                resolve(project, args.path),
                join(project, "notes.txt"),
              );
              assert.match(args.content, /^demo ok\r?\n?$/u);
            }
            assert.equal(
              approvals.some((a) => a.actionId === event.payload.actionId),
              false,
            );
            approvals.push(event.payload);
            void send("approval.respond", {
              approvalRequestId: event.payload.approvalRequestId,
              runId: event.payload.runId,
              actionId: event.payload.actionId,
              decision: "approve",
            }).catch(fail);
          }
          continue;
        }
        const request = pending.get(frame.id);
        assert.ok(request, "Unsolicited host response");
        pending.delete(frame.id);
        if (frame.ok) request.resolve(frame.value);
        else
          request.reject(
            new Error(
              `${request.method}: ${frame.error?.code}: ${frame.error?.message}`,
            ),
          );
      }
      if (pending.size) fail(new Error(`Host closed: ${stderr}`));
    })().catch(fail);
    t.after(async () => {
      if (child.exitCode === null) child.kill();
      await closed;
      await pumping;
      if (stderr) t.diagnostic(stderr);
      for (const { reject } of pending.values())
        reject(new Error("Test ended"));
      t.diagnostic(`Model calls used: ${modelCalls}/8`);
      if (finished) rmSync(directory, { recursive: true, force: true });
      else t.diagnostic(`Failure fixture retained: ${directory}`);
    });
    await rpc("native.bootstrap", { appDataDir }, "native-bootstrap");
    const workspace = await rpc("native.workspace.admit", selection);
    const metadata = {
      requestId: "demo-provider",
      workspaceId: workspace.workspaceId,
      providerConnectionId: "demo-pollinations",
      profileId: "demo-profile",
      endpoint: "https://gen.pollinations.ai/v1",
      apiFamily: "openai-completions",
      locality: "hosted",
      chat: {
        modelId: "openai/gpt-oss-20b",
        model: { contextWindow: 131072, maxOutputTokens: 4096 },
      },
      accountScopeRef: "provider-default",
      expectedConnectionRevision: null,
      expectedProfileRevision: null,
      expectedEndpointRevision: null,
      credentialKind: "new",
    };
    // provider.configure is intercepted by Rust, which sends prepare/commit/read.
    const prepared = await rpc("native.provider.prepare", metadata);
    assert.equal(prepared.state, "prepared");
    credentialRef = prepared.credentialRef;
    assert.match(credentialRef, /^splyce-credential:v1:[a-f0-9]{64}$/u);
    const privateSetup = { metadata, credentialRef };
    await rpc("native.provider.commit", privateSetup);
    const configured = (await rpc("native.provider.read", privateSetup)).view;
    const setup = (command, payload) =>
      rpc("send", {
        frame: "setup",
        command,
        requestId: payload.requestId,
        payload,
      });
    const selected = await setup("profile.select", {
      requestId: "demo-select",
      workspaceId: workspace.workspaceId,
      profileId: configured.profileId,
      expectedProfileRevision: configured.profileRevision,
      expectedConfigRevision: configured.configRevision,
    });
    const started = await setup("session.start", {
      requestId: "demo-start",
      workspaceId: workspace.workspaceId,
      profileId: selected.selectedProfileId,
      expectedConfigRevision: selected.configRevision,
    });
    assert.deepEqual(started.readiness, { state: "ready" });
    commandContext = {
      sessionId: started.sessionId,
      scopeId: workspace.workspaceId,
      expectedConfigRevision: selected.configRevision,
      expectedProfileRevision: selected.profileRevision,
      expectedPolicyRevision: started.policyRevision,
    };
    await rpc("subscribe", { sessionId: started.sessionId, afterSeq: 0 });
    t.diagnostic(
      "Setup PASS: workspace admitted; provider configured; profile selected; session ready",
    );
    const prompt = async (text, approval) => {
      expectedApproval = approval;
      const first = events.length;
      const accepted = await send("session.prompt", { text });
      const deadline = Date.now() + 50_000;
      let terminal;
      while (
        !(terminal = events
          .slice(first)
          .find(
            (e) =>
              e.payload.runId === accepted.runId &&
              ["turn.completed", "turn.failed", "turn.canceled"].includes(
                e.kind,
              ),
          ))
      ) {
        if (fatal) throw fatal;
        assert.ok(
          Date.now() < deadline,
          "Timed out waiting for durable terminal event",
        );
        await delay(10);
      }
      const batch = events
        .slice(first)
        .filter((e) => e.payload.runId === accepted.runId);
      assert.equal(
        terminal.kind,
        "turn.completed",
        clean(JSON.stringify(batch)),
      );
      assert.equal(terminal.durable, true);
      return {
        batch,
        text: batch
          .filter((e) => e.kind === "turn.stream_delta")
          .map((e) => e.payload.delta)
          .join(""),
      };
    };
    const hello = await prompt("Reply with exactly: hello expo");
    assert.equal(hello.text, "hello expo");
    t.diagnostic(`1 PASS: ${JSON.stringify(hello.text)}`);
    const read = await prompt("Read README.md and tell me the secret word");
    const readIntent = read.batch.find(
      (e) =>
        e.kind === "turn.tool_intent" &&
        e.payload.capabilityId === "workspace.read",
    );
    assert.ok(readIntent, "No actual read tool call");
    assert.match(read.text, /\bbanana\b/iu);
    assert.ok(
      read.batch.some(
        (e) =>
          e.kind === "turn.tool_outcome" &&
          e.payload.actionId === readIntent.payload.actionId &&
          e.payload.status === "success" &&
          e.payload.summary.preview.includes("Secret word: banana."),
      ),
    );
    t.diagnostic(`2 PASS: read tool; ${JSON.stringify(read.text)}`);
    const shell = await prompt(
      "Run the shell command: echo splyce",
      /^workspace\.(bash|powershell)$/u,
    );
    const shellApproval = approvals.at(-1);
    assert.ok(
      shellApproval &&
        shell.batch.some(
          (e) =>
            e.kind === "approval.requested" &&
            e.payload.actionId === shellApproval.actionId,
        ),
    );
    const shellResult = shell.batch.find(
      (e) =>
        e.kind === "turn.tool_outcome" &&
        e.payload.actionId === shellApproval.actionId,
    );
    assert.equal(shellResult?.payload.status, "success");
    assert.equal(shellResult.payload.summary.exitCode, 0);
    assert.equal(shellResult.payload.summary.preview.trim(), "splyce");
    t.diagnostic(
      `3 PASS: approve once; stdout=${JSON.stringify(shellResult.payload.summary.preview)}; assistant=${JSON.stringify(shell.text)}`,
    );
    const writeResult = await prompt(
      "Create notes.txt containing demo ok",
      /^workspace\.write$/u,
    );
    assert.ok(writeResult.batch.some((e) => e.kind === "approval.requested"));
    const notes = readFileSync(join(project, "notes.txt"), "utf8");
    assert.match(notes, /^demo ok\r?\n?$/u);
    assert.equal(
      approvals.length,
      2,
      "Expected exactly one approval for each mutation",
    );
    assert.ok(
      writeResult.batch.some(
        (e) =>
          e.kind === "turn.tool_outcome" &&
          e.payload.actionId === approvals[1].actionId &&
          e.payload.status === "success",
      ),
    );
    t.diagnostic(
      `4 PASS: approve once; notes.txt=${JSON.stringify(notes)}; assistant=${JSON.stringify(writeResult.text)}`,
    );
    await rpc("shutdown", {});
    assert.equal((await closed)[0], 0, stderr);
    await pumping;
    if (fatal) throw fatal;
    assert.equal(scopes.size, 0);
    const store = Store.open(join(appDataDir, "splyce/store.db"));
    try {
      const durable = store.replayEvents(
        workspace.workspaceId,
        started.sessionId,
        0,
      );
      assert.deepEqual(
        durable,
        events.filter((event) => event.durable),
      );
      assert.equal(
        durable.filter((e) => e.kind === "turn.completed").length,
        4,
      );
    } finally {
      store.close();
    }
    const scan = (path) => {
      for (const name of readdirSync(path)) {
        const file = join(path, name);
        if (lstatSync(file).isDirectory()) scan(file);
        else
          assert.equal(
            readFileSync(file).includes(Buffer.from(key)),
            false,
            "Secret persisted to disk",
          );
      }
    };
    scan(directory);
    t.diagnostic(
      "Durability PASS: four completed turns replayed after host shutdown; no key persisted",
    );
    finished = true;
  },
);
