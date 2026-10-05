/**
 * The memory tools: the personal pair is unchanged, and a project
 * conversation is offered a second pair on top of it.
 */

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { ObjectId } from "mongodb";
import { collections, ready } from "$lib/server/database";
import { MessageUpdateType } from "$lib/types/MessageUpdate";
import {
	createMemoryBuiltins,
	FORGET_FOR_PROJECT_TOOL_NAME,
	FORGET_TOOL_NAME,
	REMEMBER_FOR_PROJECT_TOOL_NAME,
	REMEMBER_TOOL_NAME,
} from "./memoryTool";
import { getEnabledBuiltinTools } from "./index";

beforeAll(async () => {
	await ready;
}, 30000);

const userId = new ObjectId();
const projectId = new ObjectId();
const conversationId = new ObjectId();

beforeEach(async () => {
	await collections.projectMemories.deleteMany({ projectId });
	await collections.memories.deleteMany({ userId });
});

const names = (tools: { name: string }[]) => tools.map((tool) => tool.name);
const ctx = { uuid: "u1", toolCallId: "c1", userId, conversationId } as never;

describe("which tools are offered", () => {
	it("offers nothing when neither switch is on", () => {
		expect(createMemoryBuiltins({ enabled: false })).toEqual([]);
	});

	it("keeps the personal pair alone outside a project", () => {
		expect(names(createMemoryBuiltins({ enabled: true }))).toEqual([
			REMEMBER_TOOL_NAME,
			FORGET_TOOL_NAME,
		]);
	});

	it("adds the project pair in a project conversation, beside the personal one", () => {
		expect(names(createMemoryBuiltins({ enabled: true, project: { projectId } }))).toEqual([
			REMEMBER_TOOL_NAME,
			FORGET_TOOL_NAME,
			REMEMBER_FOR_PROJECT_TOOL_NAME,
			FORGET_FOR_PROJECT_TOOL_NAME,
		]);
	});

	it("offers the project pair without the personal opt-in", () => {
		expect(names(createMemoryBuiltins({ enabled: false, project: { projectId } }))).toEqual([
			REMEMBER_FOR_PROJECT_TOOL_NAME,
			FORGET_FOR_PROJECT_TOOL_NAME,
		]);
	});

	it("is wired through getEnabledBuiltinTools by projectMemoryProjectId only", () => {
		const conv = { _id: conversationId } as never;
		const without = names(getEnabledBuiltinTools({ conv, memoryEnabled: true }));
		const withProject = names(
			getEnabledBuiltinTools({ conv, memoryEnabled: true, projectMemoryProjectId: projectId })
		);
		expect(without).not.toContain(REMEMBER_FOR_PROJECT_TOOL_NAME);
		expect(withProject).toContain(REMEMBER_FOR_PROJECT_TOOL_NAME);
		expect(withProject).toContain(FORGET_FOR_PROJECT_TOOL_NAME);
	});
});

describe("remember_for_project / forget_for_project", () => {
	const tool = (name: string) => {
		const found = createMemoryBuiltins({ enabled: true, project: { projectId } }).find(
			(candidate) => candidate.name === name
		);
		if (!found) throw new Error(`no tool ${name}`);
		return found;
	};

	it("writes a model-sourced note authored by the turn's user, and shows it with a project-scoped card", async () => {
		const result = await tool(REMEMBER_FOR_PROJECT_TOOL_NAME).execute(
			{ fact: "Releases are cut on Thursdays." },
			ctx
		);
		expect(result).toMatchObject({ resultText: "Remembered: Releases are cut on Thursdays." });
		const row = await collections.projectMemories.findOne({ projectId });
		expect(row).toMatchObject({
			source: "model",
			authorUserId: userId,
			conversationId,
			text: "Releases are cut on Thursdays.",
		});
		expect(await collections.memories.countDocuments({ userId })).toBe(0);
		const update = (result as { extraUpdates: Record<string, unknown>[] }).extraUpdates[0];
		expect(update).toMatchObject({
			type: MessageUpdateType.Memory,
			action: "remembered",
			scope: "project",
			projectId: projectId.toString(),
			memoryId: row?._id.toString(),
		});
	});

	it("reports a repeat as a no-op, with no card", async () => {
		await tool(REMEMBER_FOR_PROJECT_TOOL_NAME).execute({ fact: "Same note." }, ctx);
		const again = await tool(REMEMBER_FOR_PROJECT_TOOL_NAME).execute({ fact: "same note" }, ctx);
		expect(again).toMatchObject({ resultText: expect.stringContaining("nothing changed") });
		expect((again as { extraUpdates: unknown[] }).extraUpdates).toEqual([]);
	});

	it("hands validation errors back to the model instead of throwing", async () => {
		const result = await tool(REMEMBER_FOR_PROJECT_TOOL_NAME).execute({ fact: "  " }, ctx);
		expect(result).toEqual({ error: "A note cannot be empty." });
	});

	it("forgets a note by its text and reports the removal", async () => {
		await tool(REMEMBER_FOR_PROJECT_TOOL_NAME).execute({ fact: "Remove me." }, ctx);
		const result = await tool(FORGET_FOR_PROJECT_TOOL_NAME).execute({ fact: "remove me" }, ctx);
		expect(result).toMatchObject({ resultText: "Forgotten: Remove me." });
		expect(await collections.projectMemories.countDocuments({ projectId })).toBe(0);
	});

	it("refuses an anonymous turn", async () => {
		const result = await tool(REMEMBER_FOR_PROJECT_TOOL_NAME).execute({ fact: "x" }, {
			uuid: "u",
			toolCallId: "c",
		} as never);
		expect(result).toHaveProperty("error");
	});

	it("leaves the personal pair writing to personal memory", async () => {
		const remember = createMemoryBuiltins({ enabled: true, project: { projectId } }).find(
			(candidate) => candidate.name === REMEMBER_TOOL_NAME
		);
		await remember?.execute({ fact: "Prefers Italian." }, ctx);
		expect(await collections.memories.countDocuments({ userId })).toBe(1);
		expect(await collections.projectMemories.countDocuments({ projectId })).toBe(0);
	});
});
