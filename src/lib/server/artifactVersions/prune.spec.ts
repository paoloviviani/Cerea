/**
 * Pruning old artifact versions (C122): "Delete older versions" and the deployment's
 * "keep at most N" sweep. Text versions are marked on the conversation (they are derived from
 * its messages); file versions have their stored bytes freed through BlobStore, unless
 * another version or row still needs them. A version with an active share link is never
 * deleted.
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
const { createShare, revokeShare } = await import("$lib/server/sharing/shares");
const { storeDeliverable } = await import("$lib/server/execution/deliverables");
const { countBlobs } = await import("$lib/server/blobs/testing");
const { deleteOlderVersions, pruneConversation, sweepArtifactVersions } = await import("./prune");
const { forgetMaxVersionsCache, maxArtifactVersions, setMaxArtifactVersions, parseMaxVersions } =
	await import("./settings");
const { MessageUpdateType, MessageCodeExecutionUpdateType } =
	await import("$lib/types/MessageUpdate");
const { collectArtifacts, artifactVersionKey } = await import("$lib/utils/artifacts");
const { collectFileArtifacts, fileVersionKey } = await import("$lib/utils/fileArtifacts");

beforeAll(async () => {
	await ready;
}, 30000);

afterEach(async () => {
	env.values = {};
	await collections.sharedArtifacts.deleteMany({});
	await collections.shareSettings.deleteMany({});
	forgetMaxVersionsCache();
	await cleanupTestData();
});

const message = (id: string, content: string, extra: Record<string, unknown> = {}) =>
	({
		id,
		from: "assistant",
		content,
		createdAt: new Date(),
		updatedAt: new Date(),
		children: [],
		...extra,
	}) as never;

const tag = (body: string) =>
	`<artifact identifier="notes" type="markdown" title="Notes">${body}</artifact>`;

/** A chat whose artifact "notes" has one version per message: v1, v2, v3. */
async function textChat() {
	const owner = await createTestUser();
	const chat = await createTestConversation(owner.locals, {
		title: "Planning",
		messages: [
			message("m1", tag("# one")),
			message("m2", tag("# two")),
			message("m3", tag("# three")),
		],
	});
	return { owner, chat };
}

const pruned = async (id: ObjectId) =>
	(await collections.conversations.findOne({ _id: id }))?.prunedArtifactVersions ?? [];

describe("delete older versions of a text artifact", () => {
	it("keeps the current version and marks the older ones, leaving the messages alone", async () => {
		const { owner, chat } = await textChat();
		const result = await deleteOlderVersions(
			{ userId: owner.user._id },
			{ conversationId: chat._id, identifier: "notes" }
		);
		expect(result).toMatchObject({ deleted: 2, keptShared: 0, freedFiles: 0 });
		expect(await pruned(chat._id)).toEqual(
			expect.arrayContaining([artifactVersionKey("m1", 0), artifactVersionKey("m2", 0)])
		);
		const stored = await collections.conversations.findOne({ _id: chat._id });
		expect(stored?.messages.map((m) => m.content)).toEqual([
			tag("# one"),
			tag("# two"),
			tag("# three"),
		]);
		const registry = collectArtifacts(
			stored?.messages ?? [],
			undefined,
			new Set(await pruned(chat._id))
		);
		expect(registry.artifacts.get("notes")?.versions.map((v) => !!v.deleted)).toEqual([
			true,
			true,
			false,
		]);
	});

	it("is idempotent", async () => {
		const { owner, chat } = await textChat();
		const input = { conversationId: chat._id, identifier: "notes" };
		await deleteOlderVersions({ userId: owner.user._id }, input);
		const again = await deleteOlderVersions({ userId: owner.user._id }, input);
		expect(again).toMatchObject({ deleted: 0, keptShared: 0 });
		expect(await pruned(chat._id)).toHaveLength(2);
	});

	it("keeps a version with an active share link, whatever its audience, and says so", async () => {
		const { owner, chat } = await textChat();
		await createShare(owner.user, {
			conversationId: chat._id,
			target: { kind: "text", identifier: "notes", version: 1 },
			audience: "anyone",
		});
		const result = await deleteOlderVersions(
			{ userId: owner.user._id },
			{ conversationId: chat._id, identifier: "notes" }
		);
		expect(result).toMatchObject({ deleted: 1, keptShared: 1 });
		expect(await pruned(chat._id)).toEqual([artifactVersionKey("m2", 0)]);
	});

	it("does not count a revoked or an expired link", async () => {
		const { owner, chat } = await textChat();
		const first = await createShare(owner.user, {
			conversationId: chat._id,
			target: { kind: "text", identifier: "notes", version: 1 },
		});
		await revokeShare({ id: owner.user._id }, new ObjectId(first.id));
		const second = await createShare(owner.user, {
			conversationId: chat._id,
			target: { kind: "text", identifier: "notes", version: 2 },
			expiryDays: 7,
		});
		await collections.sharedArtifacts.updateOne(
			{ _id: new ObjectId(second.id) },
			{ $set: { expiresAt: new Date(Date.now() - 1000) } }
		);
		const result = await deleteOlderVersions(
			{ userId: owner.user._id },
			{ conversationId: chat._id, identifier: "notes" }
		);
		expect(result).toMatchObject({ deleted: 2, keptShared: 0 });
	});

	it("is the owner's alone", async () => {
		const { chat } = await textChat();
		const stranger = await createTestUser();
		await expect(
			deleteOlderVersions(
				{ userId: stranger.user._id },
				{ conversationId: chat._id, identifier: "notes" }
			)
		).rejects.toMatchObject({ status: 404 });
		expect(await pruned(chat._id)).toEqual([]);
	});

	it("keeps the newest version of every branch of the conversation", async () => {
		const owner = await createTestUser();
		const chat = await createTestConversation(owner.locals, {
			title: "Branches",
			messages: [
				message("a", tag("# one"), { ancestors: [], children: ["b", "c"] }),
				message("b", tag("# two"), { ancestors: ["a"], children: [] }),
				message("c", tag("# other two"), { ancestors: ["a"], children: [] }),
			],
		});
		const result = await deleteOlderVersions(
			{ userId: owner.user._id },
			{ conversationId: chat._id, identifier: "notes", leafMessageId: "b" }
		);
		// On the branch a -> b, "a" is older; branch a -> c is untouched.
		expect(result.deleted).toBe(1);
		expect(await pruned(chat._id)).toEqual([artifactVersionKey("a", 0)]);
	});
});

/** A chat whose file "report.txt" has three versions, each with real bytes in the store. */
async function fileChat(contents = ["one", "two", "three"]) {
	const owner = await createTestUser();
	const chat = await createTestConversation(owner.locals, {
		title: "Files",
		messages: contents.map((_, i) => message(`m${i + 1}`, "done")),
	});
	const refs: Array<{ sha256: string; size: number; name: string }> = [];
	const messages: unknown[] = [];
	for (const [i, text] of contents.entries()) {
		const stored = await storeDeliverable({
			conversationId: chat._id,
			userId: owner.user._id,
			name: "report.txt",
			mime: "text/plain",
			bytes: Buffer.from(text),
			messageId: `m${i + 1}`,
		});
		if (!stored.ok) throw new Error("store failed");
		refs.push({ ...stored.ref, name: "report.txt" });
		messages.push(
			message(`m${i + 1}`, "done", {
				updates: [
					{
						type: MessageUpdateType.CodeExecution,
						subtype: MessageCodeExecutionUpdateType.Outputs,
						runKey: `run${i}`,
						files: [{ name: "report.txt", size: stored.ref.size, sha256: stored.ref.sha256 }],
					},
				],
			})
		);
	}
	await collections.conversations.updateOne(
		{ _id: chat._id },
		{ $set: { messages: messages as never } }
	);
	return { owner, chat, refs };
}

const rowsOf = (id: ObjectId) =>
	collections.codeExecutionOutputs.find({ conversationId: id }).toArray();

describe("delete older versions of a file artifact", () => {
	it("frees the older files' bytes and rows, and keeps the current one", async () => {
		const { owner, chat, refs } = await fileChat();
		expect(await countBlobs({}, "codeOutputs")).toBe(3);
		const result = await deleteOlderVersions(
			{ userId: owner.user._id },
			{ conversationId: chat._id, identifier: "report.txt" }
		);
		expect(result).toMatchObject({ deleted: 2, keptShared: 0, freedFiles: 2 });
		expect((await rowsOf(chat._id)).map((r) => r.sha256)).toEqual([refs[2].sha256]);
		expect(await countBlobs({}, "codeOutputs")).toBe(1);
		expect(await pruned(chat._id)).toEqual(
			expect.arrayContaining([
				fileVersionKey("m1", "report.txt", refs[0].sha256),
				fileVersionKey("m2", "report.txt", refs[1].sha256),
			])
		);
		// Again: nothing left to do.
		const again = await deleteOlderVersions(
			{ userId: owner.user._id },
			{ conversationId: chat._id, identifier: "report.txt" }
		);
		expect(again).toMatchObject({ deleted: 0, freedFiles: 0 });
	});

	it("keeps a shared version's file, active links only", async () => {
		const { owner, chat, refs } = await fileChat();
		const link = await createShare(owner.user, {
			conversationId: chat._id,
			target: { kind: "file", name: "report.txt", sha256: refs[0].sha256 },
		});
		const result = await deleteOlderVersions(
			{ userId: owner.user._id },
			{ conversationId: chat._id, identifier: "report.txt" }
		);
		expect(result).toMatchObject({ deleted: 1, keptShared: 1, freedFiles: 1 });
		expect((await rowsOf(chat._id)).map((r) => r.sha256).sort()).toEqual(
			[refs[0].sha256, refs[2].sha256].sort()
		);
		// Revoked, it no longer protects the version.
		await revokeShare({ id: owner.user._id }, new ObjectId(link.id));
		const after = await deleteOlderVersions(
			{ userId: owner.user._id },
			{ conversationId: chat._id, identifier: "report.txt" }
		);
		expect(after).toMatchObject({ deleted: 1, keptShared: 0, freedFiles: 1 });
		expect(await countBlobs({}, "codeOutputs")).toBe(1);
	});

	it("frees a blob only when no other row names it", async () => {
		const { owner, chat, refs } = await fileChat();
		const [first, , last] = await Promise.all(
			refs.map((r) =>
				collections.codeExecutionOutputs.findOne({ conversationId: chat._id, sha256: r.sha256 })
			)
		);
		// A second row (another name, say) that points at the first version's blob.
		await collections.codeExecutionOutputs.insertOne({
			...(first as NonNullable<typeof first>),
			_id: new ObjectId(),
			name: "copy.txt",
		});
		await deleteOlderVersions(
			{ userId: owner.user._id },
			{ conversationId: chat._id, identifier: "report.txt" }
		);
		const blobs = await collections.blobStore.find("codeOutputs", {});
		expect(blobs.map((b) => b.id.toString()).sort()).toEqual(
			[first?.gridFsId, last?.gridFsId].map((id) => id?.toString()).sort()
		);
	});

	it("keeps the stored file when a later version has the same bytes", async () => {
		const { owner, chat, refs } = await fileChat(["same", "other", "same"]);
		expect(refs[0].sha256).toBe(refs[2].sha256);
		await deleteOlderVersions(
			{ userId: owner.user._id },
			{ conversationId: chat._id, identifier: "report.txt" }
		);
		const rows = await rowsOf(chat._id);
		expect(rows.map((r) => r.sha256)).toEqual([refs[0].sha256]);
		const stored = await collections.conversations.findOne({ _id: chat._id });
		const registry = collectFileArtifacts(
			stored?.messages ?? [],
			new Set(stored?.prunedArtifactVersions)
		);
		expect(registry.artifacts.get("report.txt")?.versions.map((v) => !!v.deleted)).toEqual([
			true,
			true,
			false,
		]);
	});
});

describe("the keep-at-most-N sweep", () => {
	it("reads the environment, and the administrator's value overrides it", async () => {
		expect(parseMaxVersions("")).toBe(0);
		expect(parseMaxVersions("0")).toBe(0);
		expect(parseMaxVersions("abc")).toBe(0);
		expect(parseMaxVersions("5")).toBe(5);
		env.values.ARTIFACT_MAX_VERSIONS = "4";
		expect(await maxArtifactVersions()).toBe(4);
		await setMaxArtifactVersions(2);
		expect(await maxArtifactVersions()).toBe(2);
		await setMaxArtifactVersions(0);
		expect(await maxArtifactVersions()).toBe(0);
		await setMaxArtifactVersions(null);
		expect(await maxArtifactVersions()).toBe(4);
	});

	it("does nothing while the limit is unlimited", async () => {
		const { chat } = await textChat();
		expect(await sweepArtifactVersions(new Date(), true)).toBe(0);
		expect(await pruned(chat._id)).toEqual([]);
	});

	it("keeps the newest N text versions, spares shared ones, and is idempotent", async () => {
		const { owner, chat } = await textChat();
		await createShare(owner.user, {
			conversationId: chat._id,
			target: { kind: "text", identifier: "notes", version: 1 },
		});
		await setMaxArtifactVersions(2);
		expect(await sweepArtifactVersions(new Date(), true)).toBe(0);
		await setMaxArtifactVersions(1);
		expect(await sweepArtifactVersions(new Date(), true)).toBe(1);
		expect(await pruned(chat._id)).toEqual([artifactVersionKey("m2", 0)]);
		expect(await sweepArtifactVersions(new Date(), true)).toBe(0);
		expect(await pruned(chat._id)).toEqual([artifactVersionKey("m2", 0)]);
	});

	it("keeps the newest N file versions and frees the rest", async () => {
		const { chat, refs } = await fileChat();
		await setMaxArtifactVersions(2);
		expect(await sweepArtifactVersions()).toBe(1);
		expect((await rowsOf(chat._id)).map((r) => r.sha256).sort()).toEqual(
			[refs[1].sha256, refs[2].sha256].sort()
		);
		expect(await countBlobs({}, "codeOutputs")).toBe(2);
		expect(await sweepArtifactVersions()).toBe(0);
	});

	it("can prune one conversation on its own terms", async () => {
		const { chat } = await textChat();
		const result = await pruneConversation(chat._id, { keep: 2 });
		expect(result.deleted).toBe(1);
	});
});
