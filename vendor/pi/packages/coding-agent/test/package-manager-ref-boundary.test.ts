import { describe, expect, it } from "vitest";
import { DefaultPackageManager } from "../src/core/package-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

describe("git package ref boundary", () => {
	const manager = new DefaultPackageManager({
		cwd: process.cwd(),
		agentDir: process.cwd(),
		settingsManager: SettingsManager.inMemory(),
	});
	const parse = (source: string) =>
		(manager as unknown as { parseSource(source: string): { type: string; ref?: string } }).parseSource(source);

	it("rejects option-shaped pinned refs before command construction", () => {
		for (const source of ["git:github.com/user/repo@--help", "git:https://example.com/user/repo@--help"]) {
			expect(() => parse(source)).toThrow("Invalid git ref");
		}
	});

	it("preserves ordinary branch and commit refs", () => {
		for (const ref of ["main", "release-1", "a".repeat(40)]) {
			expect(parse(`git:github.com/user/repo@${ref}`)).toMatchObject({ type: "git", ref });
		}
	});
});
