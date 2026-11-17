/**
 * Artifact share links (ADR 0120): making them, finding them by token hash, the
 * snapshot, and the three reasons a link stops resolving. The routes are
 * exercised through the real hook in `publicShare.spec.ts`.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ObjectId } from "mongodb";

const env = vi.hoisted(() => ({ values: {} as Record<string, string> }));
vi.mock("$lib/server/config", async (original) => {
	const actual = await original<typeof import("$lib/server/config")>();
	return {
		...actual,
		config: new Proxy(actual.config, {
			get: (target, p: string | symbol) =>
				typeof p === "string" && p in env.values ? env.values[p] : Reflect.get(target, p),
		}),
	};
});

const { ready } = await import("$lib/server/database");
await ready;
const { collections } = await import("$lib/server/database");
const { cleanupTestData, createTestConversation, createTestUser } =
	await import("$lib/server/api/__tests__/testHelpers");
const shares = await import("./shares");
const { setSharingEnabled, sharingEnabled, forgetSharingSettingsCache } =
	await import("./settings");
const { hashShareToken } = await import("./tokens");
const { deleteConversationStorage } = await import("$lib/server/conversationStorage");

beforeAll(async () => {
	await ready;
}, 30000);

afterEach(async () => {
	env.values = {};
	await collections.sharedArtifacts.deleteMany({});
	await collections.shareSettings.deleteMany({});
	forgetSharingSettingsCache();
	await cleanupTestData();
});

const message = (id: string, content: string) =>
	({
		id,
		from: "assistant",
		content,
		createdAt: new Date(),
		updatedAt: new Date(),
		children: [],
	}) as never;

const tag = (id: string, type: string, body: string) =>
	`<artifact identifier="${id}" type="${type}" title="Notes ${id}">${body}</artifact>`;

async function setup(content = "# v1") {
	const owner = await createTestUser();
	const chat = await createTestConversation(owner.locals, {
		title: "Planning",
		messages: [message("m1", tag("notes", "markdown", content))],
	});
	return { owner, chat };
}

const target = { kind: "text", identifier: "notes" } as const;

describe("createShare", () => {
	it("stores only the token's hash, and the link is found by it", async () => {
		const { owner, chat } = await setup();
		const made = await shares.createShare(owner.user, {
			conversationId: chat._id,
			target,
		});
		expect(made.token).toMatch(/^[A-Za-z0-9_-]{22}$/);
		const rows = await collections.sharedArtifacts.find({}).toArray();
		expect(rows).toHaveLength(1);
		expect(rows[0].tokenHash).toBe(hashShareToken(made.token));
		expect(JSON.stringify(rows[0])).not.toContain(made.token);
		const found = await shares.findActiveShare(made.token);
		expect(found?._id.toString()).toBe(made.id);
		expect(found?.audience).toBe("signed_in");
		expect(found?.expiresAt).toBeNull();
		expect(found?.views).toBe(0);
	});

	it("will not share another user's artifact", async () => {
		const { chat } = await setup();
		const stranger = await createTestUser();
		await expect(
			shares.createShare(stranger.user, { conversationId: chat._id, target })
		).rejects.toMatchObject({ status: 404 });
		expect(await collections.sharedArtifacts.countDocuments()).toBe(0);
	});

	it("refuses an unknown artifact, a second live link for one, and a bad expiry", async () => {
		const { owner, chat } = await setup();
		await expect(
			shares.createShare(owner.user, {
				conversationId: chat._id,
				target: { kind: "text", identifier: "missing" },
			})
		).rejects.toMatchObject({ status: 404 });
		await shares.createShare(owner.user, { conversationId: chat._id, target });
		await expect(
			shares.createShare(owner.user, { conversationId: chat._id, target })
		).rejects.toMatchObject({ status: 409 });
		await expect(
			shares.createShare(owner.user, { conversationId: chat._id, target, expiryDays: 5 as never })
		).rejects.toMatchObject({ status: 400 });
	});

	it("sets the expiry from the days offered", async () => {
		const { owner, chat } = await setup();
		const made = await shares.createShare(owner.user, {
			conversationId: chat._id,
			target,
			expiryDays: 7,
			audience: "anyone",
		});
		const row = await shares.findActiveShare(made.token);
		const days = ((row?.expiresAt?.getTime() ?? 0) - Date.now()) / 86_400_000;
		expect(days).toBeGreaterThan(6.9);
		expect(days).toBeLessThan(7.1);
		expect(row?.audience).toBe("anyone");
	});
});

describe("the snapshot", () => {
	it("does not change when the artifact gets a new version, until it is updated", async () => {
		const { owner, chat } = await setup("# first");
		const made = await shares.createShare(owner.user, { conversationId: chat._id, target });
		await collections.conversations.updateOne(
			{ _id: chat._id },
			{
				$push: {
					messages: message("m2", tag("notes", "markdown", "# second")),
				},
			}
		);
		let row = await shares.findActiveShare(made.token);
		expect(row?.snapshot).toMatchObject({ kind: "text", content: "# first", version: 1 });

		const updated = await shares.updateShare(owner.user, new ObjectId(made.id), {
			toLatest: true,
		});
		expect(updated.listing.version).toBe(2);
		row = await shares.findActiveShare(made.token);
		expect(row?.snapshot).toMatchObject({ content: "# second", version: 2 });
		// The same link: the token did not change.
		expect(updated.token).toBeUndefined();
	});

	it("keeps the old copy when the chat's artifact is edited away", async () => {
		const { owner, chat } = await setup("# kept");
		const made = await shares.createShare(owner.user, { conversationId: chat._id, target });
		await collections.conversations.updateOne({ _id: chat._id }, { $set: { messages: [] } });
		const row = await shares.findActiveShare(made.token);
		expect(row?.snapshot).toMatchObject({ content: "# kept" });
	});
});

describe("when a link stops resolving", () => {
	it("is not found once revoked, and the owner alone may revoke", async () => {
		const { owner, chat } = await setup();
		const made = await shares.createShare(owner.user, { conversationId: chat._id, target });
		const stranger = await createTestUser();
		expect(await shares.revokeShare({ id: stranger.user._id }, new ObjectId(made.id))).toBe(false);
		expect(await shares.findActiveShare(made.token)).not.toBeNull();
		expect(await shares.revokeShare({ id: owner.user._id }, new ObjectId(made.id))).toBe(true);
		expect(await shares.findActiveShare(made.token)).toBeNull();
		// An administrator may revoke anyone's.
		const second = await setup();
		const other = await shares.createShare(second.owner.user, {
			conversationId: second.chat._id,
			target,
		});
		expect(
			await shares.revokeShare({ id: owner.user._id, admin: true }, new ObjectId(other.id))
		).toBe(true);
		expect(await shares.findActiveShare(other.token)).toBeNull();
	});

	it("is not found once expired", async () => {
		const { owner, chat } = await setup();
		const made = await shares.createShare(owner.user, {
			conversationId: chat._id,
			target,
			expiryDays: 30,
		});
		await collections.sharedArtifacts.updateOne(
			{ _id: new ObjectId(made.id) },
			{ $set: { expiresAt: new Date(Date.now() - 1000) } }
		);
		expect(await shares.findActiveShare(made.token)).toBeNull();
		const listing = (await shares.listOwnShares(owner.user._id))[0];
		expect(listing.status).toBe("expired");
	});

	it("is not found while sharing is off, and is found again when it is back on", async () => {
		const { owner, chat } = await setup();
		const made = await shares.createShare(owner.user, { conversationId: chat._id, target });
		await setSharingEnabled(false);
		expect(await shares.findActiveShare(made.token)).toBeNull();
		// Kept, not deleted.
		expect(await collections.sharedArtifacts.countDocuments()).toBe(1);
		// And nothing can be made or changed while off.
		await expect(
			shares.updateShare(owner.user, new ObjectId(made.id), { audience: "anyone" })
		).rejects.toMatchObject({ status: 403 });
		await setSharingEnabled(true);
		expect(await shares.findActiveShare(made.token)).not.toBeNull();
	});

	it("is not found for a malformed or unknown token", async () => {
		expect(await shares.findActiveShare("short")).toBeNull();
		expect(await shares.findActiveShare("A".repeat(22))).toBeNull();
		expect(await shares.findActiveShare("../../etc/passwd")).toBeNull();
	});
});

describe("the switch", () => {
	it("defaults to on, follows the environment, and the admin's choice overrides it", async () => {
		expect(await sharingEnabled()).toBe(true);
		env.values = { ARTIFACT_SHARING_ENABLED: "false" };
		expect(await sharingEnabled()).toBe(false);
		// Anything but exactly "false" is on.
		env.values = { ARTIFACT_SHARING_ENABLED: "0" };
		expect(await sharingEnabled()).toBe(true);
		env.values = { ARTIFACT_SHARING_ENABLED: "false" };
		await setSharingEnabled(true);
		expect(await sharingEnabled()).toBe(true);
		env.values = {};
		await setSharingEnabled(false);
		expect(await sharingEnabled()).toBe(false);
	});
});

describe("changes", () => {
	it("updates the audience and expiry, and rotates the token", async () => {
		const { owner, chat } = await setup();
		const made = await shares.createShare(owner.user, { conversationId: chat._id, target });
		const id = new ObjectId(made.id);
		const changed = await shares.updateShare(owner.user, id, {
			audience: "anyone",
			expiryDays: 90,
		});
		expect(changed.listing.audience).toBe("anyone");
		expect(changed.listing.expiresAt).not.toBeNull();
		const rotated = await shares.updateShare(owner.user, id, { rotate: true });
		expect(rotated.token).toMatch(/^[A-Za-z0-9_-]{22}$/);
		expect(await shares.findActiveShare(made.token)).toBeNull();
		expect((await shares.findActiveShare(rotated.token ?? ""))?._id.toString()).toBe(made.id);
		const stranger = await createTestUser();
		await expect(
			shares.updateShare(stranger.user, id, { audience: "signed_in" })
		).rejects.toMatchObject({ status: 404 });
	});
});

describe("views", () => {
	it("counts a viewer once a day, roughly", async () => {
		const { owner, chat } = await setup();
		const made = await shares.createShare(owner.user, { conversationId: chat._id, target });
		const row = await shares.findActiveShare(made.token);
		if (!row) throw new Error("no link");
		await shares.countShareView(row, "viewer-a");
		await shares.countShareView(row, "viewer-a");
		await shares.countShareView(row, "viewer-b");
		const after = await collections.sharedArtifacts.findOne({ _id: row._id });
		expect(after?.views).toBe(2);
		const later = new Date(Date.now() + 2 * 86_400_000);
		await shares.countShareView(row, "viewer-a", later);
		expect((await collections.sharedArtifacts.findOne({ _id: row._id }))?.views).toBe(3);
	});
});

describe("clean-up", () => {
	it("deleting the conversation deletes its links", async () => {
		const { owner, chat } = await setup();
		await shares.createShare(owner.user, { conversationId: chat._id, target });
		await deleteConversationStorage(chat._id);
		expect(await collections.sharedArtifacts.countDocuments()).toBe(0);
	});

	it("is in the user-keyed registry: reassigned on merge, erased with the account", async () => {
		const { USER_KEYED_COLLECTIONS } = await import("$lib/server/identity/userKeyedCollections");
		const entry = USER_KEYED_COLLECTIONS.find((e) => e.name === "sharedArtifacts");
		expect(entry).toMatchObject({ mergeRule: "reassign", eraseRule: "by-owner" });
		const { owner, chat } = await setup();
		await shares.createShare(owner.user, { conversationId: chat._id, target });
		const target2 = new ObjectId();
		expect(await entry?.merge(owner.user._id, target2)).toBe(1);
		expect(await collections.sharedArtifacts.countDocuments({ ownerId: target2 })).toBe(1);
		expect(await entry?.erase(target2, { conversationIds: [] })).toBe(1);
		expect(await collections.sharedArtifacts.countDocuments()).toBe(0);
	});
});
