/**
 * A project's context documents, through the routes: who may add and remove,
 * the budget and its refusal, a failed extraction that stays listed with its
 * reason, and what deleting leaves behind in the bucket. Extraction itself is
 * mocked (it would call the gateway); everything around it is real.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ObjectId } from "mongodb";

const { extractMock } = vi.hoisted(() => ({ extractMock: vi.fn() }));

vi.mock("$lib/server/files/extractDocument", async (importOriginal) => {
	const actual = await importOriginal<typeof import("$lib/server/files/extractDocument")>();
	return { ...actual, extractDocument: extractMock };
});

import { collections, ready } from "$lib/server/database";
import { cleanupTestData, createTestUser } from "$lib/server/api/__tests__/testHelpers";
import { TEST_ORIGIN, testRequest } from "$lib/server/__tests__/testRequest";
import { PROJECT_DOCUMENTS_MAX_CHARS, PROJECT_DOCUMENTS_MAX_COUNT } from "$lib/types/Memory";
import { buildProjectDocumentsBlock, projectOwnerKey } from "$lib/server/projectDocuments";
import { DELETE as deleteProject } from "../+server";
import { DELETE } from "./[docId]/+server";
import { GET, POST } from "./+server";

beforeAll(async () => {
	await ready;
}, 30000);

beforeEach(() => extractMock.mockReset());

afterEach(async () => {
	await cleanupTestData();
	await collections.projects.deleteMany({});
	await collections.projectDocuments.deleteMany({});
	await collections.bucketFiles.deleteMany({ "metadata.conversation": /^project:/ });
});

async function setup() {
	const { user: owner, locals: ownerLocals } = await createTestUser();
	const member = await createTestUser();
	const outsider = await createTestUser();
	const memberLocals = { ...member.locals, user: { ...member.user, email: "member@example.org" } };
	const outsiderLocals = {
		...outsider.locals,
		user: { ...outsider.user, email: "outsider@example.org" },
	};
	const projectId = new ObjectId();
	await collections.projects.insertOne({
		_id: projectId,
		userId: owner._id,
		name: "P",
		instructions: "",
		knowledgeBaseIds: [],
		indexPastChats: false,
		retrievalLimit: 6,
		shares: [{ kind: "user", email: "member@example.org" }],
		createdAt: new Date(),
		updatedAt: new Date(),
	} as never);
	return { owner, ownerLocals, memberLocals, outsiderLocals, projectId };
}

const base = (projectId: ObjectId) => `/api/v2/projects/${projectId}/documents`;

function upload(
	projectId: ObjectId,
	locals: Partial<App.Locals>,
	name: string,
	content: string | Uint8Array,
	type = "text/plain"
) {
	const form = new FormData();
	form.set("file", new File([content as BlobPart], name, { type }));
	return testRequest(POST, {
		path: base(projectId),
		method: "POST",
		params: { id: projectId.toString() },
		body: form,
		headers: { origin: TEST_ORIGIN },
		locals,
	});
}

const list = (projectId: ObjectId, locals: Partial<App.Locals>) =>
	testRequest(GET, { path: base(projectId), params: { id: projectId.toString() }, locals });

const PDF = "application/pdf";
const pdfBytes = () => new TextEncoder().encode("%PDF-1.4\n% a pretend pdf " + Math.random());

describe("/api/v2/projects/[id]/documents", () => {
	it("stores a text file's original and its text, and lists it with its size and who added it", async () => {
		const { ownerLocals, projectId } = await setup();
		const res = await upload(projectId, ownerLocals, "notes.md", "# Heading\n\nSome notes.", "");
		expect(res.status).toBe(201);
		const { data } = await res.json();
		expect(data.document).toMatchObject({
			name: "notes.md",
			chars: "# Heading\n\nSome notes.".length,
			status: "ready",
			mine: true,
			addedBy: "Test User",
		});
		const files = await collections.bucketFiles
			.find({ "metadata.conversation": projectOwnerKey(projectId) })
			.toArray();
		// The original and the extracted text, both tagged with the document.
		expect(files).toHaveLength(2);
		expect(files.every((f) => f.metadata?.messageId === data.document.id)).toBe(true);
		expect(await buildProjectDocumentsBlock(projectId)).toContain("## notes.md\n# Heading");
	});

	it("reads a document through the chat's extractor, once", async () => {
		const { ownerLocals, projectId } = await setup();
		extractMock.mockResolvedValue({ ok: true, text: "Extracted body.", pages: 3 });
		const res = await upload(projectId, ownerLocals, "report.pdf", pdfBytes(), PDF);
		expect(res.status).toBe(201);
		expect(extractMock).toHaveBeenCalledTimes(1);
		const { data } = await res.json();
		expect(data.document).toMatchObject({ name: "report.pdf", chars: 15, status: "ready" });
		expect(await buildProjectDocumentsBlock(projectId)).toContain("## report.pdf\nExtracted body.");
		expect(extractMock).toHaveBeenCalledTimes(1);
	});

	it("keeps a failed extraction listed with its reason, and out of the prompt", async () => {
		const { ownerLocals, projectId } = await setup();
		extractMock.mockResolvedValue({
			ok: false,
			kind: "no-text",
			reason: "The PDF has no text layer.",
		});
		const res = await upload(projectId, ownerLocals, "scan.pdf", pdfBytes(), PDF);
		expect(res.status).toBe(201);
		const { data } = await res.json();
		expect(data.document).toMatchObject({
			status: "failed",
			chars: 0,
			failure: { kind: "no-text", reason: "The PDF has no text layer." },
		});
		expect(data.usedChars).toBe(0);
		expect(await buildProjectDocumentsBlock(projectId)).toBeUndefined();
		const listed = await (await list(projectId, ownerLocals)).json();
		expect(listed.data.documents).toHaveLength(1);
	});

	it("refuses what it cannot read, and a second copy of a file", async () => {
		const { ownerLocals, projectId } = await setup();
		const png = await upload(
			projectId,
			ownerLocals,
			"a.png",
			new Uint8Array([1, 2, 3]),
			"image/png"
		);
		expect(png.status).toBe(415);
		expect(await upload(projectId, ownerLocals, "a.txt", "same")).toMatchObject({ status: 201 });
		const again = await upload(projectId, ownerLocals, "b.txt", "same");
		expect(again.status).toBe(409);
		expect(await collections.projectDocuments.countDocuments({ projectId })).toBe(1);
	});

	it("refuses an upload that would pass the budget, says why, and leaves nothing behind", async () => {
		const { ownerLocals, projectId } = await setup();
		const near = "a".repeat(PROJECT_DOCUMENTS_MAX_CHARS - 10);
		expect((await upload(projectId, ownerLocals, "near.txt", near)).status).toBe(201);

		const res = await upload(projectId, ownerLocals, "tip.txt", "b".repeat(11));
		expect(res.status).toBe(413);
		expect((await res.json()).message).toMatch(/slower and more expensive/);
		expect(await collections.projectDocuments.countDocuments({ projectId })).toBe(1);
		expect(
			await collections.bucketFiles.countDocuments({
				"metadata.conversation": projectOwnerKey(projectId),
			})
		).toBe(2);

		// Exactly the limit is allowed.
		expect((await upload(projectId, ownerLocals, "fits.txt", "c".repeat(10))).status).toBe(201);
		// And a project already at it refuses before reading anything.
		extractMock.mockClear();
		const full = await upload(projectId, ownerLocals, "more.pdf", pdfBytes(), PDF);
		expect(full.status).toBe(413);
		expect(extractMock).not.toHaveBeenCalled();
	});

	it("refuses a file over 10 MB, and a project over its document count", async () => {
		const { ownerLocals, projectId } = await setup();
		const big = await upload(
			projectId,
			ownerLocals,
			"big.txt",
			new Uint8Array(10 * 1024 * 1024 + 1)
		);
		expect(big.status).toBe(413);
		const now = new Date();
		await collections.projectDocuments.insertMany(
			Array.from({ length: PROJECT_DOCUMENTS_MAX_COUNT }, (_, i) => ({
				_id: new ObjectId(),
				projectId,
				name: `f${i}`,
				mime: "text/plain",
				bytes: 1,
				sha: `sha${i}`,
				chars: 0,
				status: "failed" as const,
				addedByUserId: new ObjectId(),
				createdAt: now,
				updatedAt: now,
			}))
		);
		expect((await upload(projectId, ownerLocals, "one-more.txt", "x")).status).toBe(413);
	});

	it("lets any member add and remove, shows who added each, and 404s a stranger on every verb", async () => {
		const { ownerLocals, memberLocals, outsiderLocals, projectId } = await setup();
		const added = await (await upload(projectId, memberLocals, "m.txt", "from a member")).json();
		const id = added.data.document.id as string;

		const asOwner = await (await list(projectId, ownerLocals)).json();
		expect(asOwner.data.documents[0]).toMatchObject({ mine: false, addedBy: "Test User" });

		expect((await list(projectId, outsiderLocals)).status).toBe(404);
		expect((await upload(projectId, outsiderLocals, "x.txt", "x")).status).toBe(404);
		const strangerDelete = await testRequest(DELETE, {
			path: `${base(projectId)}/${id}`,
			method: "DELETE",
			params: { id: projectId.toString(), docId: id },
			locals: outsiderLocals,
		});
		expect(strangerDelete.status).toBe(404);

		const removed = await testRequest(DELETE, {
			path: `${base(projectId)}/${id}`,
			method: "DELETE",
			params: { id: projectId.toString(), docId: id },
			locals: ownerLocals,
		});
		expect(removed.status).toBe(204);
		expect(await collections.projectDocuments.countDocuments({ projectId })).toBe(0);
	});

	it("reads an uploader whose account is gone as 'deleted user'", async () => {
		const { ownerLocals, projectId } = await setup();
		const now = new Date();
		await collections.projectDocuments.insertOne({
			_id: new ObjectId(),
			projectId,
			name: "old.txt",
			mime: "text/plain",
			bytes: 1,
			sha: "s",
			chars: 0,
			status: "failed",
			addedByUserId: new ObjectId(),
			createdAt: now,
			updatedAt: now,
		});
		const listed = await (await list(projectId, ownerLocals)).json();
		expect(listed.data.documents[0].addedBy).toBe("deleted user");
	});

	it("deleting a document removes its stored entries, and deleting the project removes the rest", async () => {
		const { ownerLocals, projectId } = await setup();
		const one = await (await upload(projectId, ownerLocals, "one.txt", "first")).json();
		await upload(projectId, ownerLocals, "two.txt", "second");
		const stored = () =>
			collections.bucketFiles.countDocuments({
				"metadata.conversation": projectOwnerKey(projectId),
			});
		expect(await stored()).toBe(4);

		await testRequest(DELETE, {
			path: `${base(projectId)}/${one.data.document.id}`,
			method: "DELETE",
			params: { id: projectId.toString(), docId: one.data.document.id },
			locals: ownerLocals,
		});
		expect(await stored()).toBe(2);
		expect(await buildProjectDocumentsBlock(projectId)).not.toContain("first");

		const res = await testRequest(deleteProject, {
			path: `/api/v2/projects/${projectId}`,
			method: "DELETE",
			params: { id: projectId.toString() },
			locals: ownerLocals,
		});
		expect(res.status).toBe(204);
		expect(await stored()).toBe(0);
		expect(await collections.projectDocuments.countDocuments({ projectId })).toBe(0);
	});
});
