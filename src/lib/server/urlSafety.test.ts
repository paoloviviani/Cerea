import { describe, it, expect, afterEach, vi } from "vitest";
import dns from "node:dns";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { env } from "$env/dynamic/private";
import {
	assertSafeBrowserRequest,
	contentFetch,
	isValidUrl,
	mcpFetch,
	ssrfSafeFetch,
} from "./urlSafety";

describe("isValidUrl", () => {
	it("allows normal HTTPS URLs", () => {
		expect(isValidUrl("https://example.com")).toBe(true);
		expect(isValidUrl("https://huggingface.co/docs")).toBe(true);
	});

	it("rejects HTTP URLs", () => {
		expect(isValidUrl("http://example.com")).toBe(false);
		expect(isValidUrl("http://169.254.170.23/v1/credentials")).toBe(false);
	});

	it("rejects localhost", () => {
		expect(isValidUrl("https://localhost")).toBe(false);
		expect(isValidUrl("https://localhost:3000")).toBe(false);
	});

	it("rejects private/internal IPs", () => {
		expect(isValidUrl("https://127.0.0.1")).toBe(false);
		expect(isValidUrl("https://192.168.1.1")).toBe(false);
		expect(isValidUrl("https://172.16.0.1")).toBe(false);
		expect(isValidUrl("https://169.254.170.23")).toBe(false);
	});

	it("allows 10.0.0.0/8 (used by internal LBs in cluster)", () => {
		expect(isValidUrl("https://10.0.0.1")).toBe(true);
		expect(isValidUrl("https://10.0.240.151")).toBe(true);
	});

	it("rejects non-URL strings", () => {
		expect(isValidUrl("not-a-url")).toBe(false);
		expect(isValidUrl("")).toBe(false);
		expect(isValidUrl("ftp://example.com")).toBe(false);
	});

	// The URL parser canonicalises `::ffff:127.0.0.1` to its hex form `::ffff:7f00:1`, which
	// ip-address's `is4()` does not recognise — so every mapped address used to slip through.
	it("rejects IPv4-mapped IPv6 addresses in either textual form", () => {
		expect(isValidUrl("https://[::ffff:127.0.0.1]")).toBe(false);
		expect(isValidUrl("https://[::ffff:7f00:1]")).toBe(false);
		expect(isValidUrl("https://[::ffff:169.254.169.254]")).toBe(false);
		expect(isValidUrl("https://[::ffff:a9fe:a9fe]")).toBe(false);
	});

	it("rejects IPv6 loopback, link-local and unspecified addresses", () => {
		expect(isValidUrl("https://[::1]")).toBe(false);
		expect(isValidUrl("https://[fe80::1]")).toBe(false);
		expect(isValidUrl("https://[::]")).toBe(false);
	});

	// Unique local addresses are the IPv6 counterpart of 192.168/172.16 (which we block);
	// unlike 10.0.0.0/8, no internal infra depends on them.
	it("rejects IPv6 unique local addresses (fc00::/7)", () => {
		expect(isValidUrl("https://[fc00::1]")).toBe(false);
		expect(isValidUrl("https://[fd12:3456::1]")).toBe(false);
	});

	it("rejects obfuscated IPv4 notations", () => {
		// The URL parser normalises all of these to 127.0.0.1.
		expect(isValidUrl("https://2130706433")).toBe(false);
		expect(isValidUrl("https://0177.0.0.1")).toBe(false);
		expect(isValidUrl("https://127.1")).toBe(false);
	});

	it("still allows IPv4-mapped public addresses", () => {
		expect(isValidUrl("https://[::ffff:8.8.8.8]")).toBe(true);
	});
});

describe("ssrfSafeFetch", () => {
	// undici only calls the agent's `lookup` hook for hosts needing DNS resolution, so IP
	// literals reached the network without any safety check until the host was validated
	// up-front. These must fail closed before a connection is attempted.
	it.each([
		["IPv4 loopback", "http://127.0.0.1:9911/"],
		["IPv6 loopback", "http://[::1]:9911/"],
		["IPv4-mapped loopback", "http://[::ffff:7f00:1]:9911/"],
		["link-local metadata endpoint", "http://169.254.169.254/latest/meta-data/"],
		["unspecified IPv4", "http://0.0.0.0:9911/"],
		["unspecified IPv6", "http://[::]:9911/"],
		["IPv6 unique local address", "http://[fd12:3456::1]:9911/"],
		["obfuscated decimal loopback", "http://2130706433:9911/"],
	])("blocks %s", async (_label, url) => {
		await expect(ssrfSafeFetch(url)).rejects.toThrow(/unsafe IP \(SSRF\)/);
	});

	it("blocks unsafe literals regardless of the caller's redirect mode", async () => {
		await expect(ssrfSafeFetch("http://127.0.0.1:9911/", { redirect: "manual" })).rejects.toThrow(
			/unsafe IP \(SSRF\)/
		);
		await expect(ssrfSafeFetch("http://127.0.0.1:9911/", { redirect: "error" })).rejects.toThrow(
			/unsafe IP \(SSRF\)/
		);
	});

	it("does not reject hostnames at the literal check", async () => {
		// `.invalid` never resolves (RFC 2606), so this fails at DNS — but it must not be
		// rejected by the IP-literal guard, which would mean we over-block real hostnames.
		await expect(ssrfSafeFetch("https://nonexistent.invalid/")).rejects.not.toThrow(
			/unsafe IP \(SSRF\)/
		);
	});
});

describe("isValidUrl with the MCP_ALLOW_INSECURE_URLS escape hatch", () => {
	const LOCAL_MCP = "http://127.0.0.1:8789/mcp";
	const original = env.MCP_ALLOW_INSECURE_URLS;

	afterEach(() => {
		env.MCP_ALLOW_INSECURE_URLS = original;
	});

	it("stays strict when the flag is unset, even for callers that opt in", () => {
		expect(env.MCP_ALLOW_INSECURE_URLS).toBeFalsy();
		expect(isValidUrl(LOCAL_MCP, { allowInsecure: true })).toBe(false);
		expect(isValidUrl("https://localhost:3000", { allowInsecure: true })).toBe(false);
		expect(isValidUrl("https://192.168.1.1", { allowInsecure: true })).toBe(false);
	});

	it("only honours the literal string 'true'", () => {
		for (const value of ["1", "yes", "TRUE", ""]) {
			env.MCP_ALLOW_INSECURE_URLS = value;
			expect(isValidUrl(LOCAL_MCP, { allowInsecure: true })).toBe(false);
		}
	});

	it("allows http, localhost and private ranges for opted-in callers when set", () => {
		env.MCP_ALLOW_INSECURE_URLS = "true";
		expect(isValidUrl(LOCAL_MCP, { allowInsecure: true })).toBe(true);
		expect(isValidUrl("http://localhost:8789/mcp", { allowInsecure: true })).toBe(true);
		expect(isValidUrl("https://192.168.1.1", { allowInsecure: true })).toBe(true);
		expect(isValidUrl("http://[::1]:8789/mcp", { allowInsecure: true })).toBe(true);
		expect(isValidUrl("http://10.0.0.1:8789/mcp", { allowInsecure: true })).toBe(true);
		expect(isValidUrl("http://172.16.0.1:8789/mcp", { allowInsecure: true })).toBe(true);
	});

	it("keeps public hosts on the strict path when set", () => {
		env.MCP_ALLOW_INSECURE_URLS = "true";
		expect(isValidUrl("http://example.com/mcp", { allowInsecure: true })).toBe(false);
		expect(isValidUrl("http://mcp.exa.ai/mcp", { allowInsecure: true })).toBe(false);
		// Unchanged by the flag, not granted by it.
		expect(isValidUrl("https://example.com/mcp", { allowInsecure: true })).toBe(true);
	});

	it("keeps link-local and 0.0.0.0/8 blocked when set, over either scheme", () => {
		env.MCP_ALLOW_INSECURE_URLS = "true";
		expect(isValidUrl("http://169.254.169.254/latest/meta-data/", { allowInsecure: true })).toBe(
			false
		);
		expect(isValidUrl("https://169.254.170.23/v1/credentials", { allowInsecure: true })).toBe(
			false
		);
		expect(isValidUrl("http://[fe80::1]/mcp", { allowInsecure: true })).toBe(false);
		expect(isValidUrl("http://0.0.0.0:8789/mcp", { allowInsecure: true })).toBe(false);
	});

	it("lets a local MCP server on a mesh VPN (100.64.0.0/10) use http when set", () => {
		env.MCP_ALLOW_INSECURE_URLS = "true";
		expect(isValidUrl("http://100.124.156.101:8789/mcp", { allowInsecure: true })).toBe(true);
		// Without the flag, https to it is allowed and http is not.
		env.MCP_ALLOW_INSECURE_URLS = "";
		expect(isValidUrl("http://100.124.156.101:8789/mcp", { allowInsecure: true })).toBe(false);
		expect(isValidUrl("https://100.124.156.101/mcp", { allowInsecure: true })).toBe(true);
	});

	it("leaves callers that do not opt in strict even when set", () => {
		env.MCP_ALLOW_INSECURE_URLS = "true";
		expect(isValidUrl(LOCAL_MCP)).toBe(false);
		expect(isValidUrl("http://example.com")).toBe(false);
		expect(isValidUrl("https://localhost:3000")).toBe(false);
		expect(isValidUrl("https://169.254.170.23")).toBe(false);
	});

	it("still rejects non-http(s) schemes and junk when set", () => {
		env.MCP_ALLOW_INSECURE_URLS = "true";
		expect(isValidUrl("ftp://127.0.0.1", { allowInsecure: true })).toBe(false);
		expect(isValidUrl("file:///etc/passwd", { allowInsecure: true })).toBe(false);
		expect(isValidUrl("not-a-url", { allowInsecure: true })).toBe(false);
		expect(isValidUrl("", { allowInsecure: true })).toBe(false);
	});
});

describe("isValidUrl with MCP_INTERNAL_HOSTS (named compose-network hosts)", () => {
	const originalHosts = env.MCP_INTERNAL_HOSTS;
	const originalFlag = env.MCP_ALLOW_INSECURE_URLS;
	afterEach(() => {
		env.MCP_INTERNAL_HOSTS = originalHosts;
		env.MCP_ALLOW_INSECURE_URLS = originalFlag;
	});

	it("refuses http to a service name until it is named", () => {
		env.MCP_ALLOW_INSECURE_URLS = "true";
		env.MCP_INTERNAL_HOSTS = "";
		expect(isValidUrl("http://mcp-search:8096/mcp", { allowInsecure: true })).toBe(false);
	});

	it("allows exactly the named hosts over http, without MCP_ALLOW_INSECURE_URLS", () => {
		env.MCP_ALLOW_INSECURE_URLS = "";
		env.MCP_INTERNAL_HOSTS = "mcp-search, MCP-OSM";
		expect(isValidUrl("http://mcp-search:8096/mcp", { allowInsecure: true })).toBe(true);
		expect(isValidUrl("http://mcp-osm:8096/mcp", { allowInsecure: true })).toBe(true);
		// Exact names: no suffix, prefix or sibling matches.
		expect(isValidUrl("http://mcp-search.evil.com/mcp", { allowInsecure: true })).toBe(false);
		expect(isValidUrl("http://xmcp-search:8096/mcp", { allowInsecure: true })).toBe(false);
		expect(isValidUrl("http://mcp-other:8096/mcp", { allowInsecure: true })).toBe(false);
	});

	it("does not turn on for callers that do not opt in, nor widen to addresses", () => {
		env.MCP_INTERNAL_HOSTS = "mcp-search,10.0.0.1,localhost,169.254.169.254";
		expect(isValidUrl("http://mcp-search:8096/mcp")).toBe(false);
		expect(isValidUrl("http://mcp-search:8096/mcp", { blockInternalNetworks: true })).toBe(false);
		env.MCP_ALLOW_INSECURE_URLS = "";
		expect(isValidUrl("http://10.0.0.1:8096/mcp", { allowInsecure: true })).toBe(false);
		expect(isValidUrl("http://localhost:8096/mcp", { allowInsecure: true })).toBe(false);
		expect(isValidUrl("http://169.254.169.254/mcp", { allowInsecure: true })).toBe(false);
	});
});

describe("mcpFetch to a host named in MCP_INTERNAL_HOSTS", () => {
	const originalHosts = env.MCP_INTERNAL_HOSTS;
	const originalFlag = env.MCP_ALLOW_INSECURE_URLS;
	let resolveTo = "127.0.0.1";

	function serve() {
		const server = http.createServer((_req, res) => res.end("ok"));
		return new Promise<{ port: number; close: () => void }>((resolve) =>
			server.listen(0, "127.0.0.1", () =>
				resolve({ port: (server.address() as AddressInfo).port, close: () => server.close() })
			)
		);
	}

	function fakeDns() {
		// A compose service name does not resolve on a developer machine: point it at `resolveTo`.
		vi.spyOn(dns, "lookup").mockImplementation(((
			_host: string,
			options: { all?: boolean },
			cb: (...args: unknown[]) => void
		) => {
			if (options?.all) cb(null, [{ address: resolveTo, family: 4 }]);
			else cb(null, resolveTo, 4);
		}) as unknown as typeof dns.lookup);
	}

	afterEach(() => {
		vi.restoreAllMocks();
		resolveTo = "127.0.0.1";
		env.MCP_INTERNAL_HOSTS = originalHosts;
		env.MCP_ALLOW_INSECURE_URLS = originalFlag;
	});

	it("connects over http to a named host that resolves to a private address", async () => {
		env.MCP_ALLOW_INSECURE_URLS = "";
		env.MCP_INTERNAL_HOSTS = "mcp-test";
		fakeDns();
		const { port, close } = await serve();
		try {
			const res = await mcpFetch(`http://mcp-test:${port}/mcp`);
			expect(await res.text()).toBe("ok");
		} finally {
			close();
		}
	});

	it("refuses the same name when it is not listed", async () => {
		env.MCP_ALLOW_INSECURE_URLS = "";
		env.MCP_INTERNAL_HOSTS = "mcp-other";
		fakeDns();
		const { port, close } = await serve();
		try {
			await expect(mcpFetch(`http://mcp-test:${port}/mcp`)).rejects.toThrow();
		} finally {
			close();
		}
	});

	it("refuses a listed name that resolves to link-local or cloud metadata", async () => {
		env.MCP_INTERNAL_HOSTS = "mcp-test";
		fakeDns();
		for (const address of ["169.254.169.254", "100.100.100.200", "0.0.0.0"]) {
			resolveTo = address;
			// undici wraps the lookup's refusal as the `cause` of "fetch failed".
			const error = await mcpFetch("http://mcp-test:8096/mcp").catch((e) => e);
			expect(String((error as Error).cause)).toMatch(/is internal/);
		}
	});
});

describe("content fetching refuses the internal networks (10/8, 100.64/10)", () => {
	const original = env.CHAT_FETCH_ALLOW_INTERNAL_NETWORKS;
	afterEach(() => {
		env.CHAT_FETCH_ALLOW_INTERNAL_NETWORKS = original;
	});

	it("rejects a 10.x literal for web_fetch and attach-from-URL, but not by default", () => {
		expect(isValidUrl("https://10.1.2.3/doc", { blockInternalNetworks: true })).toBe(false);
		expect(isValidUrl("https://[::ffff:10.1.2.3]/doc", { blockInternalNetworks: true })).toBe(
			false
		);
		// Mesh VPN addresses (Tailscale, NetBird): carrier-grade NAT, 100.64.0.0/10.
		expect(isValidUrl("https://100.124.156.101/doc", { blockInternalNetworks: true })).toBe(false);
		// The shared check (MCP connectors) lets both through.
		expect(isValidUrl("https://10.1.2.3/doc")).toBe(true);
		expect(isValidUrl("https://100.124.156.101/mcp")).toBe(true);
	});

	it("blocks a 10.x literal before connecting", async () => {
		await expect(contentFetch("https://10.1.2.3:9911/")).rejects.toThrow(/unsafe IP \(SSRF\)/);
	});

	it("blocks a mesh VPN literal before connecting", async () => {
		await expect(contentFetch("https://100.100.1.1:9911/")).rejects.toThrow(/unsafe IP \(SSRF\)/);
	});

	it("keeps Alibaba Cloud's metadata address blocked everywhere, MCP included", () => {
		expect(isValidUrl("https://100.100.100.200/latest/meta-data/")).toBe(false);
		expect(isValidUrl("https://[::ffff:100.100.100.200]/")).toBe(false);
		env.MCP_ALLOW_INSECURE_URLS = "true";
		expect(isValidUrl("http://100.100.100.200/latest/meta-data/", { allowInsecure: true })).toBe(
			false
		);
		env.MCP_ALLOW_INSECURE_URLS = "";
		env.CHAT_FETCH_ALLOW_INTERNAL_NETWORKS = "true";
		expect(isValidUrl("https://100.100.100.200/", { blockInternalNetworks: true })).toBe(false);
	});

	it("blocks the metadata address before connecting, for MCP transports too", async () => {
		await expect(mcpFetch("https://100.100.100.200:9911/")).rejects.toThrow(/unsafe IP \(SSRF\)/);
	});

	it("still refuses addresses just outside the mesh range", () => {
		expect(isValidUrl("https://100.128.0.1/")).toBe(true);
		expect(isValidUrl("https://100.63.255.255/")).toBe(true);
	});

	it("leaves MCP transports able to reach 10.x", async () => {
		// Not refused by the guard: it fails later, on the network, or not at all.
		await expect(
			mcpFetch("https://10.255.255.1:9/", { signal: AbortSignal.timeout(300) })
		).rejects.not.toThrow(/unsafe IP \(SSRF\)/);
	});

	it("can be switched back off for a deployment that fetches from 10.x hosts", () => {
		env.CHAT_FETCH_ALLOW_INTERNAL_NETWORKS = "true";
		expect(isValidUrl("https://10.1.2.3/doc", { blockInternalNetworks: true })).toBe(true);
	});

	it("never relaxes the other private ranges", () => {
		env.CHAT_FETCH_ALLOW_INTERNAL_NETWORKS = "true";
		expect(isValidUrl("https://192.168.1.1/", { blockInternalNetworks: true })).toBe(false);
		expect(isValidUrl("https://169.254.169.254/", { blockInternalNetworks: true })).toBe(false);
	});
});

describe("assertSafeBrowserRequest", () => {
	const original = env.CHAT_FETCH_ALLOW_INTERNAL_NETWORKS;
	afterEach(() => {
		env.CHAT_FETCH_ALLOW_INTERNAL_NETWORKS = original;
	});

	it("refuses internal literals, localhost and 10/8", async () => {
		for (const u of [
			"http://127.0.0.1/",
			"https://[::1]/",
			"http://localhost:3000/",
			"http://169.254.169.254/",
			"https://10.1.2.3/",
			"https://[::ffff:7f00:1]/",
		]) {
			await expect(assertSafeBrowserRequest(u), u).rejects.toThrow();
		}
	});

	it("refuses unsupported schemes and lets data: through", async () => {
		await expect(assertSafeBrowserRequest("file:///etc/passwd")).rejects.toThrow();
		await expect(assertSafeBrowserRequest("data:text/plain,hi")).resolves.toBeUndefined();
	});

	it("honours CHAT_FETCH_ALLOW_INTERNAL_NETWORKS for 10/8 only", async () => {
		env.CHAT_FETCH_ALLOW_INTERNAL_NETWORKS = "true";
		await expect(assertSafeBrowserRequest("https://10.1.2.3/")).resolves.toBeUndefined();
		await expect(assertSafeBrowserRequest("http://127.0.0.1/")).rejects.toThrow();
	});
});
