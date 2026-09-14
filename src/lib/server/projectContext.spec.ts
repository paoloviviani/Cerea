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

const { searchBaseMock, callerFromMock } = vi.hoisted(() => ({
	searchBaseMock: vi.fn(),
	callerFromMock: vi.fn(),
}));

vi.mock("$lib/server/knowledge/service", () => ({
	searchBase: searchBaseMock,
	callerFrom: callerFromMock,
	reachableStores: vi.fn(),
}));

import { projectContext, DEFAULT_RETRIEVAL_LIMIT, type Project } from "$lib/server/projects";
import type { User } from "$lib/types/User";

beforeAll(async () => {
	const { ready } = await import("$lib/server/database");
	await ready;
}, 30000);

beforeEach(() => {
	searchBaseMock.mockReset();
	callerFromMock.mockReset();
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
		userId: new ObjectId() as unknown as User["_id"],
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
		searchBaseMock.mockImplementation((baseId: string) => Promise.resolve({ data: hitsForBase(baseId) }));

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
		searchBaseMock.mockImplementation((baseId: string) => Promise.resolve({ data: hitsForBase(baseId) }));

		const context = await projectContext(
			contextOptions({ project: makeProject({ knowledgeBaseIds: projectBases }), knowledgeBaseIds: conversationBases })
		);

		// The shared base searched once, the conversation-only base added.
		expect(searchedBases().sort()).toEqual(["b1b1b1b1b1b1b1b1b1b1b1b1", "c1c1c1c1c1c1c1c1c1c1c1c1"]);
		expect(context).toContain("passage from c1c1c1c1c1c1c1c1c1c1c1c1");
	});

	it("keeps a project-only conversation worded and limited exactly as before", async () => {
		const project = makeProject({ knowledgeBaseIds: ["b1b1b1b1b1b1b1b1b1b1b1b1"], retrievalLimit: 3 });
		searchBaseMock.mockImplementation((baseId: string) => Promise.resolve({ data: hitsForBase(baseId) }));

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

	it("still indexes past chats into the search alongside attached bases", async () => {
		const project = makeProject({
			knowledgeBaseIds: ["b1b1b1b1b1b1b1b1b1b1b1b1"],
			indexPastChats: true,
			memoryBaseId: "d1d1d1d1d1d1d1d1d1d1d1d1",
		});
		searchBaseMock.mockImplementation((baseId: string) => Promise.resolve({ data: hitsForBase(baseId) }));

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
		searchBaseMock.mockImplementation((baseId: string) => Promise.resolve({ data: hitsForBase(baseId) }));

		await projectContext(contextOptions({ project, knowledgeBaseIds: ["c1c1c1c1c1c1c1c1c1c1c1c1"] }));
		expect(searchBaseMock.mock.calls[0][3]).toMatchObject({ max_num_results: 20 });

		await projectContext(contextOptions({ knowledgeBaseIds: ["c1c1c1c1c1c1c1c1c1c1c1c1"] }));
		expect(searchBaseMock.mock.calls.at(-1)?.[3]).toMatchObject({ max_num_results: DEFAULT_RETRIEVAL_LIMIT });
	});
});
