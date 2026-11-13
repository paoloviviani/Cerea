import { describe, expect, it } from "vitest";
import type { ConvSidebar } from "$lib/types/ConvSidebar";
import type { CodeAgentSession } from "$lib/types/CodeAgent";
import { buildRecent, RECENT_MIN_ITEMS, RECENT_WINDOW_MS, type RecentMachine } from "./recentItems";

const NOW = Date.parse("2026-11-12T12:00:00Z");
const ago = (hours: number) => new Date(NOW - hours * 3_600_000);

const chat = (id: string, hours: number, extra: Partial<ConvSidebar> = {}): ConvSidebar => ({
	id,
	title: `chat ${id}`,
	updatedAt: ago(hours),
	lastActivityAt: ago(hours),
	...extra,
});
const agent = (id: string, hours: number, extra: Partial<CodeAgentSession> = {}) =>
	({
		id,
		workspaceId: "ws1",
		title: `agent ${id}`,
		provider: "opencode",
		state: "idle",
		updatedAt: ago(hours).toISOString(),
		modeId: null,
		modelId: null,
		...extra,
	}) as CodeAgentSession;
const machine = (agents: CodeAgentSession[], online = true): RecentMachine => ({
	id: "m1",
	name: "laptop",
	online,
	agents,
});
const build = (input: Partial<Parameters<typeof buildRecent>[0]>) =>
	buildRecent({ chats: [], chatsComplete: true, projects: {}, machines: [], now: NOW, ...input });

describe("buildRecent", () => {
	it("is 48 hours, filled to ten rows", () => {
		expect(RECENT_WINDOW_MS).toBe(48 * 3_600_000);
		expect(RECENT_MIN_ITEMS).toBe(10);
	});

	it("merges chats and sessions into one list, newest first", () => {
		const items = build({
			chats: [chat("c1", 5), chat("c2", 1)],
			machines: [machine([agent("a1", 3), agent("a2", 0.5)])],
		});
		expect(items.map((i) => `${i.kind}:${i.id}`)).toEqual([
			"agent:a2",
			"chat:c2",
			"agent:a1",
			"chat:c1",
		]);
	});

	it("sorts a chat by lastActivityAt, not updatedAt", () => {
		const items = build({
			chats: [chat("old", 30, { updatedAt: ago(0.1) }), chat("new", 2, { updatedAt: ago(40) })],
		});
		expect(items.map((i) => i.id)).toEqual(["new", "old"]);
	});

	it("includes project chats with the project's name, and not subagents", () => {
		const items = build({
			chats: [chat("p1", 1, { projectId: "proj" })],
			projects: { proj: "Thesis" },
			machines: [machine([agent("a1", 2), agent("sub", 1, { parentId: "a1" })])],
		});
		expect(items.map((i) => i.id)).toEqual(["p1", "a1"]);
		expect(items[0]).toMatchObject({ kind: "chat", project: { id: "proj", name: "Thesis" } });
		expect(items[1]).toMatchObject({
			kind: "agent",
			machine: { id: "m1", name: "laptop", online: true },
		});
	});

	it("drops what is older than the window once there are enough rows", () => {
		const chats = [
			...Array.from({ length: 10 }, (_, i) => chat(`r${i}`, i + 1)),
			chat("stale", 49),
		];
		const items = build({ chats });
		expect(items).toHaveLength(10);
		expect(items.some((i) => i.id === "stale")).toBe(false);
	});

	it("fills up to ten with older items when the window holds fewer", () => {
		const chats = [chat("a", 1), ...Array.from({ length: 15 }, (_, i) => chat(`o${i}`, 100 + i))];
		const items = build({ chats });
		expect(items).toHaveLength(10);
		expect(items[0].id).toBe("a");
		expect(items[9].id).toBe("o8");
	});

	it("keeps every item inside the window even beyond ten", () => {
		const chats = [
			...Array.from({ length: 14 }, (_, i) => chat(`r${i}`, i * 3)),
			chat("stale", 60),
		];
		expect(build({ chats })).toHaveLength(14);
	});

	it("is chats only without machines, and empty without anything", () => {
		expect(build({ chats: [chat("c", 1)] }).map((i) => i.kind)).toEqual(["chat"]);
		expect(build({})).toEqual([]);
	});

	it("holds back sessions older than the oldest loaded chat while more chats exist", () => {
		const items = build({
			chats: [chat("c1", 1), chat("c2", 10)],
			chatsComplete: false,
			machines: [machine([agent("a1", 5), agent("a2", 20)])],
		});
		expect(items.map((i) => i.id)).toEqual(["c1", "a1", "c2"]);
	});

	it("marks an offline machine", () => {
		const [item] = build({ machines: [machine([agent("a1", 1)], false)] });
		expect(item).toMatchObject({ machine: { online: false } });
	});
});
