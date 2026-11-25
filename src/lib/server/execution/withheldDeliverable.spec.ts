import { beforeEach, describe, expect, it, vi } from "vitest";
import { ObjectId } from "mongodb";

const conversationId = new ObjectId();
const row = vi.hoisted(() => ({
	value: undefined as Record<string, unknown> | undefined,
}));

vi.mock("$lib/server/database", () => ({
	collections: {
		codeExecutionOutputs: {
			findOne: async () => row.value,
			updateMany: async (_f: unknown, update: { $set: Record<string, unknown> }) => {
				Object.assign(row.value ?? {}, update.$set);
			},
			find: () => ({ sort: () => ({ toArray: async () => (row.value ? [row.value] : []) }) }),
			updateOne: async () => undefined,
		},
		conversations: { findOne: async () => ({ messages: [] }) },
		blobStore: { read: async () => Buffer.from("secret bytes") },
	},
}));
vi.mock("$lib/server/logger", () => ({
	logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("$lib/server/exitHandler", () => ({ onExit: vi.fn() }));
vi.mock("$lib/server/office/previewStore", () => ({
	previewInBackground: vi.fn(),
	previewOwner: vi.fn(),
	releasePreviewOwnerStrings: vi.fn(),
	wantsEagerPreview: () => false,
}));
vi.mock("$lib/server/artifactVersions/prune", () => ({ sweepArtifactVersions: vi.fn() }));

const { downloadDeliverable, openDeliverable, withholdDeliverable, WithheldDeliverableError } =
	await import("./deliverables");
const { findConversationFile } =
	await import("$lib/server/textGeneration/builtinTools/conversationFiles");

beforeEach(() => {
	row.value = {
		_id: new ObjectId(),
		conversationId,
		sha256: "abc",
		name: "fetched.pdf",
		mime: "application/pdf",
		size: 12,
		gridFsId: new ObjectId(),
		version: 1,
		createdAt: new Date(),
	};
});

describe("a produced file the document reader was refused", () => {
	it("is read by nothing once withheld: not downloadDeliverable, openDeliverable, or the tools' lookup", async () => {
		expect((await downloadDeliverable(conversationId, "abc"))?.buffer.toString()).toBe(
			"secret bytes"
		);
		expect((await findConversationFile(conversationId, "fetched.pdf")).ok).toBe(true);

		await withholdDeliverable(conversationId, "abc", { rule: "no-pii", pipeline: "eu" });

		await expect(downloadDeliverable(conversationId, "abc")).rejects.toBeInstanceOf(
			WithheldDeliverableError
		);
		await expect(openDeliverable(conversationId, "abc")).rejects.toBeInstanceOf(
			WithheldDeliverableError
		);
		// doc_read, doc_outline, doc_edit, look_doc, view_image and convert_document all resolve files here.
		const found = await findConversationFile(conversationId, "fetched.pdf");
		expect(found).toMatchObject({ ok: false });
		expect(found.ok === false && found.error).toMatch(/privacy rule 'no-pii'.*must not be read/);
	});
});
