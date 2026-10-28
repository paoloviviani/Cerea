/**
 * Earlier versions of a file: the real conversation and deliverable stores
 * (in-memory Mongo), the document service replaced by two functions that make
 * a file's content visible, so "derives from version 1" can be asserted on bytes.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { ObjectId } from "mongodb";
import { collections, ready } from "$lib/server/database";
import {
	deleteConversationDeliverables,
	storeDeliverable,
} from "$lib/server/execution/deliverables";

const service = vi.hoisted(() => ({
	outlined: [] as string[],
	edited: [] as string[],
}));
vi.mock("$lib/server/documents/client", async (importOriginal) => ({
	...(await importOriginal<typeof import("$lib/server/documents/client")>()),
	outlineDocument: vi.fn(async (file: { bytes: Buffer }) => {
		service.outlined.push(file.bytes.toString());
		return { format: "docx", blocks: [{ id: "p1" }] };
	}),
	// An edit appends its replacement text, so the result shows what it started from.
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
				// "=x" makes exactly "x", for an edit that lands on an earlier version's bytes.
				bytes: Buffer.from(
					text.startsWith("=") ? text.slice(1) : `${file.bytes.toString()}+${text}`
				),
			};
		}
	),
}));

const { createDocumentBuiltins } = await import("./documentTools");
const { findConversationFile, listFileVersions, parseVersion } =
	await import("./conversationFiles");

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

async function setup(attachment?: { name: string; bytes: string }) {
	const conversationId = new ObjectId();
	conversations.push(conversationId);
	const sha = attachment ? createHash("sha256").update(attachment.bytes).digest("hex") : undefined;
	if (attachment && sha) {
		const upload = collections.bucket.openUploadStream(`${conversationId}-${sha}`, {
			metadata: { conversation: conversationId.toString(), mime: "application/pdf" },
		});
		upload.end(Buffer.from(attachment.bytes));
		await new Promise((resolve) => upload.once("finish", resolve));
	}
	await collections.conversations.insertOne({
		_id: conversationId,
		title: "t",
		model: "m",
		messages: attachment
			? [
					{
						id: "m1",
						from: "user",
						content: "here",
						files: [
							{
								type: "hash",
								name: attachment.name,
								value: sha as string,
								mime: "application/pdf",
							},
						],
					},
				]
			: [],
		createdAt: new Date(),
		updatedAt: new Date(),
		sessionId: "s",
	} as never);
	const builtins = createDocumentBuiltins(CAPS as never);
	const tool = (name: string) => {
		const found = builtins.find((t) => t.name === name);
		if (!found) throw new Error(`${name} is not offered`);
		return (args: Record<string, unknown>) =>
			found.execute(args, {
				uuid: "u",
				toolCallId: "t",
				conversationId,
				userId: new ObjectId(),
			} as never);
	};
	return {
		conversationId,
		outline: tool("doc_outline"),
		edit: tool("doc_edit"),
	};
}

const body = (out: unknown) => JSON.parse((out as { resultText: string }).resultText);
const replace = (text: string) => [{ op: "replace_text", replace: text }];

async function makeFirst(conversationId: ObjectId, name: string, content: string) {
	await storeDeliverable({
		conversationId,
		name,
		mime: "application/octet-stream",
		bytes: Buffer.from(content),
		tool: "doc_create",
		summary: "created: Letter",
	});
}

describe("versions of a file", () => {
	it("edits twice, outlines version 1, edits from version 1 into version 4 and lists them", async () => {
		const { conversationId, outline, edit } = await setup();
		await makeFirst(conversationId, "letter.docx", "v1");

		expect(body(await edit({ file: "letter.docx", operations: replace("a") }))).toMatchObject({
			saved: true,
			version: 2,
			started_from: "version 1 (the latest)",
		});
		expect(body(await edit({ file: "letter.docx", operations: replace("b") }))).toMatchObject({
			version: 3,
		});

		// Version 1 is still readable, and the outline says it is not the latest.
		const first = body(await outline({ file: "letter.docx", version: 1 }));
		expect(service.outlined.at(-1)).toBe("v1");
		expect(first.file_version).toBe(1);
		expect(first.file_versions).toHaveLength(3);

		// An edit from version 1 is the new latest, version 4, and derives from version 1.
		const fourth = body(await edit({ file: "letter.docx", version: 1, operations: replace("c") }));
		expect(service.edited.at(-1)).toBe("v1");
		expect(fourth).toMatchObject({
			saved: true,
			version: 4,
			started_from: "version 1",
			derived_from: "letter.docx (version 1)",
		});
		const latest = await findConversationFile(conversationId, "letter.docx");
		expect(latest.ok && latest.bytes.toString()).toBe("v1+c");
		expect(latest.ok && latest.version).toBe(4);

		const listed = body(await outline({ file: "letter.docx" }));
		expect(listed.file_versions.map((v: { version: number }) => v.version)).toEqual([1, 2, 3, 4]);
		expect(listed.file_versions[0]).toMatchObject({
			tool: "doc_create",
			summary: "created: Letter",
		});
		expect(listed.file_versions[3]).toMatchObject({
			tool: "doc_edit",
			summary: "replace_text; from version 1",
			latest: true,
		});
	});

	it("resolves 'previous', and says plainly what is wrong with a bad version", async () => {
		const { conversationId, outline, edit } = await setup();
		await makeFirst(conversationId, "letter.docx", "v1");
		await edit({ file: "letter.docx", operations: replace("a") });

		await outline({ file: "letter.docx", version: "previous" });
		expect(service.outlined.at(-1)).toBe("v1");

		const missing = await outline({ file: "letter.docx", version: 9 });
		expect(missing).toMatchObject({
			error: expect.stringContaining('"letter.docx" has no version 9. Its versions: 1: doc_create'),
		});
		expect(await outline({ file: "letter.docx", version: "newest" })).toMatchObject({
			error: expect.stringContaining("`version` is a whole number from 1"),
		});
		expect(await outline({ file: "letter.docx", version: 0 })).toMatchObject({
			error: expect.stringContaining("`version` is a whole number from 1"),
		});
		expect(parseVersion("Previous")).toEqual({ ok: true, version: "previous" });
		expect(service.edited).toHaveLength(1);
	});

	it("restores an earlier version with no operations, and says which one it started from", async () => {
		const { conversationId, outline, edit } = await setup();
		await makeFirst(conversationId, "letter.docx", "v1");
		await edit({ file: "letter.docx", operations: replace("a") });

		const restored = body(await edit({ file: "letter.docx", version: 1 }));
		expect(restored).toMatchObject({
			saved: true,
			restored: true,
			version: 1,
			started_from: "version 1",
		});
		// The service was not asked to do anything.
		expect(service.edited).toHaveLength(1);
		const latest = await findConversationFile(conversationId, "letter.docx");
		expect(latest.ok && latest.bytes.toString()).toBe("v1");
		expect(latest.ok && latest.version).toBe(1);

		// Version 2 keeps its number, and the next edit builds on the restored file.
		const listed = body(await outline({ file: "letter.docx" }));
		expect(listed.file_versions.map((v: { latest?: boolean }) => v.latest === true)).toEqual([
			true,
			false,
		]);
		expect(body(await edit({ file: "letter.docx", operations: replace("z") }))).toMatchObject({
			version: 3,
		});
		expect(service.edited.at(-1)).toBe("v1");

		expect(body(await edit({ file: "letter.docx", version: 3 }))).toMatchObject({
			saved: false,
			note: expect.stringContaining("already the latest"),
		});
	});

	it("counts the attachment as version 1, restores it, and numbers edits from 2", async () => {
		const { conversationId, edit } = await setup({ name: "form.pdf", bytes: "ORIGINAL" });
		expect(body(await edit({ file: "form.pdf", operations: replace("1") }))).toMatchObject({
			version: 2,
			derived_from: "form.pdf (the attachment)",
		});

		const restored = body(await edit({ file: "form.pdf", version: 1 }));
		expect(restored).toMatchObject({ restored: true, version: 3 });
		const latest = await findConversationFile(conversationId, "form.pdf");
		expect(latest.ok && latest.bytes.toString()).toBe("ORIGINAL");

		const listing = await listFileVersions(conversationId, "form.pdf");
		expect(listing?.versions.map((v) => [v.version, v.tool, v.current])).toEqual([
			[1, "attachment", false],
			[2, "doc_edit", false],
			[3, "doc_edit", true],
		]);
	});

	it("an edit that gives back an earlier version's bytes makes that version the latest again", async () => {
		const { conversationId, edit } = await setup();
		await makeFirst(conversationId, "letter.docx", "v1");
		await edit({ file: "letter.docx", operations: replace("x") });
		const back = body(await edit({ file: "letter.docx", operations: replace("=v1") }));
		expect(back).toMatchObject({ saved: true, version: 1 });
		const latest = await findConversationFile(conversationId, "letter.docx");
		expect(latest.ok && latest.version).toBe(1);
	});

	it("an edit that changes nothing says the latest version is unchanged", async () => {
		const { conversationId, edit } = await setup();
		await makeFirst(conversationId, "letter.docx", "v1");
		await edit({ file: "letter.docx", operations: replace("x") });
		const same = body(await edit({ file: "letter.docx", version: 1, operations: replace("=v1") }));
		expect(same).toMatchObject({ saved: false });
		expect(same.note).toContain("The latest version is still 2");
	});
});
