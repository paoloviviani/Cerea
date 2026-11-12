/** "Open browser": tying the page to a conversation, the lease, the deny list, and the next browse resuming it. */
import { describe, expect, it, vi } from "vitest";
import { ObjectId } from "mongodb";
import { FAKE_BROWSER_KEY, FakeBrowserRuntime, type FakePage } from "./fakeRuntime";
import { answerTurn, scriptedModel } from "./fakeModel";
import { memoryKeptStore } from "./kept";
import { memoryLeaseStore } from "./lease";
import { memoryChoiceStore } from "./machineChoice";
import { openBrowserPage, parseOpenUrl } from "./open";
import { createBrowseTool } from "$lib/server/textGeneration/builtinTools/browseTool";
import type { NestedAgentDeps } from "$lib/server/textGeneration/builtinTools/nestedAgent";

const pages = (): FakePage[] => [
	{
		id: "cart",
		url: "https://shop.example.com/cart",
		title: "Your cart",
		elements: [{ ref: "e1", role: "heading", name: "Cart" }],
	},
	{ id: "blank", url: "about:blank", title: "", elements: [] },
];
const laptop = { id: "a".repeat(24), name: "Laptop" };
const desk = { id: "b".repeat(24), name: "Desk" };
const userId = new ObjectId();
const conversationId = new ObjectId().toString();
const rules = { allow: [], deny: ["bank.example.org"] };

function setup() {
	const runtime = new FakeBrowserRuntime(pages());
	const kept = memoryKeptStore();
	const leases = memoryLeaseStore();
	const remembered: string[][] = [];
	const choice = memoryChoiceStore({ devices: { [laptop.id]: "Laptop", [desk.id]: "Desk" } });
	const deps = {
		runtimeFor: () => runtime,
		keptStore: kept,
		leases,
		rules,
		choiceStore: choice,
		remember: async (_u: ObjectId, c: string, d: string) => {
			remembered.push([c, d]);
			choice.conversation[c] = d;
		},
	};
	return { runtime, kept, leases, remembered, choice, deps };
}

describe("openBrowserPage", () => {
	it("opens the page and keeps its token for the conversation", async () => {
		const s = setup();
		const out = await openBrowserPage({
			userId,
			machine: laptop,
			url: "https://shop.example.com/cart",
			conversationId,
			deps: s.deps,
		});
		expect(out).toEqual({
			ok: true,
			machine: "Laptop",
			title: "Your cart",
			url: "https://shop.example.com/cart",
			tied: true,
		});
		expect(s.kept.tokens.get(`${laptop.id}:${conversationId}`)).toMatch(/^kept-token-/);
		expect(s.remembered).toEqual([[conversationId, laptop.id]]);
	});

	it("without a conversation keeps nothing: the page is just the user's tab", async () => {
		const s = setup();
		const out = await openBrowserPage({ userId, machine: laptop, deps: s.deps });
		expect(out).toMatchObject({ ok: true, tied: false, url: "about:blank" });
		expect(s.kept.tokens.size).toBe(0);
		expect(s.remembered).toEqual([]);
	});

	it("says busy while a browse task holds the machine, and opens nothing", async () => {
		const s = setup();
		const held = await s.leases.acquire(laptop.id, userId, "task");
		expect(held).not.toBeNull();
		const out = await openBrowserPage({ userId, machine: laptop, conversationId, deps: s.deps });
		expect(out).toMatchObject({ ok: false, code: "busy", status: 409 });
		expect((out as { message: string }).message).toContain("busy");
		expect(s.runtime.calls).toEqual([]);
		await held?.release();
		expect(
			await openBrowserPage({ userId, machine: laptop, conversationId, deps: s.deps })
		).toMatchObject({ ok: true });
	});

	it("releases the lease afterwards, also when the runtime fails", async () => {
		const s = setup();
		s.runtime.failNext.open = new Error("boom");
		const out = await openBrowserPage({ userId, machine: laptop, deps: s.deps });
		expect(out).toMatchObject({ ok: false, code: "runtime", status: 502 });
		expect(await s.leases.acquire(laptop.id, userId, "next")).not.toBeNull();
	});

	it("refuses a site on the deny list, before asking the machine", async () => {
		const s = setup();
		const out = await openBrowserPage({
			userId,
			machine: laptop,
			url: "https://www.bank.example.org/login",
			deps: s.deps,
		});
		expect(out).toMatchObject({ ok: false, code: "denied", status: 403 });
		expect(s.runtime.calls).toEqual([]);
	});

	it("passes the deny list to the runtime, which checks redirects", async () => {
		const s = setup();
		await openBrowserPage({
			userId,
			machine: laptop,
			url: "https://shop.example.com/cart",
			deps: s.deps,
		});
		expect(s.runtime.calls[0]).toMatchObject({
			tool: "open",
			args: { url: "https://shop.example.com/cart", deny: ["bank.example.org"] },
		});
	});

	it("moving a chat to another computer forgets the page kept on the old one", async () => {
		const s = setup();
		await openBrowserPage({ userId, machine: laptop, conversationId, deps: s.deps });
		await openBrowserPage({ userId, machine: desk, conversationId, deps: s.deps });
		expect(s.kept.tokens.has(`${laptop.id}:${conversationId}`)).toBe(false);
		expect(s.kept.tokens.has(`${desk.id}:${conversationId}`)).toBe(true);
		expect(s.choice.conversation[conversationId]).toBe(desk.id);
	});
});

describe("parseOpenUrl", () => {
	it("takes an empty address as blank, adds https to a bare host, and refuses other schemes", () => {
		expect(parseOpenUrl(undefined)).toEqual({});
		expect(parseOpenUrl("  ")).toEqual({});
		expect(parseOpenUrl("example.com/a")).toEqual({ url: "https://example.com/a" });
		expect(parseOpenUrl("http://example.com")).toEqual({ url: "http://example.com/" });
		for (const bad of [
			"file:///etc/passwd",
			"javascript:alert(1)",
			"data:text/html,x",
			"about:blank",
		]) {
			expect(parseOpenUrl(bad)).toEqual({ error: expect.stringContaining("http") });
		}
	});
});

describe("the page opened from the composer is the chat's kept page", () => {
	it("the next browse in that chat resumes it with no use_tab approval", async () => {
		const s = setup();
		await openBrowserPage({
			userId,
			machine: laptop,
			url: "https://shop.example.com/cart",
			conversationId,
			deps: s.deps,
		});
		const asks: string[] = [];
		const model = scriptedModel([answerTurn("The cart is open.")]);
		const tool = createBrowseTool({
			machines: [laptop],
			settings: {
				enabled: true,
				model: "",
				budgets: { maxSteps: 10, maxTokens: 100_000, maxSeconds: 300 },
				rules,
			},
			ceiling: "ask",
			userId,
			runtimeFor: () => s.runtime,
			grantKeyFor: async () => FAKE_BROWSER_KEY,
			leases: s.leases,
			keptStore: s.kept,
			choiceStore: s.choice,
			remember: async () => {},
			approver: async (ask) => {
				asks.push(ask.sentence);
				return { verdict: "approved", id: "x" };
			},
			completeFor: () => model.complete,
		});
		tool.bind({ completionBase: { model: "m" } } as unknown as NestedAgentDeps);
		const out = await tool.execute({ goal: "what is on this page" }, {
			uuid: "u",
			toolCallId: "c",
			conversationId: new ObjectId(conversationId),
			elicitationSink: { conversationId: new ObjectId(conversationId), emit: vi.fn() },
		} as never);
		expect("resultText" in out).toBe(true);
		expect(asks).toEqual([]);
		const calls = s.runtime.calls.map((c) => c.tool);
		expect(calls).toContain("resume");
		expect(calls).not.toContain("tabs");
		expect(s.runtime.performed.some((a) => a.type === "use_tab")).toBe(false);
		expect(s.runtime.url).toBe("https://shop.example.com/cart");
	});

	it("a page opened with no conversation is not resumed: it needs the user's approval like any tab", async () => {
		const s = setup();
		await openBrowserPage({
			userId,
			machine: laptop,
			url: "https://shop.example.com/cart",
			deps: s.deps,
		});
		expect(await s.kept.get(laptop.id, userId, conversationId)).toBeUndefined();
	});
});
