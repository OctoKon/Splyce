import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const failure = (code) => Object.assign(new Error(code), { code });

// Cooperating writers share this lock; trusted in-process or external writers can bypass it.
export function acquireNativeSessionWriter(sessionFile) {
  let database;
  try {
    if (
      typeof sessionFile !== "string" ||
      !path.isAbsolute(sessionFile) ||
      sessionFile.includes("\0")
    )
      throw new Error();
    if (
      process.platform === "win32" &&
      (sessionFile.startsWith("\\\\") || !/^[a-z]:\\/i.test(sessionFile))
    )
      throw new Error();
    const basename = path.basename(sessionFile);
    if (
      !basename ||
      basename === "." ||
      basename === ".." ||
      (process.platform === "win32" &&
        (/[ .:]$|:/.test(basename) ||
          /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(basename)))
    )
      throw new Error();
    const parent = realpathSync(path.dirname(sessionFile));
    const target = path.join(parent, basename);
    try {
      const stat = lstatSync(target);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
        throw new Error();
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const name =
      process.platform === "win32" ? basename.toLowerCase() : basename;
    const lockFile = path.join(
      parent,
      `.splyce-writer-${createHash("sha256").update(name).digest("hex")}.sqlite`,
    );
    try {
      const stat = lstatSync(lockFile);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
        throw new Error();
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    database = new DatabaseSync(lockFile, { timeout: 0 });
    database.exec("BEGIN IMMEDIATE");
    return {
      assertCurrent() {
        try {
          if (!database || !database.isTransaction) throw new Error();
        } catch {
          throw failure("NATIVE_SESSION_UNAVAILABLE");
        }
      },
      close() {
        if (!database) return;
        const current = database;
        database = undefined;
        try {
          if (current.isTransaction) current.exec("ROLLBACK");
        } catch {
          try {
            current.close();
          } catch {}
          throw failure("NATIVE_SESSION_UNAVAILABLE");
        }
        try {
          current.close();
        } catch {
          throw failure("NATIVE_SESSION_UNAVAILABLE");
        }
      },
    };
  } catch (error) {
    try {
      database?.close();
    } catch {
      /* Preserve the fixed error. */
    }
    throw failure(
      error.errcode === 5 || error.code === "SQLITE_BUSY"
        ? "NATIVE_SESSION_BUSY"
        : "NATIVE_SESSION_UNAVAILABLE",
    );
  }
}
