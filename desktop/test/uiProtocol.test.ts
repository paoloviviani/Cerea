import { describe, expect, it } from "vitest";
import { resolveUiFile } from "../src/main/uiProtocol.ts";
import { readFileSync } from "node:fs";
import { UI_CSP } from "../src/main/navGuard.ts";

describe("app://ui", () => {
	const root = "/app/dist/renderer";
	it("serves the UI files and nothing outside the directory", () => {
		expect(resolveUiFile(root, "app://ui/")?.path).toBe("/app/dist/renderer/index.html");
		expect(resolveUiFile(root, "app://ui/ui.js")?.type).toMatch(/javascript/);
		for (const u of [
			"app://ui/a%5c..%5c..%5cx.js",
			"app://other/index.html",
			"file:///etc/passwd",
			"app://ui/secret.json",
			"app://ui/%00.js",
		]) {
			expect(resolveUiFile(root, u), u).toBeUndefined();
		}
	});

	it("neutralises dot segments: whatever they name stays under the directory", () => {
		for (const u of [
			"app://ui/../main/main.js",
			"app://ui/%2e%2e/%2e%2e/x.js",
			"app://ui/..%2f..%2fx.js",
		]) {
			const f = resolveUiFile(root, u);
			expect(f === undefined || f.path.startsWith(root + "/"), u).toBe(true);
		}
	});

	it("carries the same policy in its page as in its header", () => {
		const html = readFileSync(new URL("../src/renderer/index.html", import.meta.url), "utf8");
		const meta = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(html)?.[1];
		expect(meta).toBe(UI_CSP);
	});
});
