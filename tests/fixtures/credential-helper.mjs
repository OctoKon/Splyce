// TD-16 helper fixture: a real child process standing in for a credential helper.
// argv: <mode> <stateFile>. Every run appends its pid to stateFile first, so
// tests can count spawns and check the process is gone afterwards.
import { appendFileSync } from "node:fs";

const [mode, stateFile] = process.argv.slice(2);
appendFileSync(stateFile, `${String(process.pid)}\n`);
if (mode === "ok") process.stdout.write("td16-helper-secret\n");
else if (mode === "fail") process.exit(3);
else if (mode === "flood") process.stdout.write("x".repeat(1 << 20));
else if (mode === "hang") setInterval(() => {}, 1000);
