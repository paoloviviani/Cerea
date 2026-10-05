/**
 * A project's shared notes: the same store rules as personal memory (they run
 * through the same core), plus what sharing adds — access, authorship, and the
 * fate of a note whose author's account is gone.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { ObjectId } from "mongodb";
import { collections, ready } from "$lib/server/database";
import {
	PROJECT_MEMORY_BLOCK_MAX_CHARS,
	PROJECT_MEMORY_MAX_NOTES,
	PROJECT_MEMORY_TEXT_MAX_CHARS,
} from "$lib/types/Memory";
import { projectForMemory } from "$lib/server/projects";
import {
	buildProjectMemoryBlock,
	DELETED_AUTHOR,
	deleteProjectMemory,
	forgetForProject,
	listProjectMemories,
	MemoryValidationError,
	projectMemoryContext,
	projectMemoryViews,
	rememberForProject,
	updateProjectMemory,
} from "./service";

const mocks = vi.hoisted(() => ({ memoryEnabled: vi.fn(() => true) }));
vi.mock("$lib/server/memoryEnabled", () => ({ memoryEnabled: mocks.memoryEnabled }));

beforeAll(async () => {
	await ready;
}, 30000);

const owner = new ObjectId();
const colleague = new ObjectId();
const stranger = new ObjectId();
const projectId = new ObjectId();
const otherProjectId = new ObjectId();

beforeEach(async () => {
	mocks.memoryEnabled.mockReturnValue(true);
	// Scoped to this file's ids: sibling specs share the test database.
	await collections.projectMemories.deleteMany({
		projectId: { $in: [projectId, otherProjectId] },
	});
	await collections.projects.deleteMany({ _id: { $in: [projectId, otherProjectId] } });
	await collections.users.deleteMany({ _id: { $in: [owner, colleague, stranger] } });
	const now = new Date();
	await collections.projects.insertMany([
		{
			_id: projectId,
			userId: owner,
			name: "P",
			instructions: "",
			knowledgeBaseIds: [],
			indexPastChats: false,
			retrievalLimit: 6,
			shares: [{ kind: "user", email: "colleague@example.org" }],
			createdAt: now,
			updatedAt: now,
		},
		{
			_id: otherProjectId,
			userId: stranger,
			name: "Other",
			instructions: "",
			knowledgeBaseIds: [],
			indexPastChats: false,
			retrievalLimit: 6,
			shares: [],
			createdAt: now,
			updatedAt: now,
		},
	] as never);
	await collections.users.insertMany([
		{ _id: owner, name: "Olga Owner", username: "olga", createdAt: now, updatedAt: now },
		{
			_id: colleague,
			name: "Carlo Colleague",
			email: "colleague@example.org",
			createdAt: now,
			updatedAt: now,
		},
	] as never);
}, 20000);

function note(text: string, author = owner, source: "user" | "model" = "user", pid = projectId) {
	return rememberForProject({ projectId: pid, authorUserId: author, text, source });
}

describe("rememberForProject", () => {
	it("stores a note with its author and project, whitespace collapsed", async () => {
		const { memory, created } = await note("  Deploys   go through the release branch. ");
		expect(created).toBe(true);
		expect(memory.text).toBe("Deploys go through the release branch.");
		expect(memory.projectId).toStrictEqual(projectId);
		expect(memory.authorUserId).toStrictEqual(owner);
	});

	it("deduplicates across authors: a colleague re-adding a note moves its date, not its author", async () => {
		const first = await note("Staging resets Monday.", owner);
		const again = await note("  staging resets   monday  ", colleague);
		expect(again.created).toBe(false);
		expect(again.memory._id).toStrictEqual(first.memory._id);
		expect(again.memory.authorUserId).toStrictEqual(owner);
		expect(await collections.projectMemories.countDocuments({ projectId })).toBe(1);
	});

	it("allows the same text in two different projects", async () => {
		await note("Shared wording.");
		const other = await note("Shared wording.", stranger, "user", otherProjectId);
		expect(other.created).toBe(true);
	});

	it("rejects empty and over-long notes, naming the limit", async () => {
		await expect(note("   ")).rejects.toThrow("A note cannot be empty.");
		await expect(note("x".repeat(PROJECT_MEMORY_TEXT_MAX_CHARS + 1))).rejects.toThrow(
			`${PROJECT_MEMORY_TEXT_MAX_CHARS} characters or fewer`
		);
		// The personal limit (400) does not apply here.
		await expect(note("y".repeat(1500))).resolves.toMatchObject({ created: true });
	});

	it("refuses a write past the note ceiling but still dedups at it", async () => {
		const now = new Date();
		await collections.projectMemories.insertMany(
			Array.from({ length: PROJECT_MEMORY_MAX_NOTES }, (_, index) => ({
				_id: new ObjectId(),
				projectId,
				text: `Note ${index}`,
				source: "user" as const,
				authorUserId: owner,
				createdAt: new Date(now.getTime() + index),
				updatedAt: now,
			}))
		);
		await expect(note("One too many.")).rejects.toThrow(
			`Project memory is full (${PROJECT_MEMORY_MAX_NOTES} notes)`
		);
		await expect(note("note 3")).resolves.toMatchObject({ created: false });
	});
});

describe("update, delete and forget", () => {
	it("lets any member rewrite a note while the author stays", async () => {
		const { memory } = await note("Old wording.", owner);
		const updated = await updateProjectMemory(projectId, memory._id, "New wording.");
		expect(updated.text).toBe("New wording.");
		expect(updated.authorUserId).toStrictEqual(owner);
	});

	it("treats a note id from another project as not existing", async () => {
		const { memory } = await note("Theirs.", stranger, "user", otherProjectId);
		await expect(updateProjectMemory(projectId, memory._id, "Mine now.")).rejects.toThrow(
			"No such note."
		);
		expect(await deleteProjectMemory(projectId, memory._id)).toBe(false);
		expect(await collections.projectMemories.countDocuments({ _id: memory._id })).toBe(1);
	});

	it("forgets by text within the project only, with guidance on a miss", async () => {
		await note("Alpha convention.");
		await note("Beta convention.");
		await note("Gamma convention.", stranger, "user", otherProjectId);
		await expect(forgetForProject({ projectId, text: "convention" })).rejects.toThrow(
			"more than one note"
		);
		await expect(forgetForProject({ projectId, text: "gamma" })).rejects.toThrow(
			"Nothing in project memory matches that"
		);
		const removed = await forgetForProject({ projectId, text: "alpha convention" });
		expect(removed.text).toBe("Alpha convention.");
		expect(await listProjectMemories(projectId)).toHaveLength(1);
		expect(await listProjectMemories(otherProjectId)).toHaveLength(1);
	});

	it("says there is nothing to forget in an empty project", async () => {
		await expect(forgetForProject({ projectId, text: "x" })).rejects.toBeInstanceOf(
			MemoryValidationError
		);
	});
});

describe("the project memory block", () => {
	it("is undefined for a project with no notes", async () => {
		expect(await buildProjectMemoryBlock(projectId)).toBeUndefined();
		expect(await projectMemoryContext(undefined)).toBeUndefined();
	});

	it("renders only this project's notes, oldest first, under a header saying they are shared", async () => {
		await note("First note.");
		await note("Second note.");
		await note("Not for this project.", stranger, "user", otherProjectId);
		const block = await buildProjectMemoryBlock(projectId);
		expect(block).toContain("Project memory");
		expect(block).toContain("shared between all of them");
		expect(block).toContain("- First note.\n- Second note.");
		expect(block).not.toContain("Not for this project.");
	});

	it("drops the oldest notes past the 8000-character budget and says how many", async () => {
		const chunk = "z".repeat(1900);
		for (let index = 0; index < 6; index += 1) await note(`n${index} ${chunk}`);
		const block = (await buildProjectMemoryBlock(projectId)) as string;
		expect(block).toContain("stored but omitted here for length");
		expect(block).toContain("n5 ");
		expect(block).not.toContain("n0 ");
		// The budget really is the project one, not the 1500-character personal one.
		expect(block.length).toBeLessThan(PROJECT_MEMORY_BLOCK_MAX_CHARS + 600);
		expect(block.split("\n- ").length - 1).toBe(4);
	});
});

describe("authors in the tab", () => {
	it("names the author, marks the viewer's own, and says 'deleted user' once the account is gone", async () => {
		await note("By the owner.", owner);
		await note("By the colleague.", colleague);
		const gone = new ObjectId();
		await note("By someone erased.", gone);

		const asColleague = await projectMemoryViews(projectId, colleague);
		const byText = Object.fromEntries(asColleague.map((view) => [view.text, view]));
		expect(byText["By the owner."]).toMatchObject({ author: "Olga Owner", mine: false });
		expect(byText["By the colleague."]).toMatchObject({ author: "Carlo Colleague", mine: true });
		expect(byText["By someone erased."]).toMatchObject({ author: DELETED_AUTHOR, mine: false });
		// No address leaks into the view.
		expect(JSON.stringify(asColleague)).not.toContain("colleague@example.org");
	});
});

describe("access: projectForMemory", () => {
	const locals = (id: ObjectId, email?: string) => ({ user: { _id: id, email } }) as never;

	it("admits the owner and a member the project is shared with", async () => {
		expect((await projectForMemory(projectId, locals(owner)))?._id).toStrictEqual(projectId);
		expect(
			(await projectForMemory(projectId, locals(colleague, "colleague@example.org")))?._id
		).toStrictEqual(projectId);
	});

	it("refuses a non-member, an anonymous turn, a chat with no project, and the switch being off", async () => {
		expect(await projectForMemory(projectId, locals(stranger, "x@example.org"))).toBeUndefined();
		expect(await projectForMemory(projectId, undefined)).toBeUndefined();
		expect(await projectForMemory(undefined, locals(owner))).toBeUndefined();
		mocks.memoryEnabled.mockReturnValue(false);
		expect(await projectForMemory(projectId, locals(owner))).toBeUndefined();
	});
});
