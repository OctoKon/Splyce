import assert from "node:assert/strict";
import fs, {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import test from "node:test";
import { createSplyceOwner } from "../vendor/pi/packages/agent/src/splyce-readiness.ts";
import {
  SessionManager,
  assertUnownedSessionExport,
  loadEntriesFromFile,
} from "../vendor/pi/packages/coding-agent/src/core/session-manager.ts";

const marker = "fixture-persistence-private-value";
const unavailable = {
  code: "PERSIST_REDACTION_UNAVAILABLE",
  message: "PERSIST_REDACTION_UNAVAILABLE",
};
const tooLarge = {
  code: "PERSIST_ENTRY_TOO_LARGE",
  message: "PERSIST_ENTRY_TOO_LARGE",
};
const user = (text) => ({
  role: "user",
  content: [{ type: "text", text }],
  timestamp: 0,
});
function temporary(t) {
  const directory = mkdtempSync(join(tmpdir(), "splyce-session-persistence-"));
  t.after(() => {
    const target = resolve(directory);
    assert.equal(dirname(target), resolve(tmpdir()));
    assert.ok(basename(target).startsWith("splyce-session-persistence-"));
    rmSync(target, { recursive: true, force: true });
  });
  return directory;
}
function deferred() {
  let resolve;
  const promise = new Promise((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}

test("an owned stage cannot repair an unterminated session through the public loader", async (t) => {
  const directory = temporary(t);
  const owner = createSplyceOwner(() => {});
  const manager = await SessionManager.createOwned(
    directory,
    (subject) => owner.bindPersistence(subject, async (text) => text),
    join(directory, "sessions"),
  );
  const path = join(directory, "unterminated.jsonl");
  const bytes = JSON.stringify({
    type: "session",
    id: "repair-fixture",
    version: 3,
    timestamp: "2026-01-01T00:00:00.000Z",
    cwd: directory,
  });
  writeFileSync(path, bytes);
  const before = structuredClone(manager.getEntries());
  await assert.rejects(
    manager.withPersistence(() => loadEntriesFromFile(path)),
    unavailable,
  );
  assert.equal(readFileSync(path, "utf8"), bytes);
  assert.deepEqual(manager.getEntries(), before);
  assert.equal(existsSync(manager.getSessionFile()), false);
  assert.equal(loadEntriesFromFile(path)[0].id, "repair-fixture");
  assert.equal(readFileSync(path, "utf8"), `${bytes}\n`);
});

async function settledWithin(promise) {
  let timer;
  try {
    return await Promise.race([
      promise.then(
        (value) => ({ state: "fulfilled", value }),
        (error) => ({ state: "rejected", error }),
      ),
      new Promise((finish) => {
        timer = setTimeout(() => finish({ state: "timed-out" }), 1000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

for (const change of ["id", "shape", "role"]) {
  test(`valid JSON with changed ${change} cannot commit a native session`, async (t) => {
    const directory = temporary(t);
    const owner = createSplyceOwner(() => {});
    let corrupt = false;
    const manager = await SessionManager.createOwned(
      directory,
      (subject) =>
        owner.bindPersistence(subject, async (text) => {
          const row = JSON.parse(text);
          if (!corrupt || row?.type !== "message") return text;
          if (change === "id") row.id = "different-structural-id";
          else if (change === "shape") row.unexpected = "field";
          else row.message.role = "assistant";
          return JSON.stringify(row);
        }),
      join(directory, "sessions"),
    );
    const before = structuredClone(manager.getEntries());
    corrupt = true;
    await assert.rejects(
      manager.withPersistence((draft) => draft.appendMessage(user(marker))),
      unavailable,
    );
    assert.deepEqual(manager.getEntries(), before);
    assert.equal(existsSync(manager.getSessionFile()), false);
  });
}

test("late draft aliases cannot alter sanitized nested results or committed state", async () => {
  const manager = SessionManager.inMemory("C:/synthetic-project");
  const entered = deferred(),
    release = deferred();
  let block = true;
  createSplyceOwner(() => {}).bindPersistence(manager, async (text) => {
    if (block) {
      block = false;
      entered.resolve();
      await release.promise;
    }
    return text.replaceAll(marker, "[redacted]");
  });
  let escaped, retained;
  const pending = manager.withPersistence((draft) => {
    escaped = draft;
    assert.throws(() => assertUnownedSessionExport({}), unavailable);
    const id = draft.appendCustomEntry("fixture", {
      nested: { value: marker },
    });
    retained = draft.getEntry(id);
    return { entry: retained, text: marker };
  });
  await entered.promise;
  assert.throws(() => escaped.appendMessage(user("late")));
  retained.data.nested.value = "late mutation";
  release.resolve();
  const result = await pending;
  assert.equal(result.text, "[redacted]");
  assert.equal(result.entry.data.nested.value, "[redacted]");
  assert.equal(
    manager.getEntry(result.entry.id).data.nested.value,
    "[redacted]",
  );
  result.entry.data.nested.value = "returned mutation";
  assert.equal(
    manager.getEntry(result.entry.id).data.nested.value,
    "[redacted]",
  );
  const readAlias = manager.getEntry(result.entry.id);
  readAlias.data.nested.value = "getter mutation";
  assert.equal(
    manager.getEntry(result.entry.id).data.nested.value,
    "[redacted]",
  );
  assert.throws(() => escaped.getEntry(result.entry.id));
  assert.throws(() => assertUnownedSessionExport(escaped), unavailable);
});

test("exclusive first flush preserves a colliding file and recovers without publishing failed state", async (t) => {
  const directory = temporary(t);
  const owner = createSplyceOwner(() => {});
  const manager = await SessionManager.createOwned(
    directory,
    (subject) =>
      owner.bindPersistence(subject, async (text) =>
        text.replaceAll(marker, "[redacted]"),
      ),
    join(directory, "sessions"),
  );
  const path = manager.getSessionFile();
  writeFileSync(path, "collision sentinel");
  const before = structuredClone(manager.getEntries());
  await assert.rejects(
    manager.withPersistence((draft) => draft.appendMessage(user(marker))),
    unavailable,
  );
  assert.equal(readFileSync(path, "utf8"), "collision sentinel");
  assert.deepEqual(manager.getEntries(), before);
  unlinkSync(path);
  const id = await manager.withPersistence((draft) =>
    draft.appendMessage(user(marker)),
  );
  assert.equal(manager.getEntry(id).message.content[0].text, "[redacted]");
  assert.equal(readFileSync(path, "utf8").includes(marker), false);
  const reopened = await SessionManager.openOwned(path, (subject) =>
    owner.bindPersistence(subject, async (text) =>
      text.replaceAll(marker, "[redacted]"),
    ),
  );
  assert.equal(reopened.getEntry(id).message.content[0].text, "[redacted]");
});

test("a malformed sanitized result and multiple staged write targets fail before publication", async (t) => {
  const manager = SessionManager.inMemory("C:/synthetic-project");
  createSplyceOwner(() => {}).bindPersistence(manager, async (text) =>
    JSON.parse(text)?.type ? text : "null",
  );
  await assert.rejects(
    manager.withPersistence((draft) => draft.appendMessage(user("benign"))),
    unavailable,
  );
  assert.equal(manager.getEntries().length, 0);
  const directory = temporary(t);
  const owner = createSplyceOwner(() => {});
  const persistent = await SessionManager.createOwned(
    directory,
    (subject) => owner.bindPersistence(subject, async (text) => text),
    join(directory, "sessions"),
  );
  const originalPath = persistent.getSessionFile();
  await assert.rejects(
    persistent.withPersistence((draft) => {
      draft.appendMessage(user("first target"));
      return draft.newSession();
    }),
    unavailable,
  );
  assert.equal(persistent.getEntries().length, 0);
  assert.equal(existsSync(originalPath), false);
});

test("an append error latches the manager until an explicit owned reopen", async (t) => {
  for (const fault of ["partial", "no-bytes"]) {
    const directory = temporary(t);
    const owner = createSplyceOwner(() => {});
    const bind = (subject) =>
      owner.bindPersistence(subject, async (text) => text);
    const manager = await SessionManager.createOwned(
      directory,
      bind,
      join(directory, "sessions"),
    );
    const acknowledged = await manager.withPersistence((draft) =>
      draft.appendMessage(user("acknowledged")),
    );
    const path = manager.getSessionFile();
    const beforeEntries = manager.getEntries();
    const beforeBytes = readFileSync(path, "utf8");
    const version = () => {
      const { dev, ino, size, mtimeNs, ctimeNs } = statSync(path, {
        bigint: true,
      });
      return { dev, ino, size, mtimeNs, ctimeNs };
    };
    const beforeVersion = version();
    const originalAppend = fs.appendFileSync;
    let calls = 0;
    let partial = "";
    // Fault the real filesystem call after the SUT's physical-version preflight.
    fs.appendFileSync = (target, data, options) => {
      if (target !== path || calls !== 0)
        return originalAppend(target, data, options);
      calls++;
      const bytes = String(data);
      assert.equal(bytes.includes("unacknowledged"), true);
      partial = fault === "partial" ? bytes.slice(0, -2) : "";
      originalAppend(target, partial, options);
      throw Object.assign(new Error("injected append I/O failure"), {
        code: "EIO",
      });
    };
    syncBuiltinESMExports();
    try {
      await assert.rejects(
        manager.withPersistence((draft) =>
          draft.appendMessage(user("unacknowledged")),
        ),
        unavailable,
      );
    } finally {
      fs.appendFileSync = originalAppend;
      syncBuiltinESMExports();
    }
    assert.equal(calls, 1, "the actual append boundary must be reached");
    assert.deepEqual(manager.getEntries(), beforeEntries);
    const failedBytes = readFileSync(path, "utf8");
    assert.equal(failedBytes, beforeBytes + partial);
    if (fault === "partial") {
      assert.notEqual(partial, "");
      assert.equal(failedBytes.includes("unacknowledged"), true);
      assert.throws(() => JSON.parse(partial));
    } else {
      // With no physical version change, only the uncertainty latch can reject retry.
      assert.deepEqual(version(), beforeVersion);
    }
    const retry = await manager
      .withPersistence((draft) => draft.appendMessage(user("blind retry")))
      .then(
        () => ({ rejected: false }),
        (error) => ({ rejected: true, error }),
      );
    assert.equal(
      readFileSync(path, "utf8"),
      failedBytes,
      "blind retry must not publish physical bytes",
    );
    assert.deepEqual(manager.getEntries(), beforeEntries);
    assert.equal(retry.rejected, true);
    assert.equal(retry.error.code, unavailable.code);
    assert.equal(retry.error.message, unavailable.message);
    const reopened = await SessionManager.openOwned(path, bind);
    assert.equal(
      reopened.getEntry(acknowledged).message.content[0].text,
      "acknowledged",
    );
    await reopened.withPersistence((draft) =>
      draft.appendMessage(user("explicit recovery")),
    );
    const recovered = readFileSync(path, "utf8");
    assert.equal(recovered.includes("explicit recovery"), true);
    assert.equal(recovered.includes("unacknowledged"), false);
    assert.equal(recovered.includes("blind retry"), false);
  }
});

test("a pointer-only stage commits newly sanitized historical bytes with its state", async (t) => {
  const directory = temporary(t);
  const owner = createSplyceOwner(() => {});
  let matching = false;
  const manager = await SessionManager.createOwned(
    directory,
    (subject) =>
      owner.bindPersistence(subject, async (text) =>
        matching ? text.replaceAll(marker, "[redacted]") : text,
      ),
    join(directory, "sessions"),
  );
  const id = await manager.withPersistence((draft) =>
    draft.appendMessage(user(marker)),
  );
  matching = true;
  await manager.withPersistence((draft) => draft.resetLeaf());
  assert.equal(
    readFileSync(manager.getSessionFile(), "utf8").includes(marker),
    false,
  );
  assert.equal(manager.getEntry(id).message.content[0].text, "[redacted]");
  assert.equal(manager.getLeafId(), null);
});

test("a one-MiB safe history appends one new qualified entry without resending its prefix or result graph", async (t) => {
  const directory = temporary(t);
  const owner = createSplyceOwner(() => {});
  const observed = [];
  const manager = await SessionManager.createOwned(
    directory,
    (subject) =>
      owner.bindPersistence(subject, async (text) => {
        assert.ok(
          Buffer.byteLength(JSON.stringify(text), "utf8") <= 256 * 1024,
        );
        observed.push(text);
        return text.replaceAll(marker, "[redacted]");
      }),
    join(directory, "sessions"),
  );
  const result = await manager.withPersistence((draft) => {
    for (let index = 0; index < 130; index++)
      draft.appendMessage(user(`history-${index} ${"x".repeat(8192)}`));
    return draft.getEntries();
  });
  assert.equal(result.length, 130);
  const before = readFileSync(manager.getSessionFile(), "utf8");
  assert.ok(Buffer.byteLength(before, "utf8") > 1024 * 1024);
  observed.length = 0;
  const id = await manager.withPersistence((draft) =>
    draft.appendMessage(user(marker)),
  );
  assert.equal(
    observed.filter((text) => JSON.parse(text)?.type === "message").length,
    1,
  );
  assert.equal(
    observed.some((text) => text.includes("history-")),
    false,
  );
  const after = readFileSync(manager.getSessionFile(), "utf8");
  assert.equal(after.startsWith(before), true);
  assert.equal(after.includes(marker), false);
  assert.equal(manager.getEntry(id).message.content[0].text, "[redacted]");
});

test("one entry above the encoded frame lower bound has no file or state effect and is never split", async (t) => {
  const directory = temporary(t);
  const owner = createSplyceOwner(() => {});
  let calls = 0;
  const manager = await SessionManager.createOwned(
    directory,
    (subject) =>
      owner.bindPersistence(subject, async (text) => {
        calls++;
        return text;
      }),
    join(directory, "sessions"),
  );
  const oversized = user("\\".repeat(70 * 1024));
  await assert.rejects(
    manager.withPersistence((draft) => draft.appendMessage(oversized)),
    tooLarge,
  );
  assert.equal(existsSync(manager.getSessionFile()), false);
  assert.equal(manager.getEntries().length, 0);
  await manager.withPersistence((draft) =>
    draft.appendMessage(user("small successful entry")),
  );
  const before = readFileSync(manager.getSessionFile(), "utf8");
  const entries = manager.getEntries();
  calls = 0;
  await assert.rejects(
    manager.withPersistence((draft) => draft.appendMessage(oversized)),
    tooLarge,
  );
  assert.equal(
    calls,
    0,
    "oversized entry must fail before the native lane sees any fragment",
  );
  assert.equal(readFileSync(manager.getSessionFile(), "utf8"), before);
  assert.deepEqual(manager.getEntries(), entries);
});

test("sanitizer same-chain reentry rejects without deadlocking or publishing state", async (t) => {
  const directory = temporary(t);
  const owner = createSplyceOwner(() => {});
  let reenter = false;
  const manager = await SessionManager.createOwned(
    directory,
    (subject) =>
      owner.bindPersistence(subject, async (text) => {
        if (reenter && JSON.parse(text)?.type === "message") {
          reenter = false;
          await manager.withPersistence((draft) =>
            draft.appendMessage(user("nested reentry")),
          );
        }
        return text;
      }),
    join(directory, "sessions"),
  );
  const before = manager.getEntries();
  reenter = true;
  const outcome = await settledWithin(
    manager.withPersistence((draft) =>
      draft.appendMessage(user("outer entry")),
    ),
  );
  assert.equal(
    outcome.state,
    "rejected",
    "same-chain persistence must reject instead of waiting for its own queue",
  );
  assert.deepEqual(
    { code: outcome.error.code, message: outcome.error.message },
    unavailable,
  );
  assert.deepEqual(manager.getEntries(), before);
  assert.equal(existsSync(manager.getSessionFile()), false);
  await manager.withPersistence((draft) =>
    draft.appendMessage(user("recovered after reentry")),
  );
  assert.equal(manager.getEntries().length, 1);
});

test("sanitizer two-manager cycles reject in the inherited async chain", async (t) => {
  const directory = temporary(t);
  const owner = createSplyceOwner(() => {});
  let cycle = false;
  const first = await SessionManager.createOwned(
    directory,
    (subject) =>
      owner.bindPersistence(subject, async (text) => {
        if (cycle && JSON.parse(text)?.type === "message")
          await second.withPersistence((draft) =>
            draft.appendMessage(user("second in cycle")),
          );
        return text;
      }),
    join(directory, "first"),
  );
  const second = await SessionManager.createOwned(
    directory,
    (subject) =>
      owner.bindPersistence(subject, async (text) => {
        if (cycle && JSON.parse(text)?.type === "message")
          await first.withPersistence((draft) =>
            draft.appendMessage(user("first in cycle")),
          );
        return text;
      }),
    join(directory, "second"),
  );
  cycle = true;
  const outcome = await settledWithin(
    first.withPersistence((draft) => draft.appendMessage(user("outer cycle"))),
  );
  assert.equal(
    outcome.state,
    "rejected",
    "the inherited chain must reject a cycle back to the first manager",
  );
  assert.deepEqual(
    { code: outcome.error.code, message: outcome.error.message },
    unavailable,
  );
  assert.deepEqual(first.getEntries(), []);
  assert.deepEqual(second.getEntries(), []);
  assert.equal(existsSync(first.getSessionFile()), false);
  assert.equal(existsSync(second.getSessionFile()), false);
});

test("an unrelated caller remains queued while another caller awaits its sanitizer", async (t) => {
  const directory = temporary(t);
  const owner = createSplyceOwner(() => {});
  const entered = deferred(),
    release = deferred();
  let block = false;
  const manager = await SessionManager.createOwned(
    directory,
    (subject) =>
      owner.bindPersistence(subject, async (text) => {
        if (block && JSON.parse(text)?.type === "message") {
          block = false;
          entered.resolve();
          await release.promise;
        }
        return text;
      }),
    join(directory, "sessions"),
  );
  block = true;
  const first = manager.withPersistence((draft) =>
    draft.appendMessage(user("first queued caller")),
  );
  await entered.promise;
  let secondStages = 0;
  const second = manager.withPersistence((draft) => {
    secondStages++;
    return draft.appendMessage(user("unrelated queued caller"));
  });
  assert.equal(secondStages, 0);
  release.resolve();
  const ids = await Promise.all([first, second]);
  assert.equal(secondStages, 1);
  assert.equal(manager.getEntries().length, 2);
  for (const id of ids) assert.ok(manager.getEntry(id));
  const bytes = readFileSync(manager.getSessionFile(), "utf8");
  assert.ok(bytes.includes("first queued caller"));
  assert.ok(bytes.includes("unrelated queued caller"));
});

test("a paused owned open cannot overwrite another manager's acknowledged append through canonical or junction paths", async (t) => {
  for (const alias of [false, true]) {
    const directory = temporary(t);
    const owner = createSplyceOwner(() => {});
    const bind = (subject) =>
      owner.bindPersistence(subject, async (text) => text);
    const first = await SessionManager.createOwned(
      directory,
      bind,
      join(directory, "sessions"),
    );
    await first.withPersistence((draft) =>
      draft.appendMessage(user("physical baseline")),
    );
    const path = first.getSessionFile();
    let openedPath = path;
    if (alias) {
      const junction = join(directory, "session-alias");
      symlinkSync(
        dirname(path),
        junction,
        process.platform === "win32" ? "junction" : "dir",
      );
      openedPath = join(junction, basename(path));
    }
    const entered = deferred(),
      release = deferred();
    let second;
    let block = true;
    const opening = SessionManager.openOwned(openedPath, (subject) => {
      second = subject;
      owner.bindPersistence(subject, async (text) => {
        if (block) {
          block = false;
          entered.resolve();
          await release.promise;
        }
        return text.replaceAll(
          "physical baseline",
          "sanitized physical baseline",
        );
      });
    });
    await entered.promise;
    const acknowledged = await first.withPersistence((draft) =>
      draft.appendMessage(user("acknowledged during owned open")),
    );
    const bytes = readFileSync(path, "utf8");
    assert.ok(
      bytes.includes(acknowledged),
      "the first manager's acknowledged append is physically present",
    );
    release.resolve();
    const outcome = await settledWithin(opening);
    assert.equal(readFileSync(path, "utf8"), bytes);
    assert.equal(
      outcome.state,
      "rejected",
      "a stale open must not acknowledge its old snapshot",
    );
    assert.deepEqual(
      { code: outcome.error.code, message: outcome.error.message },
      unavailable,
    );
    assert.deepEqual(second.getEntries(), []);
    assert.ok(first.getEntry(acknowledged));
    const recovered = await SessionManager.openOwned(openedPath, bind);
    assert.ok(recovered.getEntry(acknowledged));
  }
});

test("an already-open stale manager rejects its next write and recovers only through owned reopen", async (t) => {
  const directory = temporary(t);
  const owner = createSplyceOwner(() => {});
  const bind = (subject) =>
    owner.bindPersistence(subject, async (text) => text);
  const first = await SessionManager.createOwned(
    directory,
    bind,
    join(directory, "sessions"),
  );
  await first.withPersistence((draft) =>
    draft.appendMessage(user("baseline for stale manager")),
  );
  const path = first.getSessionFile();
  const second = await SessionManager.openOwned(path, bind);
  const previous = second.getEntries();
  const acknowledged = await first.withPersistence((draft) =>
    draft.appendMessage(user("acknowledged after second opened")),
  );
  const bytes = readFileSync(path, "utf8");
  await assert.rejects(
    second.withPersistence((draft) =>
      draft.appendMessage(user("stale unacknowledged write")),
    ),
    unavailable,
  );
  assert.equal(readFileSync(path, "utf8"), bytes);
  assert.deepEqual(second.getEntries(), previous);
  const recovered = await SessionManager.openOwned(path, bind);
  assert.ok(recovered.getEntry(acknowledged));
  await recovered.withPersistence((draft) =>
    draft.appendMessage(user("fresh owned recovery")),
  );
  assert.ok(readFileSync(path, "utf8").includes("fresh owned recovery"));
});
