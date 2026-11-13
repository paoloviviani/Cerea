import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { ObjectId } from "mongodb";
import { collections, ready } from "$lib/server/database";
import {
	deleteProjectMemory,
	rememberFact,
	rememberForProject,
	updateProjectMemory,
} from "$lib/server/memory/service";
import {
	MEMORY_UPDATES_MAX_CHARS,
	memoryUpdatesBlock,
	snapshotApplies,
	snapshotBlocks,
	takeMemorySnapshot,
} from "./snapshot";
import { listMemories, listProjectMemories } from "$lib/server/memory/service";

beforeAll(async () => {
	await ready;
}, 30000);

const userId = new ObjectId();
const projectId = new ObjectId();

beforeEach(async () => {
	await collections.memories.deleteMany({ userId });
	await collections.projectMemories.deleteMany({ projectId });
});

async function current() {
	return { global: await listMemories(userId), project: await listProjectMemories(projectId) };
}

describe("the start-of-chat snapshot", () => {
	it("renders the system-prompt blocks once: later project and global writes never change them", async () => {
		await rememberFact({ userId, text: "Prefers Italian.", source: "user" });
		const { memory: note } = await rememberForProject({
			projectId,
			authorUserId: userId,
			text: "Deploys go through the release branch.",
			source: "user",
		});
		const snapshot = await takeMemorySnapshot({ userId, globalOn: true, projectId });
		const before = snapshotBlocks(snapshot);
		expect(before.global).toContain("Prefers Italian.");
		expect(before.project).toContain("release branch");

		await rememberFact({ userId, text: "Lives in Rome.", source: "model" });
		await updateProjectMemory(projectId, note._id, "Deploys go through main.");
		await rememberForProject({ projectId, authorUserId: userId, text: "New.", source: "model" });

		expect(snapshotBlocks(snapshot)).toEqual(before);
		// Rendering twice is byte-identical.
		expect(JSON.stringify(snapshotBlocks(snapshot))).toBe(JSON.stringify(before));
	});

	it("reports project and global writes as tail updates, in a stable order", async () => {
		await rememberFact({ userId, text: "Prefers Italian.", source: "user" });
		const { memory: note } = await rememberForProject({
			projectId,
			authorUserId: userId,
			text: "Old convention.",
			source: "user",
		});
		const snapshot = await takeMemorySnapshot({ userId, globalOn: true, projectId });
		expect(memoryUpdatesBlock(snapshot, await current())).toBeUndefined();

		await rememberFact({ userId, text: "Lives in Rome.", source: "model" });
		await updateProjectMemory(projectId, note._id, "New convention.");
		await rememberForProject({ projectId, authorUserId: userId, text: "Extra.", source: "model" });
		const first = memoryUpdatesBlock(snapshot, await current());
		expect(first).toContain("added: Lives in Rome.");
		expect(first).toContain("now reads: New convention.");
		expect(first).toContain("added: Extra.");
		expect(memoryUpdatesBlock(snapshot, await current())).toBe(first);

		await deleteProjectMemory(projectId, note._id);
		expect(memoryUpdatesBlock(snapshot, await current())).toContain("removed: Old convention.");
	});

	it("caps the updates and says so", async () => {
		const snapshot = await takeMemorySnapshot({ userId, globalOn: true, projectId });
		for (let i = 0; i < 12; i++) {
			await rememberFact({ userId, text: `Fact ${i} ${"x".repeat(380)}`, source: "model" });
		}
		const block = memoryUpdatesBlock(snapshot, await current()) ?? "";
		expect(block).toContain("more changes not shown");
		expect(block.length).toBeLessThan(MEMORY_UPDATES_MAX_CHARS + 400);
	});

	it("is retaken only when the configuration changes shape", async () => {
		const snapshot = await takeMemorySnapshot({ userId, globalOn: true, projectId });
		expect(snapshotApplies(snapshot, { userId, globalOn: true, projectId })).toBe(true);
		expect(snapshotApplies(snapshot, { userId, globalOn: false, projectId })).toBe(false);
		expect(snapshotApplies(snapshot, { userId, globalOn: true })).toBe(false);
		expect(snapshotApplies(undefined, { userId, globalOn: true })).toBe(false);
	});
});
