import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { dedupeLog, mcpSummary, signInState, toolsInfo } from "../src/main/galopinInfo.ts";

describe("coding tools", () => {
	it("finds each tool on PATH, ignores galopin's own shims, and sees a default shim", () => {
		const present = new Set([
			"/usr/bin/claude",
			"/opt/shims/galopin-shims/opencode",
			"/opt/shims/galopin-shims/claude",
		]);
		const t = toolsInfo({
			path: ["/opt/shims/galopin-shims", "/usr/bin"].join(":"),
			home: "/home/u",
			installDir: "/opt/shims",
			exists: (p) => present.has(p),
		});
		const by = Object.fromEntries(t.map((x) => [x.tool, x]));
		expect(by.claude).toMatchObject({ installed: true, byDefault: true, label: "Claude Code" });
		// the opencode shim is on PATH but is not the tool: opencode is not installed
		expect(by.opencode).toMatchObject({ installed: false, byDefault: true });
		expect(by.goose).toMatchObject({ installed: false, byDefault: false });
		expect(by.vibe.label).toBe("Vibe");
	});

	it("also looks in ~/.opencode/bin", () => {
		const t = toolsInfo({
			path: "/usr/bin",
			home: "/home/u",
			installDir: "/x",
			exists: (p) => p === "/home/u/.opencode/bin/opencode",
		});
		expect(t.find((x) => x.tool === "opencode")!.installed).toBe(true);
	});
});

describe("connectors and the browser", () => {
	it("counts connectors without the browser entry", () => {
		const d = mkdtempSync(join(tmpdir(), "mcp-"));
		const f = join(d, "mcp.json");
		expect(mcpSummary(f)).toEqual({ connectors: 0, browser: false });
		writeFileSync(f, JSON.stringify({ mcpServers: { notes: {}, "cerea-browser": {}, files: {} } }));
		expect(mcpSummary(f)).toEqual({ connectors: 2, browser: true });
		writeFileSync(f, "{bad");
		expect(mcpSummary(f)).toEqual({ connectors: 0, browser: false });
		mkdirSync(join(d, "x"));
	});
});

describe("sign-in state and the log", () => {
	const expired =
		"link: disconnected (getting access token: This machine's sign-in to the gateway expired or was revoked (invalid_grant). Sign in again with 'galopin auth login'); reconnecting in 25s";
	it("is expired when the newest word about it is the gateway's refusal, and ok again once it connects", () => {
		expect(signInState([])).toBe("ok");
		expect(signInState(["$ galopin run", expired])).toBe("expired");
		expect(signInState([expired, "link: connected to https://x"])).toBe("ok");
		expect(signInState(["link: connected", expired, expired.replace("25s", "50s")])).toBe(
			"expired"
		);
	});

	it("shows a repeated line once with a count, whatever the number in it", () => {
		const out = dedupeLog([
			expired,
			expired.replace("25s", "50s"),
			expired.replace("25s", "100s"),
			"link: connected",
			expired,
		]);
		expect(out).toHaveLength(3);
		expect(out[0].count).toBe(3);
		expect(out[0].text).toContain("100s");
		expect(out[1]).toEqual({ text: "link: connected", count: 1 });
		expect(out[2].count).toBe(1);
	});
});
