import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig, safeIdp } from "../src/main/config.ts";

describe("stored settings are re-checked", () => {
	it("keeps only a bare https (or loopback http) origin as the identity provider", () => {
		expect(safeIdp("https://idp.example.org")).toBe("https://idp.example.org");
		expect(safeIdp("http://127.0.0.1:9091")).toBe("http://127.0.0.1:9091");
		for (const v of [
			"http://idp.example.org",
			"https://idp.example.org/x",
			"https://u:p@idp.example.org",
			"javascript:1",
			"file:///etc",
			5,
			undefined,
		]) {
			expect(safeIdp(v), String(v)).toBeUndefined();
		}
	});

	it("falls back to the server's own origin when the file's idp is bad", () => {
		const dir = mkdtempSync(join(tmpdir(), "cfg-"));
		writeFileSync(
			join(dir, "config.json"),
			JSON.stringify({
				server: { address: "https://c.example.org/chat", idp: "https://evil.example/x", name: "C" },
			})
		);
		expect(loadConfig(dir).server?.idp).toBe("https://c.example.org");
	});
});
