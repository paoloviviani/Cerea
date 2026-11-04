/** "Never send this machine's asks to the reviewer" (ADR 0107): the owner's flag, on the owner's device only. */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ObjectId } from "mongodb";

const owner = new ObjectId();
vi.mock("$lib/server/codeDevices", async (importOriginal) => ({
	...(await importOriginal<typeof import("$lib/server/codeDevices")>()),
	requireCodeAgents: vi.fn(async () => {}),
}));
vi.mock("$lib/server/code/machines", () => ({
	dropMachineConnection: vi.fn(),
	notifyDevicePaired: vi.fn(),
	isMachineOnline: () => false,
}));

import { collections, ready } from "$lib/server/database";
import { deviceOptedOut } from "$lib/server/agentReview";
import { PATCH } from "./+server";

beforeAll(async () => {
	await ready;
});
afterEach(async () => {
	await collections.codeDevices.deleteMany({});
});

const patch = (userId: ObjectId, id: string, body: unknown) =>
	PATCH({
		locals: { user: { _id: userId } },
		url: new URL(`http://localhost/api/v2/code/devices?id=${id}`),
		request: new Request("http://localhost/x", {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		}),
	} as never);

describe("never-review", () => {
	it("sets and clears the flag for the owner, and the review service reads it", async () => {
		const _id = new ObjectId();
		await collections.codeDevices.insertOne({
			_id,
			userId: owner,
			status: "paired",
			name: "m",
		} as never);
		expect(
			(await patch(owner, _id.toString(), { action: "never-review", value: true })).status
		).toBe(200);
		expect(await deviceOptedOut(owner, _id.toString())).toBe(true);
		await patch(owner, _id.toString(), { action: "never-review", value: false });
		expect(await deviceOptedOut(owner, _id.toString())).toBe(false);
	});

	it("is a 404 on somebody else's device, and 400 without a boolean", async () => {
		const _id = new ObjectId();
		await collections.codeDevices.insertOne({
			_id,
			userId: owner,
			status: "paired",
			name: "m",
		} as never);
		await expect(
			patch(new ObjectId(), _id.toString(), { action: "never-review", value: true })
		).rejects.toMatchObject({ status: 404 });
		await expect(
			patch(owner, _id.toString(), { action: "never-review", value: "yes" })
		).rejects.toMatchObject({ status: 400 });
		expect(await deviceOptedOut(owner, _id.toString())).toBe(false);
	});
});
