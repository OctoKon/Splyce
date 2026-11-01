import type { JsonValue } from "@earendil-works/chord";
import { track } from "@earendil-works/chord/delta";
import { describe, expect, it } from "vitest";
import { assignJson } from "../src/harness/json.ts";

describe("assignJson own JSON members", () => {
	it("keeps special names as data through recursive tracked changes", () => {
		const target = track<{ value: Record<string, JsonValue> }>({ value: {} });
		const incoming = JSON.parse('{"__proto__":{"flag":1},"constructor":{"prototype":{"flag":2}}}') as Record<
			string,
			JsonValue
		>;
		try {
			const change = target.beginChange();
			assignJson(change.state, "value", incoming);
			const prepared = change.prepare();
			expect(Object.getOwnPropertyDescriptor(prepared.value.value, "__proto__")?.value).toEqual({ flag: 1 });
			expect(Object.getOwnPropertyDescriptor(prepared.value.value, "constructor")?.value).toEqual({
				prototype: { flag: 2 },
			});
			expect(({} as Record<string, unknown>).flag).toBeUndefined();
		} finally {
			delete (Object.prototype as Record<string, unknown>).flag;
		}
	});
});
