/**
 * File versions follow the conversation's message tree: a version made on one branch (an edit
 * of the first prompt starts another) is not the current one, not "previous", and not listed on
 * the other branch, and a file attached again is the newest content of its name for its turn.
 * Real conversation and deliverable stores; the document service is replaced by two functions
 * that make a file's content visible.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { ObjectId } from "mongodb";
import { collections, ready } from "$lib/server/database";
import { deleteConversationDeliverables } from "$lib/server/execution/deliverables";
import { putBlob } from "$lib/server/blobs/testing";

const service = vi.hoisted(() => ({ outlined: [] as string[], edited: [] as string[] }));
vi.mock("$lib/server/documents/client", async (importOriginal) => ({
	...(await importOriginal<typeof import("$lib/server/documents/client")>()),
	outlineDocument: vi.fn(async (file: { bytes: Buffer }) => {
		service.outlined.push(file.bytes.toString());
		return { format: "docx", blocks: [{ id: "p1" }] };
	}),
	editDocument: vi.fn(
		async (file: { bytes: Buffer }, request: { operations: Array<{ replace?: string }> }) => {
			service.edited.push(file.bytes.toString());
			const text = request.operations.map((op) => op.replace ?? "").join("");
			return {
				format: "docx",
				engine: "test",
				operations: request.operations.map((op, index) => ({ index, ...op })),
				diff: [],
				verify: { ok: true },
				passed_through: [],
				file_name: "x.docx",
				content_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
				bytes: Buffer.from(`${file.bytes.toString()}+${text}`),
			};
		}
	),
}));

const { createDocumentBuiltins } = await import("./documentTools");
const { findConversationFile, listFileVersions } = await import("./conversationFiles");
const { branchOf } = await import("$lib/server/execution/fileVersions");

const CAPS = {
	engine: "test",
	formats: {
		docx: {
			outline: true,
			read: true,
			operations: ["replace_text"],
			operation_schemas: {
				replace_text: {
					type: "object",
					properties: { op: { type: "string" }, replace: { type: "string" } },
					required: ["op", "replace"],
				},
			},
		},
	},
};

beforeAll(async () => {
	await ready;
});

let conversations: ObjectId[] = [];
afterEach(async () => {
	await deleteConversationDeliverables(conversations);
	await collections.conversations.deleteMany({ _id: { $in: conversations } });
	conversations = [];
	service.outlined = [];
	service.edited = [];
});

const NAME = "form.docx";
const ORIGINAL = "blank";
const T0 = Date.parse("2026-01-01T10:00:00Z");
const at = (minutes: number) => new Date(T0 + minutes * 60_000);

/**
 * A conversation whose first prompt was edited and sent again with the same attachment:
 *
 *   u1 (file) - a1            (branch A)
 *   u2 (file) - a2            (branch B, a sibling of u1)
 */
async function setup() {
	const conversationId = new ObjectId();
	conversations.push(conversationId);
	const sha = createHash("sha256").update(ORIGINAL).digest("hex");
	await putBlob(
		`${conversationId}-${sha}`,
		{ conversation: conversationId.toString(), mime: "application/octet-stream" },
		ORIGINAL
	);
	const file = { type: "hash", name: NAME, value: sha, mime: "application/octet-stream" };
	await collections.conversations.insertOne({
		_id: conversationId,
		title: "t",
		model: "m",
		rootMessageId: "u1",
		messages: [
			{
				id: "u1",
				from: "user",
				content: "fill",
				files: [file],
				ancestors: [],
				children: ["a1"],
				createdAt: at(0),
			},
			{
				id: "a1",
				from: "assistant",
				content: "",
				ancestors: ["u1"],
				children: [],
				createdAt: at(1),
			},
			{
				id: "u2",
				from: "user",
				content: "fill (edited)",
				files: [file],
				ancestors: [],
				children: ["a2"],
				createdAt: at(10),
			},
			{
				id: "a2",
				from: "assistant",
				content: "",
				ancestors: ["u2"],
				children: [],
				createdAt: at(11),
			},
		],
		createdAt: at(0),
		updatedAt: at(0),
		sessionId: "s",
	} as never);
	const builtins = createDocumentBuiltins(CAPS as never);
	const tool = (name: string, messageId: string) => {
		const found = builtins.find((t) => t.name === name);
		if (!found) throw new Error(`${name} is not offered`);
		return (args: Record<string, unknown>) =>
			found.execute(args, {
				uuid: "u",
				toolCallId: "t",
				conversationId,
				userId: new ObjectId(),
				messageId,
			} as never);
	};
	return {
		conversationId,
		on: (messageId: string) => ({
			outline: tool("doc_outline", messageId),
			edit: tool("doc_edit", messageId),
		}),
	};
}

const body = (out: unknown) => JSON.parse((out as { resultText: string }).resultText);
const replace = (text: string) => [{ op: "replace_text", replace: text }];

describe("file versions on a conversation branch", () => {
	it("knows a message's branch: itself and its ancestors", async () => {
		const { conversationId } = await setup();
		expect([...((await branchOf(conversationId, "a2")) ?? [])].sort()).toEqual(["a2", "u2"]);
		expect(await branchOf(conversationId, "nope")).toBeUndefined();
		expect(await branchOf(conversationId, undefined)).toBeUndefined();
	});

	it("keeps another branch's edit out of the current version, 'previous' and the list", async () => {
		const { conversationId, on } = await setup();
		const a = on("a1");
		const b = on("a2");

		// Branch A fills the form: version 2, the latest there.
		expect(body(await a.edit({ file: NAME, operations: replace("Rossi") }))).toMatchObject({
			saved: true,
			version: 2,
		});

		// Branch B sees the file as it was sent: the blank original, no other versions.
		const outline = body(await b.outline({ file: NAME }));
		expect(service.outlined.at(-1)).toBe(ORIGINAL);
		expect(outline.file_versions).toBeUndefined();
		expect(await b.outline({ file: NAME, version: 2 })).toMatchObject({
			error: expect.stringContaining('"form.docx" has no version 2'),
		});
		expect(await b.outline({ file: NAME, version: "previous" })).toMatchObject({
			error: expect.stringContaining("no version before its current one"),
		});

		// An edit on B starts from the original; the number is taken from the whole conversation
		// (the unique index), and A's version does not leak into B's list.
		const edited = body(await b.edit({ file: NAME, operations: replace("Bianchi") }));
		expect(service.edited.at(-1)).toBe(ORIGINAL);
		expect(edited).toMatchObject({
			saved: true,
			version: 3,
			started_from: "version 1 (the latest)",
		});
		const listed = body(await b.outline({ file: NAME }));
		expect(listed.file_versions.map((v: { version: number }) => v.version)).toEqual([1, 3]);
		expect(service.outlined.at(-1)).toBe(`${ORIGINAL}+Bianchi`);

		// Branch A still has its own version 2 as the latest, and does not see B's.
		const onA = await findConversationFile(conversationId, NAME, {
			prefer: "output",
			branch: await branchOf(conversationId, "a1"),
		});
		expect(onA.ok && onA.bytes.toString()).toBe(`${ORIGINAL}+Rossi`);
		const listing = await listFileVersions(
			conversationId,
			NAME,
			await branchOf(conversationId, "a1")
		);
		expect(listing?.versions.map((v) => v.version)).toEqual([1, 2]);
		expect(listing?.versions.find((v) => v.current)?.version).toBe(2);
	});

	it("counts everything on every branch when the branch cannot be told", async () => {
		const { conversationId, on } = await setup();
		await on("a1").edit({ file: NAME, operations: replace("Rossi") });
		const unknown = on("not-saved-yet");
		await unknown.outline({ file: NAME });
		expect(service.outlined.at(-1)).toBe(`${ORIGINAL}+Rossi`);
		expect((await findConversationFile(conversationId, NAME)).ok).toBe(true);
	});

	it("makes a file attached again current for its turn, on the same branch too", async () => {
		const { conversationId, on } = await setup();
		await on("a1").edit({ file: NAME, operations: replace("Rossi") });

		// A linear continuation of branch A: the user attaches the same blank form again.
		await collections.conversations.updateOne({ _id: conversationId }, {
			$push: {
				messages: {
					$each: [
						{
							id: "u3",
							from: "user",
							content: "again",
							files: [
								{
									type: "hash",
									name: NAME,
									value: createHash("sha256").update(ORIGINAL).digest("hex"),
									mime: "application/octet-stream",
								},
							],
							ancestors: ["u1", "a1"],
							children: ["a3"],
							createdAt: new Date(Date.now() + 60_000),
						},
						{
							id: "a3",
							from: "assistant",
							content: "",
							ancestors: ["u1", "a1", "u3"],
							children: [],
							createdAt: new Date(Date.now() + 61_000),
						},
					],
				},
			},
		} as never);
		// Before it is sent again, the fill is the current version of the file.
		await on("a1").outline({ file: NAME });
		expect(service.outlined.at(-1)).toBe(`${ORIGINAL}+Rossi`);
		// After: the attachment sent with the turn is the newest content, even though its bytes
		// were already stored.
		await on("a3").outline({ file: NAME });
		expect(service.outlined.at(-1)).toBe(ORIGINAL);
	});
});
