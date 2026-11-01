import assert from "node:assert/strict";
import {
  assertGenerationUnconfigured,
  sameProcess,
} from "../release-smoke.mjs";
import {
  assertGone,
  closeApplication,
  connected,
  processes,
  record,
  state,
  until,
  verifyOwned,
} from "./desktop.mjs";

describe("packaged bootstrap unavailable and child crash", () => {
  it("denies native work and renders the real owned child exit", async () => {
    const { application, engine } = await connected();
    const denied = await browser.executeAsync((done) => {
      window.__TAURI_INTERNALS__
        .invoke("send", {
          op: "session.start",
          payload: { protocolVersion: 0 },
        })
        .then(
          () => done({ allowed: true }),
          (error) => done({ allowed: false, code: error.code }),
        );
    });
    assert.deepEqual(denied, { allowed: false, code: "POLICY_DENIED" });
    assertGenerationUnconfigured(await state());
    verifyOwned(application, engine);
    assert.equal(
      processes().filter(
        (candidate) =>
          candidate.ParentProcessId === application.ProcessId &&
          candidate.ExecutablePath === engine.ExecutablePath,
      ).length,
      1,
      "Denied command leaves the original child intact",
    );
    await record("denied", { denied, engine });
    verifyOwned(application, engine);
    process.kill(engine.ProcessId);
    const stopped = await until(async () => {
      const value = await state();
      return value.connection === "disconnected" ? value : null;
    }, "actual engine exit reaches the renderer lifecycle channel");
    assert.equal(stopped.ready, false);
    assert.equal(stopped.banner, true);
    assert.equal(stopped.sendDisabled, true);
    assert.match(stopped.text, /Engine stopped/i);
    assert(!processes().some((candidate) => sameProcess(candidate, engine)));
    await record("disconnected", stopped);
    await closeApplication(application);
    await assertGone(application, engine);
  });
});
