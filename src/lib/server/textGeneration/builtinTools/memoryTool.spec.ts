/**
 * The memory tools: one `remember` / `forget` pair with an explicit scope
 * (conversation, project, global), offered only for the scopes that exist for
 * the turn.
 */

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { ObjectId } from "mongodb";
import { collections, ready } from "$lib/server/database";
import { MessageUpdateType } from "$lib/types/MessageUpdate";
import { createMemoryBuiltins, FORGET_TOOL_NAME, REMEMBER_TOOL_NAME } from "./memoryTool";
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
	await collections.conversationMemories.deleteMany({ conversationId });
});

const names = (tools: { name: string }[]) => tools.map((tool) => tool.name);
const ctx = { uuid: "u1", toolCallId: "c1", userId, conversationId } as never;
const all = () =>
	createMemoryBuiltins({ enabled: true, conversation: true, project: { projectId } });
const tool = (name: string, tools = all()) => {
	const found = tools.find((candidate) => candidate.name === name);
	if (!found) throw new Error(`no tool ${name}`);
	return found;
};
const scopesOf = (t: { definition: { function: { parameters?: unknown } } }) =>
	(
		t.definition.function.parameters as {
			properties: { scope: { enum: string[] } };
		}
	).properties.scope.enum;
const updatesOf = (result: unknown) =>
	(result as { extraUpdates: Record<string, unknown>[] }).extraUpdates;

describe("which scopes are offered", () => {
	it("offers nothing when no scope exists", () => {
		expect(createMemoryBuiltins({ enabled: false })).toEqual([]);
	});

	it("is always one pair of tools, and the scope enum lists only what exists", () => {
		expect(names(all())).toEqual([REMEMBER_TOOL_NAME, FORGET_TOOL_NAME]);
		expect(scopesOf(tool(REMEMBER_TOOL_NAME))).toEqual(["conversation", "project", "global"]);
		expect(
			scopesOf(
				tool(REMEMBER_TOOL_NAME, createMemoryBuiltins({ enabled: false, conversation: true }))
			)
		).toEqual(["conversation"]);
		expect(
			scopesOf(
				tool(REMEMBER_TOOL_NAME, createMemoryBuiltins({ enabled: true, conversation: true }))
			)
		).toEqual(["conversation", "global"]);
	});

	it("keeps the definition static: the same turn shape gives the same bytes", () => {
		expect(JSON.stringify(all().map((t) => t.definition))).toBe(
			JSON.stringify(all().map((t) => t.definition))
		);
	});

	it("offers the conversation scope without the personal opt-in (a deployment flag only)", () => {
		const conv = { _id: conversationId } as never;
		const tools = getEnabledBuiltinTools({
			conv,
			memoryEnabled: false,
			conversationMemoryEnabled: true,
		});
		expect(names(tools)).toContain(REMEMBER_TOOL_NAME);
		const without = getEnabledBuiltinTools({ conv, memoryEnabled: false });
		expect(names(without)).not.toContain(REMEMBER_TOOL_NAME);
	});

	it("adds the project scope by projectMemoryProjectId only", () => {
		const conv = { _id: conversationId } as never;
		const tools = getEnabledBuiltinTools({
			conv,
			memoryEnabled: true,
			conversationMemoryEnabled: true,
			projectMemoryProjectId: projectId,
		});
		const remember = tools.find((t) => t.name === REMEMBER_TOOL_NAME);
		expect(remember && scopesOf(remember)).toContain("project");
	});
});

describe("scope selection", () => {
	it("writes a chat note to the chat, says so, and never touches the other lists", async () => {
		const result = await tool(REMEMBER_TOOL_NAME).execute(
			{ fact: "Use metric units here.", scope: "conversation" },
			ctx
		);
		expect(result).toMatchObject({
			resultText: "Saved to this chat's notes: Use metric units here.",
		});
		expect(await collections.conversationMemories.findOne({ conversationId })).toMatchObject({
			text: "Use metric units here.",
			source: "model",
			userId,
		});
		expect(await collections.memories.countDocuments({ userId })).toBe(0);
		expect(await collections.projectMemories.countDocuments({ projectId })).toBe(0);
		expect(updatesOf(result)[0]).toMatchObject({
			type: MessageUpdateType.Memory,
			scope: "conversation",
			conversationId: conversationId.toString(),
		});
	});

	it("writes a project note authored by the turn's user", async () => {
		const result = await tool(REMEMBER_TOOL_NAME).execute(
			{ fact: "Releases are cut on Thursdays.", scope: "project" },
			ctx
		);
		expect(result).toMatchObject({ resultText: expect.stringContaining("this project's notes") });
		expect(await collections.projectMemories.findOne({ projectId })).toMatchObject({
			source: "model",
			authorUserId: userId,
			conversationId,
		});
		expect(updatesOf(result)[0]).toMatchObject({
			scope: "project",
			projectId: projectId.toString(),
		});
	});

	it("requires a scope when several exist, and refuses one that was not offered", async () => {
		const missing = await tool(REMEMBER_TOOL_NAME).execute({ fact: "x" }, ctx);
		expect(missing).toMatchObject({ error: expect.stringContaining("scope must be one of") });
		const onlyChat = createMemoryBuiltins({ enabled: false, conversation: true });
		const refused = await tool(REMEMBER_TOOL_NAME, onlyChat).execute(
			{ fact: "x", scope: "global", user_words: "always" },
			ctx
		);
		expect(refused).toMatchObject({ error: expect.stringContaining("not available here") });
		expect(await collections.memories.countDocuments({ userId })).toBe(0);
		// A single offered scope is the default.
		const ok = await tool(REMEMBER_TOOL_NAME, onlyChat).execute({ fact: "Kept here." }, ctx);
		expect(ok).toMatchObject({ resultText: expect.stringContaining("this chat's notes") });
	});

	it("keeps global for the user's own words: refused without them, with an instruction to ask", async () => {
		const refused = await tool(REMEMBER_TOOL_NAME).execute(
			{ fact: "Prefers Italian.", scope: "global" },
			ctx
		);
		expect(refused).toMatchObject({ error: expect.stringContaining("ask") });
		expect(await collections.memories.countDocuments({ userId })).toBe(0);

		const saved = await tool(REMEMBER_TOOL_NAME).execute(
			{ fact: "Prefers Italian.", scope: "global", user_words: "always answer in Italian" },
			ctx
		);
		expect(saved).toMatchObject({ resultText: expect.stringContaining("every chat") });
		expect(await collections.memories.countDocuments({ userId })).toBe(1);
	});

	it("tells the model, in its description, to take the narrowest scope and to ask when unclear", () => {
		const remember = tool(REMEMBER_TOOL_NAME);
		const text = `${remember.preprompt}\n${remember.definition.function.description}`;
		expect(text).toMatch(/narrowest/);
		expect(text).toMatch(/ask the user/i);
		expect(text).toMatch(/for this chat/i);
	});

	it("reports a repeat as a no-op, with no card", async () => {
		const args = { scope: "conversation" };
		await tool(REMEMBER_TOOL_NAME).execute({ fact: "Same note.", ...args }, ctx);
		const again = await tool(REMEMBER_TOOL_NAME).execute({ fact: "same note", ...args }, ctx);
		expect(again).toMatchObject({ resultText: expect.stringContaining("nothing changed") });
		expect(updatesOf(again)).toEqual([]);
	});

	it("hands validation errors back to the model instead of throwing", async () => {
		const result = await tool(REMEMBER_TOOL_NAME).execute(
			{ fact: "  ", scope: "conversation" },
			ctx
		);
		expect(result).toEqual({ error: "A note cannot be empty." });
	});

	it("forgets within the named scope only", async () => {
		await tool(REMEMBER_TOOL_NAME).execute({ fact: "Remove me.", scope: "conversation" }, ctx);
		await tool(REMEMBER_TOOL_NAME).execute({ fact: "Remove me.", scope: "project" }, ctx);
		const result = await tool(FORGET_TOOL_NAME).execute(
			{ fact: "remove me", scope: "conversation" },
			ctx
		);
		expect(result).toMatchObject({
			resultText: expect.stringContaining("Forgotten from this chat"),
		});
		expect(await collections.conversationMemories.countDocuments({ conversationId })).toBe(0);
		expect(await collections.projectMemories.countDocuments({ projectId })).toBe(1);
	});

	it("refuses an anonymous turn", async () => {
		const result = await tool(REMEMBER_TOOL_NAME).execute({ fact: "x", scope: "conversation" }, {
			uuid: "u",
			toolCallId: "c",
		} as never);
		expect(result).toHaveProperty("error");
	});
});
