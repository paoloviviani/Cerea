/**
 * What a turn retrieves from, when a conversation carries its own knowledge
 * bases in addition to — never instead of — its project's.
 *
 * The merge is the part a plausible implementation gets wrong twice: by
 * replacing the project's bases with the conversation's (which silently
 * switches off standing context somebody built a project around), or by
 * searching the same base twice when both sources name it (which fills the
 * retrieval budget with duplicate passages). There is a case here for each.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { ObjectId } from "mongodb";

const { searchBaseMock, callerFromMock, knowledgeSwitch } = vi.hoisted(() => ({
	searchBaseMock: vi.fn(),
	callerFromMock: vi.fn(),
	knowledgeSwitch: { on: true },
}));

vi.mock("$lib/server/knowledge/service", () => ({
	searchBase: searchBaseMock,
	callerFrom: callerFromMock,
	reachableStores: vi.fn(),
}));

// The deployment switch, controllable per test while everything else resolves
// through the real helper. On by default, matching an unset
// CHAT_KNOWLEDGE_ENABLED.
vi.mock("$lib/server/knowledgeEnabled", () => ({
	knowledgeEnabled: () => knowledgeSwitch.on,
}));

import { projectContext, DEFAULT_RETRIEVAL_LIMIT } from "$lib/server/projects";
import type { Project } from "$lib/types/Project";

beforeAll(async () => {
	const { ready } = await import("$lib/server/database");
	await ready;
}, 30000);

beforeEach(() => {
	searchBaseMock.mockReset();
	callerFromMock.mockReset();
	knowledgeSwitch.on = true;
	callerFromMock.mockResolvedValue({
		userId: new ObjectId(),
		email: "reader@example.org",
		groups: [],
		isAdmin: false,
	});
});

function makeProject(overrides: Partial<Project> = {}): Project {
	const now = new Date();
	return {
		_id: new ObjectId(),
		userId: new ObjectId(),
		name: "A project",
		description: "",
		instructions: "",
		knowledgeBaseIds: [],
		indexPastChats: false,
		retrievalLimit: DEFAULT_RETRIEVAL_LIMIT,
		shares: [],
		createdAt: now,
		updatedAt: now,
		...overrides,
	};
}

const locals = { user: { _id: new ObjectId() } } as unknown as App.Locals;
const token = "reader-token";

/** One hit per named base, tagged with the base that produced it. */
function hitsForBase(baseId: string, score = 0.9) {
	return [
		{
			document_id: baseId,
			chunk_id: `${baseId}-chunk`,
			ordinal: 0,
			score,
			text: `passage from ${baseId}`,
			title: baseId,
			source_ref: null,
		},
	];
}

function searchedBases(): string[] {
	return searchBaseMock.mock.calls.map((call) => call[0] as string);
}

const contextOptions = (overrides: Record<string, unknown> = {}) => ({
	question: "what does the spec say",
	token,
	locals,
	...overrides,
});

describe("projectContext with conversation-attached bases", () => {
	it("retrieves from a conversation's own bases when there is no project", async () => {
		searchBaseMock.mockImplementation((baseId: string) =>
			Promise.resolve({ data: hitsForBase(baseId) })
		);

		const context = await projectContext(
			contextOptions({ knowledgeBaseIds: ["a1a1a1a1a1a1a1a1a1a1a1a1"] })
		);

		expect(searchedBases()).toEqual(["a1a1a1a1a1a1a1a1a1a1a1a1"]);
		expect(context).toContain("passage from a1a1a1a1a1a1a1a1a1a1a1");
		expect(context).toContain("this conversation's knowledge");
		expect(context).not.toContain("this project's knowledge");
	});

	it("adds the conversation's bases to the project's, and dedupes a base named by both", async () => {
		const projectBases = ["b1b1b1b1b1b1b1b1b1b1b1b1"];
		const conversationBases = ["b1b1b1b1b1b1b1b1b1b1b1b1", "c1c1c1c1c1c1c1c1c1c1c1c1"];
		searchBaseMock.mockImplementation((baseId: string) =>
			Promise.resolve({ data: hitsForBase(baseId) })
		);

		const context = await projectContext(
			contextOptions({
				project: makeProject({ knowledgeBaseIds: projectBases }),
				knowledgeBaseIds: conversationBases,
			})
		);

		// The shared base searched once, the conversation-only base added.
		expect(searchedBases().sort()).toEqual([
			"b1b1b1b1b1b1b1b1b1b1b1b1",
			"c1c1c1c1c1c1c1c1c1c1c1c1",
		]);
		expect(context).toContain("passage from c1c1c1c1c1c1c1c1c1c1c1c1");
	});

	it("keeps a project-only conversation worded and limited exactly as before", async () => {
		const project = makeProject({
			knowledgeBaseIds: ["b1b1b1b1b1b1b1b1b1b1b1b1"],
			retrievalLimit: 3,
		});
		searchBaseMock.mockImplementation((baseId: string) =>
			Promise.resolve({ data: hitsForBase(baseId) })
		);

		const context = await projectContext(contextOptions({ project }));

		expect(searchedBases()).toEqual(["b1b1b1b1b1b1b1b1b1b1b1b1"]);
		expect(searchBaseMock.mock.calls[0][3]).toMatchObject({ max_num_results: 3 });
		expect(context).toContain("this project's knowledge");
	});

	it("retrieves nothing — and adds nothing — when neither source has bases", async () => {
		const context = await projectContext(contextOptions({ project: makeProject() }));

		expect(searchBaseMock).not.toHaveBeenCalled();
		expect(context).toBeUndefined();
	});

	it("skips retrieval but keeps instructions when the deployment switch is off", async () => {
		knowledgeSwitch.on = false;
		searchBaseMock.mockImplementation((baseId: string) =>
			Promise.resolve({ data: hitsForBase(baseId) })
		);
		const project = makeProject({
			instructions: "Answer in British English.",
			knowledgeBaseIds: ["b1b1b1b1b1b1b1b1b1b1b1b1"],
		});

		// A disabled pipeline is a reason for a worse answer, never for none:
		// no store is touched and the turn keeps its standing instructions.
		const context = await projectContext(
			contextOptions({ project, knowledgeBaseIds: ["c1c1c1c1c1c1c1c1c1c1c1c1"] })
		);

		expect(searchBaseMock).not.toHaveBeenCalled();
		expect(context).toBe("Answer in British English.");
	});

	it("still indexes past chats into the search alongside attached bases", async () => {
		const project = makeProject({
			knowledgeBaseIds: ["b1b1b1b1b1b1b1b1b1b1b1b1"],
			indexPastChats: true,
			memoryBaseId: "d1d1d1d1d1d1d1d1d1d1d1d1",
		});
		searchBaseMock.mockImplementation((baseId: string) =>
			Promise.resolve({ data: hitsForBase(baseId) })
		);

		await projectContext(
			contextOptions({ project, knowledgeBaseIds: ["c1c1c1c1c1c1c1c1c1c1c1c1"] })
		);

		expect(searchedBases().sort()).toEqual([
			"b1b1b1b1b1b1b1b1b1b1b1b1",
			"c1c1c1c1c1c1c1c1c1c1c1c1",
			"d1d1d1d1d1d1d1d1d1d1d1d1",
		]);
	});

	it("bounds a project-less conversation's retrieval at the default limit", async () => {
		const project = makeProject({ retrievalLimit: 20 });
		searchBaseMock.mockImplementation((baseId: string) =>
			Promise.resolve({ data: hitsForBase(baseId) })
		);

		await projectContext(
			contextOptions({ project, knowledgeBaseIds: ["c1c1c1c1c1c1c1c1c1c1c1c1"] })
		);
		expect(searchBaseMock.mock.calls[0][3]).toMatchObject({ max_num_results: 20 });

		await projectContext(contextOptions({ knowledgeBaseIds: ["c1c1c1c1c1c1c1c1c1c1c1c1"] }));
		expect(searchBaseMock.mock.calls.at(-1)?.[3]).toMatchObject({
			max_num_results: DEFAULT_RETRIEVAL_LIMIT,
		});
	});
});

describe("projectContext: the five levels, in order", () => {
	const ownerId = new ObjectId();
	const projectId = new ObjectId();

	beforeEach(async () => {
		const { collections } = await import("$lib/server/database");
		await collections.projects.deleteMany({ _id: projectId });
		await collections.projectMemories.deleteMany({ projectId });
		await collections.projectDocuments.deleteMany({ projectId });
		await collections.bucketFiles.deleteMany({ "metadata.conversation": `project:${projectId}` });
		const now = new Date();
		await collections.projects.insertOne({
			_id: projectId,
			userId: ownerId,
			name: "P",
			instructions: "LEVEL1 instructions.",
			knowledgeBaseIds: ["b1b1b1b1b1b1b1b1b1b1b1b1"],
			indexPastChats: true,
			memoryBaseId: "d1d1d1d1d1d1d1d1d1d1d1d1",
			retrievalLimit: 6,
			shares: [],
			createdAt: now,
			updatedAt: now,
		} as never);
		await collections.projectMemories.insertOne({
			_id: new ObjectId(),
			projectId,
			text: "LEVEL3 a note.",
			source: "user",
			authorUserId: ownerId,
			createdAt: now,
			updatedAt: now,
		});
		const { addProjectDocument } = await import("$lib/server/projectDocuments");
		await addProjectDocument({
			projectId,
			file: new File(["LEVEL2 document body."], "spec.txt", { type: "text/plain" }),
			userId: ownerId,
		});
		searchBaseMock.mockImplementation((baseId: string) =>
			Promise.resolve({
				data: [
					{
						...hitsForBase(baseId)[0],
						text: baseId.startsWith("d") ? "LEVEL5 past chat" : "LEVEL4 knowledge",
					},
				],
			})
		);
	});

	async function build(user: ObjectId, forProject?: boolean) {
		const { collections } = await import("$lib/server/database");
		const project = forProject
			? ((await collections.projects.findOne({ _id: projectId })) ?? undefined)
			: undefined;
		return projectContext({
			project,
			question: "q",
			token,
			locals: { user: { _id: user } } as unknown as App.Locals,
		});
	}

	it("puts instructions, documents, memory, knowledge and past chats in that order", async () => {
		const context = (await build(ownerId, true)) as string;
		const at = ["LEVEL1", "LEVEL2", "LEVEL3", "LEVEL4", "LEVEL5"].map((tag) =>
			context.indexOf(tag)
		);
		expect(at.every((index) => index >= 0)).toBe(true);
		expect(at).toEqual([...at].sort((a, b) => a - b));
		expect(context).toContain("## spec.txt\nLEVEL2 document body.");
	});

	it("gives the documents to that project's chats only, and not to a former member", async () => {
		expect(await build(ownerId, false)).toBeUndefined();
		// A project's own chat run by somebody who is no longer (or never was) a member.
		const stranger = (await build(new ObjectId(), true)) as string;
		expect(stranger).toContain("LEVEL1");
		expect(stranger).not.toContain("LEVEL2");
		expect(stranger).not.toContain("LEVEL3");
	});
});
