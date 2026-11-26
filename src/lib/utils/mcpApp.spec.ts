import { describe, it, expect } from "vitest";
import {
	MCP_APP_SANDBOX,
	buildMcpAppCsp,
	buildMcpAppSrcdoc,
	cleanDomains,
	coversOwnOrigin,
	isMcpAppMime,
	isUiResourceUri,
	readToolUiMeta,
	sanitizeAppCsp,
	visibleToApp,
	visibleToModel,
} from "./mcpApp";

describe("the tool's link to a page", () => {
	it("reads _meta.ui.resourceUri and visibility", () => {
		expect(
			readToolUiMeta({
				ui: { resourceUri: "ui://weather/dashboard", visibility: ["model", "app"] },
			})
		).toEqual({ resourceUri: "ui://weather/dashboard", visibility: ["model", "app"] });
	});

	it("still reads the deprecated flat key", () => {
		expect(readToolUiMeta({ "ui/resourceUri": "ui://weather/old" })).toEqual({
			resourceUri: "ui://weather/old",
		});
	});

	it("treats anything malformed as absent", () => {
		expect(readToolUiMeta(undefined)).toBeUndefined();
		expect(readToolUiMeta({ ui: { resourceUri: "https://evil.example/page" } })).toBeUndefined();
		expect(readToolUiMeta({ ui: { resourceUri: 5 } })).toBeUndefined();
		expect(readToolUiMeta({ ui: "x" })).toBeUndefined();
		expect(isUiResourceUri("ui://x/y")).toBe(true);
		expect(isUiResourceUri("ui://")).toBe(false);
		expect(isUiResourceUri("javascript:alert(1)")).toBe(false);
	});

	it("keeps an app-only tool away from the model, and a model-only tool away from pages", () => {
		const appOnly = readToolUiMeta({ ui: { visibility: ["app"] } });
		const modelOnly = readToolUiMeta({ ui: { visibility: ["model"] } });
		expect(visibleToModel(appOnly)).toBe(false);
		expect(visibleToApp(appOnly)).toBe(true);
		expect(visibleToModel(modelOnly)).toBe(true);
		expect(visibleToApp(modelOnly)).toBe(false);
		// Absent means both.
		expect(visibleToModel(undefined)).toBe(true);
		expect(visibleToApp(undefined)).toBe(true);
	});
});

describe("the page's MIME type", () => {
	it("accepts text/html;profile=mcp-app and nothing else", () => {
		expect(isMcpAppMime("text/html;profile=mcp-app")).toBe(true);
		expect(isMcpAppMime("text/html; profile=mcp-app")).toBe(true);
		expect(isMcpAppMime('Text/HTML;Profile="mcp-app"')).toBe(true);
		expect(isMcpAppMime("text/html")).toBe(false);
		expect(isMcpAppMime("text/html;profile=other")).toBe(false);
		expect(isMcpAppMime("application/json")).toBe(false);
		expect(isMcpAppMime(undefined)).toBe(false);
	});
});

describe("declared domains", () => {
	it("keeps https and wss origins, with a wildcard first label and a port", () => {
		const { kept, dropped } = cleanDomains([
			"https://api.example.com",
			"https://*.cdn.example.com",
			"wss://live.example.com:8443",
			"https://api.example.com",
		]);
		expect(kept).toEqual([
			"https://api.example.com",
			"https://*.cdn.example.com",
			"wss://live.example.com:8443",
		]);
		expect(dropped).toEqual([]);
	});

	it("drops anything that could change the policy rather than name a host", () => {
		const bad = [
			"*",
			"https://*",
			"https://*.com",
			"http://example.com",
			"https:",
			"'unsafe-eval'",
			"data:",
			"blob:",
			"https://a.example.com; script-src *",
			"https://a.example.com b.example.com",
			"https://a.example.com/path",
			"https://a.example.com,https://b.example.com",
			"https://exa'mple.com",
			"https://localhost",
			"javascript:alert(1)",
			"",
			42,
		];
		const { kept, dropped } = cleanDomains(bad);
		expect(kept).toEqual([]);
		expect(dropped).toHaveLength(bad.length);
	});
});

describe("the page's CSP", () => {
	it("is the spec's strict default when nothing is declared", () => {
		const csp = buildMcpAppCsp(undefined);
		expect(csp).toContain("default-src 'none'");
		expect(csp).toContain("script-src 'unsafe-inline';");
		expect(csp).toContain("connect-src 'none'");
		expect(csp).toContain("frame-src 'none'");
		expect(csp).toContain("object-src 'none'");
		expect(csp).toContain("base-uri 'none'");
		expect(csp).toContain("form-action 'none'");
		expect(csp).not.toContain("unsafe-eval");
	});

	it("is built from the declared domains, each directive from its own list", () => {
		const csp = buildMcpAppCsp({
			connectDomains: ["https://api.example.com"],
			resourceDomains: ["https://cdn.example.com"],
			frameDomains: ["https://www.youtube.com"],
			baseUriDomains: ["https://base.example.com"],
		});
		expect(csp).toContain("connect-src https://api.example.com;");
		expect(csp).toContain("script-src 'unsafe-inline' https://cdn.example.com;");
		expect(csp).toContain("style-src 'unsafe-inline' https://cdn.example.com;");
		expect(csp).toContain("img-src data: https://cdn.example.com;");
		expect(csp).toContain("font-src data: https://cdn.example.com;");
		expect(csp).toContain("frame-src https://www.youtube.com;");
		expect(csp).toContain("base-uri https://base.example.com;");
		// A resource domain does not open the network for fetch.
		expect(csp).not.toMatch(/connect-src[^;]*cdn\.example\.com/);
	});

	it("validates again when it builds, so a stored value that was not clean never reaches a header", () => {
		const csp = buildMcpAppCsp({
			connectDomains: ["https://ok.example.com", "https://x.example.com; default-src *"],
		});
		expect(csp).toContain("connect-src https://ok.example.com;");
		expect(csp).not.toContain("default-src *");
	});

	it("reports what the sanitizer dropped for the audit log", () => {
		const { csp, dropped } = sanitizeAppCsp({
			connectDomains: ["https://ok.example.com", "ftp://bad.example.com"],
			unknownKey: ["https://x.example.com"],
		});
		expect(csp).toEqual({ connectDomains: ["https://ok.example.com"] });
		expect(dropped).toEqual(["ftp://bad.example.com"]);
	});
});

describe("the page's document and sandbox", () => {
	it("puts the policy first and the page's markup after it", () => {
		const doc = buildMcpAppSrcdoc("<!doctype html><html><head><script>1</script></head></html>", {
			connectDomains: ["https://api.example.com"],
		});
		expect(
			doc.startsWith('<!doctype html><html><head><meta http-equiv="Content-Security-Policy"')
		).toBe(true);
		expect(doc.indexOf("Content-Security-Policy")).toBeLessThan(doc.indexOf("<script>"));
		expect(doc).toContain("connect-src https://api.example.com;");
	});

	it("runs the diagnostics shim right after the policy and before the page's markup", () => {
		const doc = buildMcpAppSrcdoc("<!doctype html><html><head><script>1</script></head></html>");
		const shim = doc.indexOf("cereaDiag");
		expect(doc.indexOf("Content-Security-Policy")).toBeLessThan(shim);
		expect(shim).toBeLessThan(doc.indexOf("<script>1</script>"));
		// It listens for all three, and reports with its own namespaced message, not a bridge request.
		for (const word of [
			"error",
			"unhandledrejection",
			"securitypolicyviolation",
			"violatedDirective",
		]) {
			expect(doc).toContain(word);
		}
		expect(doc).not.toContain("jsonrpc");
		// Inline scripts are allowed by the policy it is sent with.
		expect(doc).toContain("script-src 'unsafe-inline'");
	});

	it("never lets the policy's own attribute be closed by its content", () => {
		const doc = buildMcpAppSrcdoc("<p>x</p>");
		const meta = doc.match(/<meta[^>]*>/)?.[0] ?? "";
		expect(meta.match(/"/g)).toHaveLength(4);
	});

	it("is sandboxed for scripts only and never for same-origin, popups, downloads or modals", () => {
		const tokens = MCP_APP_SANDBOX.split(/\s+/);
		expect(tokens).toEqual(["allow-scripts"]);
	});
});

describe("Cerea's own origin", () => {
	const own = ["https://chat.example.com"];

	it("is never handed to a page, not by name and not by a wildcard that covers it", () => {
		const { kept, dropped } = cleanDomains(
			[
				"https://chat.example.com",
				"wss://chat.example.com",
				"https://*.example.com",
				"https://api.other.com",
			],
			{ ownOrigins: own }
		);
		expect(kept).toEqual(["https://api.other.com"]);
		expect(dropped).toHaveLength(3);
	});

	it("matches the port, so another port of the same host is a different origin", () => {
		expect(
			coversOwnOrigin("https://chat.example.com:8443", ["https://chat.example.com:9443"])
		).toBe(false);
		expect(
			coversOwnOrigin("https://chat.example.com:8443", ["https://chat.example.com:8443"])
		).toBe(true);
		expect(coversOwnOrigin("https://chat.example.com", ["https://chat.example.com"])).toBe(true);
	});

	it("is dropped from the built policy too", () => {
		const csp = buildMcpAppCsp(
			{ connectDomains: ["https://chat.example.com", "https://api.other.com"] },
			{ ownOrigins: own }
		);
		expect(csp).toContain("connect-src https://api.other.com;");
		expect(csp).not.toContain("chat.example.com");
	});
});
