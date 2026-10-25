import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { ObjectId } from "mongodb";

import { collections, ready } from "$lib/server/database";
import {
	isMemoryBase,
	memoryBaseOwner,
	memoryBaseOwners,
	rejectMemoryBases,
	withoutMemoryBases,
} from "./memoryBases";

const MEMORY = "a1a1a1a1a1a1a1a1a1a1a1a1";
const PLAIN = "b2b2b2b2b2b2b2b2b2b2b2b2";
const projectId = new ObjectId();

beforeAll(async () => {
	await ready;
}, 30000);

afterEach(async () => {
	await collections.projects.deleteMany({ _id: projectId });
});

async function seed() {
	await collections.projects.insertOne({
		_id: projectId,
		userId: new ObjectId(),
		name: "Grants",
		instructions: "",
		knowledgeBaseIds: [],
		indexPastChats: true,
		memoryBaseId: MEMORY,
		createdAt: new Date(),
		updatedAt: new Date(),
	} as never);
}

describe("memory base identification", () => {
	it("knows a project's memory base, with the project, and not an ordinary base", async () => {
		await seed();
		expect(await isMemoryBase(MEMORY)).toBe(true);
		expect(await isMemoryBase(PLAIN)).toBe(false);
		expect(await isMemoryBase("not-an-id")).toBe(false);
		expect(await memoryBaseOwner(MEMORY)).toEqual({
			projectId: projectId.toString(),
			projectName: "Grants",
		});
		expect((await memoryBaseOwners()).get(MEMORY)?.projectName).toBe("Grants");
	});

	it("drops memory bases from a list, keeping order, and rejects them with a 400", async () => {
		await seed();
		expect(await withoutMemoryBases([PLAIN, MEMORY])).toEqual([PLAIN]);
		await expect(rejectMemoryBases([PLAIN, MEMORY])).rejects.toMatchObject({ status: 400 });
		await expect(rejectMemoryBases([PLAIN])).resolves.toBeUndefined();
	});
});
