import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ObjectId } from "mongodb";
import { ChildLocalTransport, machine, resetMachine } from "./testing/childLocalTransport";
import type { MessageUpdate } from "$lib/types/MessageUpdate";

const rows = vi.hoisted(() => ({ inserted: [] as { conversationId: ObjectId }[] }));

vi.mock("./elicitationConfig", () => ({
	isElicitationEnabled: () => true,
	getElicitationTimeoutMs: () => 30_000,
}));
// The prompt is recorded and answered at once; what is under test is whom it was raised for.
vi.mock("$lib/server/database", () => ({
	collections: {
		mcpElicitations: {
			insertOne: async (row: { conversationId: ObjectId }) => void rows.inserted.push(row),
			findOne: async () => ({ status: "resolved", action: "accept", content: { x: "1" } }),
			updateOne: async () => ({ matchedCount: 1 }),
		},
	},
}));
// The server's own entry is known and stable; era memory is covered in localEra.spec.ts.
vi.mock("./local", () => ({ localServerFingerprint: () => "entry" }));
vi.mock("./localTransport", () => ({
	createLocalTransport: async () => new ChildLocalTransport(),
}));

const { getAttributableClient, drainPool } = await import("./clientPool");
const { callMcpTool } = await import("./httpClient");
const { localServerUrl } = await import("./localUrl");
const { rememberLocalEra, resetLocalEras } = await import("./localEra");

const server = {
	name: "mail · on laptop",
	url: localServerUrl(new ObjectId().toString(), new ObjectId().toString(), "mail"),
};

function conversation() {
	const updates: MessageUpdate[] = [];
	return {
		updates,
		sink: { conversationId: new ObjectId(), emit: (u: MessageUpdate) => void updates.push(u) },
	};
}

// Connects (the pool's on-demand imports are mocked, and the mock registry does not take
// concurrent first imports), so the calls a test then overlaps meet a connection already there.
const warm = () => call(conversation(), "echo");

const call = (c: ReturnType<typeof conversation>, tool: string, args: unknown = {}) =>
	callMcpTool(server, tool, args, { elicitation: { sink: c.sink, toolUuid: `t-${tool}` } });

describe("conversations sharing a local server", () => {
	beforeEach(() => {
		resetMachine();
		resetLocalEras();
		rows.inserted.length = 0;
		// Known to be legacy: no probe wait, and the era the prompt routing has to handle.
		rememberLocalEra(server.url, "legacy", "entry");
	});
	afterEach(drainPool);

	it("use the one connection: a second conversation's call opens no new server process", async () => {
		const a = conversation();
		const b = conversation();
		await call(a, "echo", { who: "a" });
		expect(machine.opens).toBe(1);
		const second = await call(b, "echo", { who: "b" });
		expect(second.text).toContain('"who":"b"');
		expect(machine.opens).toBe(1);

		const one = await getAttributableClient(server, a.sink.conversationId.toString());
		const two = await getAttributableClient(server, b.sink.conversationId.toString());
		expect(two.client).toBe(one.client);
		expect(one.isolation).toBeUndefined();
	}, 20_000);

	it("route a legacy server's prompt to the conversation whose call is running", async () => {
		const a = conversation();
		const result = await call(a, "ask");
		expect(result.text).toContain('"answer":"accept"');
		expect(rows.inserted.map((r) => r.conversationId)).toEqual([a.sink.conversationId]);
		expect(a.updates.some((u) => u.type === "elicitation")).toBe(true);
	}, 20_000);

	it("serialize calls of different conversations, so each prompt still has one owner", async () => {
		const a = conversation();
		const b = conversation();
		const c = conversation();
		await warm();
		// All three prompt mid-call at the same time, were they allowed to run together.
		const results = await Promise.all([
			call(a, "ask", { delayMs: 200 }),
			call(b, "ask", { delayMs: 200 }),
			call(c, "ask", { delayMs: 200 }),
		]);
		for (const result of results) expect(result.text).toContain('"answer":"accept"');
		// One prompt per conversation, each recorded against its own, none declined.
		expect(rows.inserted.map((r) => r.conversationId.toString()).sort()).toEqual(
			[a, b, c].map((x) => x.sink.conversationId.toString()).sort()
		);
		for (const x of [a, b, c]) {
			const mine = rows.inserted.filter((r) => r.conversationId.equals(x.sink.conversationId));
			expect(mine).toHaveLength(1);
			expect(x.updates.filter((u) => u.type === "elicitation")).toHaveLength(2); // request, resolved
		}
		expect(machine.opens).toBe(1);
	}, 20_000);

	it("let one conversation's own calls overlap", async () => {
		const a = conversation();
		await warm();
		const started = performance.now();
		await Promise.all([call(a, "ask", { delayMs: 600 }), call(a, "ask", { delayMs: 600 })]);
		// Overlapping (about 0.6 s) rather than queued (about 1.2 s).
		expect(performance.now() - started).toBeLessThan(1_100);
	}, 20_000);

	it("stop waiting for the connection when the call is cancelled", async () => {
		const a = conversation();
		const b = conversation();
		const first = call(a, "ask", { delayMs: 800 });
		await new Promise((r) => setTimeout(r, 100));
		const controller = new AbortController();
		const waiting = callMcpTool(
			server,
			"echo",
			{},
			{ signal: controller.signal, elicitation: { sink: b.sink, toolUuid: "t" } }
		);
		controller.abort(new Error("stopped"));
		await expect(waiting).rejects.toThrow("stopped");
		await first;
	}, 20_000);
});
