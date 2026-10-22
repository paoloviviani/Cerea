import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("debug routes", () => {
	it("ships no anonymous __debug endpoint", () => {
		expect(existsSync(new URL("../../../routes/__debug", import.meta.url))).toBe(false);
	});
});
