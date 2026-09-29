import { describe, it, expect } from "vitest";
import type { CodeAgentSession, CodeWorkspace } from "$lib/types/CodeAgent";
import {
	parentRow,
	readShowSubagents,
	spawnedRow,
	subagentRow,
	subagentStatus,
	visibleAgents,
} from "./codeSubagents";

const ws = (id: string, name: string): CodeWorkspace =>
	({ id, name, path: `/src/${name}`, isGitRepo: true }) as CodeWorkspace;

const agent = (over: Partial<CodeAgentSession>): CodeAgentSession => ({
	id: "a",
	workspaceId: "w1",
	title: "Agent",
	provider: "opencode",
	state: "idle",
	updatedAt: "2026-09-25T00:00:00Z",
	modeId: null,
	modelId: null,
	...over,
});

const workspaces = [ws("w1", "repo"), ws("w2", "repo-feature")];
const parent = agent({ id: "p", title: "Main", workspaceId: "w1" });
const child = agent({ id: "c", title: "Researcher", workspaceId: "w1", parentId: "p" });
const farChild = agent({ id: "f", title: "Tester", workspaceId: "w2", parentId: "p" });

describe("a subagent row", () => {
	it("names its parent, and the parent's workspace only when it lives elsewhere", () => {
		const all = [parent, child, farChild];
		expect(subagentRow(child, all, workspaces)).toMatchObject({
			parentId: "p",
			parentTitle: "Main",
			elsewhere: null,
		});
		expect(subagentRow(farChild, all, workspaces)).toMatchObject({
			parentTitle: "Main",
			elsewhere: "repo",
		});
		expect(subagentRow(parent, all, workspaces)).toBeNull();
	});

	it("still marks a subagent whose parent is not listed", () => {
		expect(subagentRow(child, [child], workspaces)).toMatchObject({
			parentId: "p",
			parentTitle: null,
		});
	});

	it("reports waiting for approval ahead of anything else", () => {
		expect(subagentStatus(agent({ state: "waiting-permission" }))).toBe("waiting");
		expect(subagentStatus(agent({ state: "running" }))).toBe("running");
		expect(subagentStatus(agent({ state: "error" }))).toBe("failed");
		expect(subagentStatus(agent({ state: "idle" }))).toBe("done");
	});
});

describe("a parent row", () => {
	it("counts its subagents wherever they live, and links each", () => {
		const row = parentRow(parent, [parent, child, farChild], workspaces);
		expect(row?.count).toBe(2);
		expect(row?.children.map((c) => `${c.title}@${c.workspaceName}`)).toEqual([
			"Researcher@repo",
			"Tester@repo-feature",
		]);
		expect(row?.waiting).toBe(false);
	});

	it("flags a waiting descendant from the machine's summary or a listed child", () => {
		const summarised = { ...parent, childSummary: { children: 1, running: 0, waiting: 1 } };
		expect(parentRow(summarised, [summarised], workspaces)?.waiting).toBe(true);
		const waitingChild = { ...child, state: "waiting-permission" as const };
		expect(parentRow(parent, [parent, waitingChild], workspaces)?.waiting).toBe(true);
	});

	it("is absent for a session that spawned nothing", () => {
		expect(parentRow(child, [parent, child], workspaces)).toBeNull();
	});
});

describe("the subagent filter", () => {
	it("shows subagents by default and hides them when turned off", () => {
		const all = [parent, child];
		expect(visibleAgents(all, true)).toHaveLength(2);
		expect(visibleAgents(all, false).map((a) => a.id)).toEqual(["p"]);
		expect(readShowSubagents(undefined)).toBe(true);
		expect(readShowSubagents({ getItem: () => null })).toBe(true);
		expect(readShowSubagents({ getItem: () => "false" })).toBe(false);
	});
});

describe("a spawned session's row", () => {
	const spawned = agent({
		id: "s",
		title: "Docs",
		workspaceId: "w1",
		parentId: null,
		spawnedBy: { sessionId: "p", title: "Main (then)" },
	});

	it("is top level, and names its spawner by the live title with a link target", () => {
		expect(spawnedRow(spawned, [parent, spawned], workspaces)).toEqual({
			sessionId: "p",
			title: "Main",
			workspaceId: "w1",
			elsewhere: null,
		});
	});

	it("names the spawner's workspace only when it lives elsewhere", () => {
		const far = agent({ ...spawned, workspaceId: "w2" });
		expect(spawnedRow(far, [parent, far], workspaces)).toMatchObject({ elsewhere: "repo" });
	});

	it("keeps the title it was created with when the spawner is not listed", () => {
		expect(spawnedRow(spawned, [spawned], workspaces)).toEqual({
			sessionId: "p",
			title: "Main (then)",
			workspaceId: null,
			elsewhere: null,
		});
	});

	it("is null for an ordinary session, and for a subagent", () => {
		expect(spawnedRow(parent, [parent], workspaces)).toBeNull();
		expect(spawnedRow(child, [parent, child], workspaces)).toBeNull();
	});
});
