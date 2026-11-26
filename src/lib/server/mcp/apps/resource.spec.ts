import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
	read: vi.fn(),
	list: vi.fn(),
	allowed: vi.fn(async () => true),
	tools: [{ name: "show", ui: { resourceUri: "ui://maps/view" } }] as Array<
		Record<string, unknown>
	>,
	connectors: [] as Array<{
		key: string;
		name: string;
		open: () => Promise<unknown>;
	}>,
}));

vi.mock("../clientPool", () => ({
	getClient: vi.fn(async () => ({ readResource: fake.read, listResources: fake.list })),
	retainClient: vi.fn(),
	releaseClient: vi.fn(),
}));
vi.mock("../tools", () => ({
	listMcpServerTools: vi.fn(async () => fake.tools),
}));
vi.mock("../turnConnectors", () => ({
	resolveConnectors: vi.fn(async () => ({ connectors: fake.connectors, blocked: [] })),
}));
vi.mock("../appsPolicy", () => ({ appsAllowedFor: fake.allowed }));
vi.mock("$lib/server/logger", () => ({
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { readUiResource: read, McpAppError, resetUiResourceCache } = await import("./resource");
const userId = new (await import("mongodb")).ObjectId();
const readUiResource = (c: Parameters<typeof read>[0], uri: string) => read(c, uri, { userId });
const { MAX_APP_HTML_BYTES } = await import("$lib/utils/mcpApp");

const MIME = "text/html;profile=mcp-app";
const URI = "ui://maps/view";
const server = { key: "connector:1", name: "Maps", url: "https://maps.example/mcp" };
const page = (extra: Record<string, unknown> = {}) => ({
	contents: [{ uri: URI, mimeType: MIME, text: "<!doctype html><p>hi</p>", ...extra }],
});

async function codeOf(promise: Promise<unknown>) {
	try {
		await promise;
	} catch (err) {
		if (err instanceof McpAppError) return err.code;
		throw err;
	}
	return "no error";
}

beforeEach(() => {
	resetUiResourceCache();
	fake.read.mockReset();
	fake.list.mockReset();
	fake.list.mockResolvedValue({ resources: [] });
	fake.allowed.mockReset();
	fake.allowed.mockResolvedValue(true);
	fake.connectors = [];
});

describe("readUiResource", () => {
	it("reads the page with resources/read through the connector's own client", async () => {
		fake.read.mockResolvedValue(page());

		const resource = await readUiResource(server, URI);

		expect(fake.read).toHaveBeenCalledWith(
			{ uri: URI },
			expect.objectContaining({ timeout: expect.any(Number) })
		);
		expect(resource.html).toBe("<!doctype html><p>hi</p>");
		expect(resource.csp).toEqual({});
	});

	it("resolves a connector key for this user, as a turn does, so a local connector works the same way", async () => {
		fake.read.mockResolvedValue(page());
		const open = vi.fn(async () => ({
			server: { name: "Maps", url: server.url, headers: { a: "b" } },
		}));
		fake.connectors = [{ key: "connector:1", name: "Maps", open }];

		await readUiResource("connector:1", URI);

		expect(open).toHaveBeenCalled();
		expect(fake.allowed).toHaveBeenCalledWith("connector:1", userId);
	});

	it("refuses a connector the user cannot use", async () => {
		expect(await codeOf(readUiResource("connector:nope", URI))).toBe("unknown-connector");
		expect(fake.read).not.toHaveBeenCalled();
	});

	it("reads nothing when apps are not allowed for the connector", async () => {
		fake.allowed.mockResolvedValue(false);
		fake.connectors = [{ key: "connector:1", name: "Maps", open: async () => ({ server }) }];

		expect(await codeOf(readUiResource("connector:1", URI))).toBe("not-allowed");
		expect(await codeOf(readUiResource(server, URI))).toBe("not-allowed");
		expect(fake.read).not.toHaveBeenCalled();
	});

	it("reads only a page that a tool of the same connector names", async () => {
		fake.tools = [{ name: "show", ui: { resourceUri: "ui://maps/other" } }, { name: "plain" }];

		expect(await codeOf(readUiResource(server, URI))).toBe("bad-uri");
		expect(fake.read).not.toHaveBeenCalled();
		fake.tools = [{ name: "show", ui: { resourceUri: URI } }];
	});

	it("reads nothing without a signed-in user: the policy is per user", async () => {
		expect(await codeOf(read(server, URI))).toBe("not-allowed");
		expect(fake.read).not.toHaveBeenCalled();
	});

	it("refuses an address that is not ui://", async () => {
		expect(await codeOf(readUiResource(server, "https://evil.example/x"))).toBe("bad-uri");
		expect(fake.read).not.toHaveBeenCalled();
	});

	it("refuses a resource that is not an MCP App page", async () => {
		fake.read.mockResolvedValue(page({ mimeType: "text/html" }));
		expect(await codeOf(readUiResource(server, URI))).toBe("mime");
	});

	it("refuses a page over the size limit, as text and as a blob", async () => {
		fake.read.mockResolvedValue(page({ text: "a".repeat(MAX_APP_HTML_BYTES + 1) }));
		expect(await codeOf(readUiResource(server, URI))).toBe("size");

		resetUiResourceCache();
		fake.read.mockResolvedValue(
			page({ text: undefined, blob: Buffer.alloc(MAX_APP_HTML_BYTES + 10, 97).toString("base64") })
		);
		expect(await codeOf(readUiResource(server, URI))).toBe("size");
	});

	it("accepts a base64 blob", async () => {
		fake.read.mockResolvedValue(
			page({ text: undefined, blob: Buffer.from("<p>blob</p>").toString("base64") })
		);
		expect((await readUiResource(server, URI)).html).toBe("<p>blob</p>");
	});

	it("refuses an empty page and a failed read", async () => {
		fake.read.mockResolvedValue(page({ text: "  " }));
		expect(await codeOf(readUiResource(server, URI))).toBe("empty");

		resetUiResourceCache();
		fake.read.mockResolvedValue({ contents: [] });
		expect(await codeOf(readUiResource(server, URI))).toBe("empty");

		resetUiResourceCache();
		fake.read.mockRejectedValue(new Error("boom"));
		expect(await codeOf(readUiResource(server, URI))).toBe("unreadable");
	});

	it("takes the CSP from the content item, cleaned", async () => {
		fake.read.mockResolvedValue(
			page({
				_meta: {
					ui: {
						csp: {
							connectDomains: ["https://api.example.com", "https://x.example.com; default-src *"],
							resourceDomains: ["https://cdn.example.com"],
						},
						prefersBorder: false,
					},
				},
			})
		);

		const resource = await readUiResource(server, URI);

		expect(resource.csp).toEqual({
			connectDomains: ["https://api.example.com"],
			resourceDomains: ["https://cdn.example.com"],
		});
		expect(resource.dropped).toEqual(["https://x.example.com; default-src *"]);
		expect(resource.prefersBorder).toBe(false);
		// Declared on the content item: the listing is not asked.
		expect(fake.list).not.toHaveBeenCalled();
	});

	it("falls back to the listing entry's CSP when the content item declares none", async () => {
		fake.read.mockResolvedValue(page());
		fake.list.mockResolvedValue({
			resources: [
				{ uri: URI, _meta: { ui: { csp: { connectDomains: ["https://listed.example.com"] } } } },
			],
		});

		const resource = await readUiResource(server, URI);

		expect(resource.csp).toEqual({ connectDomains: ["https://listed.example.com"] });
	});

	it("does not fail the read because the listing failed", async () => {
		fake.read.mockResolvedValue(page());
		fake.list.mockRejectedValue(new Error("no listing"));
		expect((await readUiResource(server, URI)).csp).toEqual({});
	});
});
