import { describe, it, expect, vi, beforeEach } from "vitest";
import { ObjectId } from "mongodb";
import {
	MessageToolUpdateType,
	MessageUpdateStatus,
	MessageUpdateType,
	type MessageUpdate,
} from "$lib/types/MessageUpdate";
import type { McpFlowResult } from "./mcp/runMcpFlow";
import type { TextGenerationContext } from "./types";

const mocks = vi.hoisted(() => ({
	runMcpFlow: vi.fn(),
	generate: vi.fn(),
	memoryEnabled: vi.fn(() => true),
	assembleSkillsContext: vi.fn(async (): Promise<{ preprompt?: string; mentioned: string[] }> => ({
		preprompt: undefined,
		mentioned: [],
	})),
}));

vi.mock("$lib/server/memoryEnabled", () => ({ memoryEnabled: mocks.memoryEnabled }));
vi.mock("./mcp/runMcpFlow", () => ({ runMcpFlow: mocks.runMcpFlow }));
vi.mock("./generate", () => ({ generate: mocks.generate }));
vi.mock("$lib/server/skills/prompt", () => ({
	assembleSkillsContext: mocks.assembleSkillsContext,
}));
// eslint-disable-next-line require-yield
async function* noUpdates() {
	return undefined;
}

vi.mock("./title", () => ({ generateTitleForConversation: noUpdates }));
vi.mock("../endpoints/preprocessMessages", () => ({
	preprocessMessages: async (messages: unknown) => messages,
}));

const { textGeneration } = await import("./index");

const STREAM_UPDATE: MessageUpdate = { type: MessageUpdateType.Stream, token: "hello" };
const TOOL_UPDATE: MessageUpdate = {
	type: MessageUpdateType.Tool,
	subtype: MessageToolUpdateType.Call,
	uuid: "tool-1",
	call: { name: "hf_fs", parameters: {} },
};

/** An MCP flow that yields `updates`, then either returns `result` or throws `error`. */
function mcpFlow({
	updates = [] as MessageUpdate[],
	result = "completed" as McpFlowResult,
	error,
}: {
	updates?: MessageUpdate[];
	result?: McpFlowResult;
	error?: Error;
}) {
	return async function* () {
		for (const update of updates) yield update;
		if (error) throw error;
		return result;
	};
}

function makeContext(): TextGenerationContext {
	return {
		model: { id: "test/model", name: "test/model" },
		conv: { _id: new ObjectId(), preprompt: undefined },
		messages: [{ from: "user", content: "please @csv-shaping this file" }],
		abortController: new AbortController(),
		locals: { user: { _id: new ObjectId() } },
	} as unknown as TextGenerationContext;
}

async function collect(ctx: TextGenerationContext) {
	const updates: MessageUpdate[] = [];
	for await (const update of textGeneration(ctx)) {
		// Keepalive ticks carry no content.
		if (update.type === MessageUpdateType.Status && update.status === MessageUpdateStatus.KeepAlive)
			continue;
		updates.push(update);
	}
	return updates;
}

beforeEach(() => {
	mocks.runMcpFlow.mockReset();
	mocks.generate.mockReset();
	mocks.generate.mockImplementation(noUpdates);
	mocks.memoryEnabled.mockReset();
	mocks.memoryEnabled.mockReturnValue(true);
	mocks.assembleSkillsContext.mockReset();
	mocks.assembleSkillsContext.mockImplementation(async () => ({
		preprompt: undefined,
		mentioned: [],
	}));
});

describe("textGeneration MCP fallback", () => {
	it("falls back to plain generation when MCP never ran", async () => {
		mocks.runMcpFlow.mockImplementation(mcpFlow({ result: "not_applicable" }));

		await collect(makeContext());

		expect(mocks.generate).toHaveBeenCalledTimes(1);
	});

	it("does not fall back once MCP has answered", async () => {
		mocks.runMcpFlow.mockImplementation(mcpFlow({ updates: [STREAM_UPDATE], result: "completed" }));

		await collect(makeContext());

		expect(mocks.generate).not.toHaveBeenCalled();
	});

	// Regression: exhausting the tool rounds used to re-run the turn with no tools.
	it("does not fall back when MCP exhausted its tool rounds", async () => {
		mocks.runMcpFlow.mockImplementation(mcpFlow({ updates: [TOOL_UPDATE], result: "exhausted" }));

		await collect(makeContext());

		expect(mocks.generate).not.toHaveBeenCalled();
	});

	// runMcpFlow catches its own errors, so a post-output failure can reach the caller as
	// "not_applicable" rather than a throw. Falling back on that is the same discard.
	it("does not fall back on not_applicable once output has been produced", async () => {
		mocks.runMcpFlow.mockImplementation(
			mcpFlow({ updates: [TOOL_UPDATE], result: "not_applicable" })
		);

		await collect(makeContext());

		expect(mocks.generate).not.toHaveBeenCalled();
	});

	// Regression: the same discard, reached via the error path.
	it("surfaces a failure that happens after MCP produced output", async () => {
		mocks.runMcpFlow.mockImplementation(
			mcpFlow({ updates: [TOOL_UPDATE], error: new Error("upstream exploded") })
		);

		await expect(collect(makeContext())).rejects.toThrow("upstream exploded");
		expect(mocks.generate).not.toHaveBeenCalled();
	});

	it("still falls back when MCP fails before producing output", async () => {
		mocks.runMcpFlow.mockImplementation(mcpFlow({ error: new Error("mcp server down") }));

		await collect(makeContext());

		expect(mocks.generate).toHaveBeenCalledTimes(1);
	});
});

describe("textGeneration skills", () => {
	// Stage 1 rides the normal turn: the frontmatter list reaches the model
	// flow inside the preprompt, which is what the model matches against —
	// and what it loads bodies from, mid-turn, through `load_skill`.
	it("carries the skill context into the model flow", async () => {
		mocks.assembleSkillsContext.mockImplementation(async () => ({
			preprompt: "## Skills\n\n- `csv-shaping`: Reshape CSV.",
			mentioned: [],
		}));
		mocks.runMcpFlow.mockImplementation(mcpFlow({ result: "not_applicable" }));

		await collect(makeContext());

		expect(mocks.assembleSkillsContext).toHaveBeenCalledTimes(1);
		const flowArgs = mocks.runMcpFlow.mock.calls[0]?.[0] as { preprompt?: string };
		expect(flowArgs.preprompt).toContain("## Skills");
	});

	it("loads the mentioned body up front on an @name mention", async () => {
		mocks.assembleSkillsContext.mockImplementation(async () => ({
			preprompt: "## Skills\n\n## Skill: csv-shaping\n\n# CSV shaping",
			mentioned: ["csv-shaping"],
		}));
		mocks.runMcpFlow.mockImplementation(mcpFlow({ result: "not_applicable" }));

		const ctx = makeContext();
		await collect(ctx);

		// The mention text the person typed is what selected the body.
		expect(mocks.assembleSkillsContext).toHaveBeenCalledWith(
			expect.anything(),
			"please @csv-shaping this file"
		);
		const flowArgs = mocks.runMcpFlow.mock.calls[0]?.[0] as { preprompt?: string };
		expect(flowArgs.preprompt).toContain("## Skill: csv-shaping");
	});

	it("still runs the turn when skill loading fails", async () => {
		mocks.assembleSkillsContext.mockRejectedValue(new Error("store down"));
		mocks.runMcpFlow.mockImplementation(mcpFlow({ result: "not_applicable" }));

		await collect(makeContext());

		expect(mocks.generate).toHaveBeenCalledTimes(1);
	});
});

describe("textGeneration abort", () => {
	it("does not fall back or throw when the user aborts", async () => {
		const ctx = makeContext();
		ctx.abortController.abort();
		mocks.runMcpFlow.mockImplementation(
			mcpFlow({ updates: [STREAM_UPDATE], error: new Error("Request was aborted") })
		);

		await collect(ctx);

		expect(mocks.generate).not.toHaveBeenCalled();
	});
});

describe("textGeneration project memory", () => {
	// The project's notes ride the preprompt of that project's own chats and
	// nobody else's: gated by the conversation's `projectId`, by current
	// membership, and by the deployment flag — and placed after the personal
	// block.
	const ownerId = new ObjectId();
	const projectId = new ObjectId();
	const otherProjectId = new ObjectId();

	async function flowPreprompt(conv: Record<string, unknown>, userId = ownerId) {
		mocks.runMcpFlow.mockImplementation(mcpFlow({ result: "not_applicable" }));
		const ctx = makeContext();
		ctx.conv = { _id: new ObjectId(), preprompt: undefined, ...conv } as never;
		ctx.locals = { user: { _id: userId } } as never;
		await collect(ctx);
		return (mocks.runMcpFlow.mock.calls.at(-1)?.[0] as { preprompt?: string }).preprompt ?? "";
	}

	beforeEach(async () => {
		const { collections, ready } = await import("$lib/server/database");
		await ready;
		await collections.projects.deleteMany({ _id: { $in: [projectId, otherProjectId] } });
		await collections.projectMemories.deleteMany({
			projectId: { $in: [projectId, otherProjectId] },
		});
		await collections.memories.deleteMany({ userId: ownerId });
		await collections.settings.deleteMany({ userId: ownerId as never });
		const base = {
			userId: ownerId,
			name: "P",
			instructions: "",
			knowledgeBaseIds: [],
			shares: [],
			indexPastChats: false,
			retrievalLimit: 6,
			createdAt: new Date(),
			updatedAt: new Date(),
		};
		await collections.projects.insertMany([
			{ _id: projectId, ...base },
			{ _id: otherProjectId, ...base, userId: new ObjectId() },
		] as never);
		const now = new Date();
		await collections.projectMemories.insertMany([
			{
				_id: new ObjectId(),
				projectId,
				text: "Deploys go through the release branch.",
				source: "user",
				authorUserId: ownerId,
				createdAt: now,
				updatedAt: now,
			},
			{
				_id: new ObjectId(),
				projectId: otherProjectId,
				text: "Somebody else's secret plan.",
				source: "user",
				authorUserId: new ObjectId(),
				createdAt: now,
				updatedAt: now,
			},
		]);
	});

	it("puts the project's notes in a chat that belongs to the project", async () => {
		const preprompt = await flowPreprompt({ projectId });
		expect(preprompt).toContain("Project memory");
		expect(preprompt).toContain("Deploys go through the release branch.");
	});

	it("leaves them out of a chat outside any project", async () => {
		const preprompt = await flowPreprompt({});
		expect(preprompt).not.toContain("Project memory");
		expect(preprompt).not.toContain("release branch");
	});

	it("never shows another project's notes, or the notes to a non-member", async () => {
		// A chat pointing at a project the person neither owns nor has a share on.
		const preprompt = await flowPreprompt({ projectId: otherProjectId });
		expect(preprompt).not.toContain("Somebody else's secret plan.");
		// And a stranger holding a chat whose projectId is the owner's project.
		const stranger = await flowPreprompt({ projectId }, new ObjectId());
		expect(stranger).not.toContain("release branch");
	});

	it("comes after the personal memory block", async () => {
		const { collections } = await import("$lib/server/database");
		await collections.settings.insertOne({ userId: ownerId, memoryEnabled: true } as never);
		await collections.memories.insertOne({
			_id: new ObjectId(),
			userId: ownerId,
			text: "Prefers Italian.",
			source: "user",
			createdAt: new Date(),
			updatedAt: new Date(),
		});
		const preprompt = await flowPreprompt({ projectId });
		expect(preprompt.indexOf("Prefers Italian.")).toBeGreaterThan(-1);
		expect(preprompt.indexOf("Prefers Italian.")).toBeLessThan(preprompt.indexOf("Project memory"));
	});

	it("is off with the deployment switch", async () => {
		mocks.memoryEnabled.mockReturnValue(false);
		expect(await flowPreprompt({ projectId })).not.toContain("Project memory");
	});
});
