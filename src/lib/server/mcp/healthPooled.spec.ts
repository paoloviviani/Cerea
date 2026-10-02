import { describe, it, expect, vi, beforeEach } from "vitest";

const built = vi.hoisted(() => ({
	clients: [] as { closed: boolean; listed: number }[],
}));

vi.mock("$lib/server/mcp/client", () => ({
	createMcpClient: () => {
		const client = {
			closed: false,
			listed: 0,
			async connect() {},
			async listTools() {
				this.listed++;
				return { tools: [{ name: "t", description: "d" }] };
			},
			async close() {
				this.closed = true;
			},
		};
		built.clients.push(client);
		return client;
	},
}));
vi.mock("@modelcontextprotocol/client", () => ({
	StreamableHTTPClientTransport: class {
		constructor(public url: unknown) {}
	},
	SSEClientTransport: class {
		constructor(public url: unknown) {}
	},
}));
vi.mock("$lib/server/urlSafety", () => ({ mcpFetch: () => Promise.resolve(new Response()) }));

const { listTools } = await import("$lib/server/mcp/health");

describe("pooled health listings", () => {
	beforeEach(() => {
		built.clients.length = 0;
	});

	it("reuses one connection across repeat checks instead of reconnecting", async () => {
		const server = { url: "https://pooled-health.example/mcp", headers: { Authorization: "tok" } };
		const first = await listTools(server.url, server.headers);
		const second = await listTools(server.url, server.headers);
		expect(first.ok).toBe(true);
		expect(second.ok).toBe(true);
		expect(built.clients).toHaveLength(1);
		expect(built.clients[0].listed).toBe(2);
		expect(built.clients[0].closed).toBe(false);
	});

	it("never shares a connection across different credentials", async () => {
		await listTools("https://pooled-health.example/mcp", { Authorization: "tok-a" });
		await listTools("https://pooled-health.example/mcp", { Authorization: "tok-b" });
		expect(built.clients).toHaveLength(2);
	});
});
