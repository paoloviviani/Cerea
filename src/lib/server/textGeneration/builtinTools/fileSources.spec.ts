/**
 * What a connector file reference sends, against the real conversation and deliverable stores:
 * `/mnt/data/<name>` is byte for byte what the sandbox staging (the browser's AttachmentMounter)
 * puts at that path, `original: true` is the user's upload, `/mnt/output/<name>` the newest produced
 * version.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { ObjectId } from "mongodb";
import { collections, ready } from "$lib/server/database";
import {
	deleteConversationDeliverables,
	markCurrentVersion,
	storeDeliverable,
} from "$lib/server/execution/deliverables";
import { downloadFile } from "$lib/server/files/downloadFile";
import { putBlob } from "$lib/server/blobs/testing";
import { AttachmentMounter, type ProducedFile } from "$lib/utils/execution/attachmentMounter";
import type { AttachmentSource } from "$lib/utils/execution/attachmentNames";
import { findConversationFile } from "./conversationFiles";
import { resolveFileReferences } from "../mcp/fileReferences";

vi.mock("$app/paths", () => ({ base: "" }));

beforeAll(async () => {
	await ready;
});

let conversations: ObjectId[] = [];
afterEach(async () => {
	vi.unstubAllGlobals();
	await deleteConversationDeliverables(conversations);
	await collections.conversations.deleteMany({ _id: { $in: conversations } });
	conversations = [];
});

const T0 = Date.parse("2026-01-01T10:00:00Z");
const at = (minutes: number) => new Date(T0 + minutes * 60_000);
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

interface Upload {
	name: string;
	text: string;
	/** Minutes after T0 that the message carrying it was sent. */
	sentAt?: number;
}

async function setup(uploads: Upload[] = [], extra: Record<string, unknown> = {}) {
	const conversationId = new ObjectId();
	conversations.push(conversationId);
	const messages = [];
	let n = 0;
	for (const upload of uploads) {
		await putBlob(
			`${conversationId}-${sha(upload.text)}`,
			{ conversation: conversationId.toString(), mime: "image/svg+xml" },
			upload.text
		);
		n += 1;
		messages.push({
			id: `u${n}`,
			from: "user",
			content: "here",
			createdAt: at(upload.sentAt ?? 0),
			files: [{ type: "hash", name: upload.name, value: sha(upload.text), mime: "image/svg+xml" }],
		});
	}
	await collections.conversations.insertOne({
		_id: conversationId,
		title: "t",
		model: "m",
		messages,
		createdAt: at(-10),
		updatedAt: at(-10),
		sessionId: "s",
		...extra,
	} as never);
	return conversationId;
}

/** Produce a file, made current at `minutes` after T0. */
async function produce(
	conversationId: ObjectId,
	name: string,
	text: string,
	minutes: number,
	tool = "sandbox",
	messageId?: string
) {
	await storeDeliverable({
		conversationId,
		name,
		// Not an image: the sandbox mounts a produced image only when the code names it.
		mime: "text/plain",
		bytes: Buffer.from(text),
		tool,
		...(messageId ? { messageId } : {}),
	});
	await collections.codeExecutionOutputs.updateOne(
		{ conversationId, name, sha256: sha(text) },
		{ $set: { createdAt: at(minutes) } }
	);
}

const ref = (conversationId: ObjectId, value: Record<string, unknown>, messageId?: string) =>
	resolveFileReferences({ c: value }, { conversationId, ...(messageId ? { messageId } : {}) });
const sent = async (conversationId: ObjectId, value: Record<string, unknown>) => {
	const r = await ref(conversationId, value);
	if (!r.ok) throw new Error(r.error);
	return r.args.c;
};

/** What the sandbox staging (the browser's mounter) puts at /mnt/data/<name>, by name. */
async function staged(conversationId: ObjectId): Promise<Map<string, string>> {
	const conversation = await collections.conversations.findOne({ _id: conversationId });
	const files: AttachmentSource[] = (conversation?.messages ?? []).flatMap((m) =>
		(m.files ?? []).map((f) => ({
			type: "hash" as const,
			name: f.name,
			value: f.value,
			mime: f.mime,
			sentAt: m.createdAt?.getTime(),
		}))
	);
	const rows = await collections.codeExecutionOutputs.find({ conversationId }).toArray();
	const produced: ProducedFile[] = rows.map((row) => ({
		name: row.name,
		size: row.size,
		sha256: row.sha256,
		mime: row.mime,
		createdAt: row.createdAt.toISOString(),
		...(row.latestAt ? { latestAt: row.latestAt.toISOString() } : {}),
	}));
	const bytesOf = async (hash: string): Promise<string> => {
		const row = rows.find((r) => r.sha256 === hash);
		if (row) {
			const { downloadDeliverable } = await import("$lib/server/execution/deliverables");
			return (await downloadDeliverable(conversationId, hash))?.buffer.toString() ?? "";
		}
		return Buffer.from(
			(await downloadFile(hash, conversationId.toString())).value,
			"base64"
		).toString();
	};
	const texts = new Map<string, string>();
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string) => {
			const text = await bytesOf(url.split("/").pop() ?? "");
			return new Response(text, { headers: { "Content-Length": String(Buffer.byteLength(text)) } });
		})
	);
	const mounter = new AttachmentMounter(
		conversationId.toString(),
		{
			loadFiles: async (loaded) => {
				for (const f of loaded) texts.set(f.name, new TextDecoder().decode(f.data as ArrayBuffer));
				return loaded.map((f) => `/mnt/data/${f.name}`);
			},
			removeFile: async () => undefined,
		},
		{ mounted: () => undefined, skipped: () => undefined }
	);
	await mounter.sync(files);
	await mounter.syncProduced(produced);
	return texts;
}

describe("/mnt/data/<name> is what the sandbox mounts there", () => {
	const USER = "<svg>the user's</svg>";
	const MODEL = "<svg>the model's own, longer</svg>";

	it("plain attachment", async () => {
		const id = await setup([{ name: "a.svg", text: USER }]);
		expect(await sent(id, { $file: "/mnt/data/a.svg" })).toBe(USER);
		expect((await staged(id)).get("a.svg")).toBe(USER);
	});

	it("attachment edited by a document tool, and one shadowed by a same-name code output", async () => {
		for (const [tool, name] of [
			["doc_edit", "edited.svg"],
			["sandbox", "shadowed.svg"],
		] as const) {
			const id = await setup([{ name, text: USER, sentAt: 0 }]);
			await produce(id, name, MODEL, 5, tool);
			const staging = await staged(id);
			expect(staging.get(name)).toBe(MODEL);
			expect(await sent(id, { $file: `/mnt/data/${name}` })).toBe(staging.get(name));
			// A bare name means the same path.
			expect(await sent(id, { $file: name })).toBe(staging.get(name));
			// The user's upload is still reachable, as it was.
			expect(await sent(id, { $file: `/mnt/data/${name}`, original: true })).toBe(USER);
			const note = await ref(id, { $file: `/mnt/data/${name}` });
			expect(note.ok && note.notes[0]).toContain(
				`current version: produced by ${tool === "sandbox" ? "code" : tool}, ${Buffer.byteLength(MODEL)} bytes`
			);
		}
	});

	it("an attachment re-sent after the produced file is the one mounted", async () => {
		const id = await setup([{ name: "a.svg", text: USER, sentAt: 10 }]);
		await produce(id, "a.svg", MODEL, 5);
		const staging = await staged(id);
		expect(staging.get("a.svg")).toBe(USER);
		expect(await sent(id, { $file: "/mnt/data/a.svg" })).toBe(USER);
	});

	it("a produced-only file resolves under /mnt/data, as it is mounted", async () => {
		const id = await setup();
		await produce(id, "made.svg", MODEL, 5);
		expect((await staged(id)).get("made.svg")).toBe(MODEL);
		expect(await sent(id, { $file: "/mnt/data/made.svg" })).toBe(MODEL);
		expect(await sent(id, { $file: "/mnt/output/made.svg" })).toBe(MODEL);
	});

	it("`original` on a file that was never attached is an error", async () => {
		const id = await setup();
		await produce(id, "made.svg", MODEL, 5);
		const r = await ref(id, { $file: "/mnt/data/made.svg", original: true });
		expect(r.ok).toBe(false);
	});
});

describe("/mnt/output/<name>", () => {
	it("is the newest produced version, by when it became current, not by version number", async () => {
		const id = await setup([{ name: "a.svg", text: "attached" }]);
		await produce(id, "a.svg", "one", 1);
		await produce(id, "a.svg", "two", 2);
		await produce(id, "a.svg", "three", 3);
		expect(await sent(id, { $file: "/mnt/output/a.svg" })).toBe("three");
		// Restoring version one makes it the newest again, though its number is the lowest.
		await markCurrentVersion(id, "a.svg", sha("one"));
		expect(await sent(id, { $file: "/mnt/output/a.svg" })).toBe("one");
		expect((await staged(id)).get("a.svg")).toBe("one");
		expect(await sent(id, { $file: "/mnt/data/a.svg" })).toBe("one");
	});

	it("stays on the turn's branch", async () => {
		const id = await setup([], {
			messages: [
				{ id: "u1", from: "user", content: "x", ancestors: [], children: ["a1", "a2"] },
				{ id: "a1", from: "assistant", content: "", ancestors: ["u1"], children: [] },
				{ id: "a2", from: "assistant", content: "", ancestors: ["u1"], children: [] },
			],
		});
		await produce(id, "a.svg", "made on branch one", 1, "sandbox", "a1");
		await produce(id, "a.svg", "made on branch two, newer", 2, "sandbox", "a2");
		const one = await ref(id, { $file: "/mnt/output/a.svg" }, "a1");
		expect(one).toMatchObject({ ok: true, args: { c: "made on branch one" } });
		const two = await ref(id, { $file: "/mnt/output/a.svg" }, "a2");
		expect(two).toMatchObject({ ok: true, args: { c: "made on branch two, newer" } });
		const mounted = await ref(id, { $file: "/mnt/data/a.svg" }, "a1");
		expect(mounted).toMatchObject({ ok: true, args: { c: "made on branch one" } });
	});

	it("refuses a name with no produced file", async () => {
		const id = await setup([{ name: "a.svg", text: "attached" }]);
		const none = await findConversationFile(id, "a.svg", { source: "output" });
		expect(none.ok).toBe(false);
	});
});

describe("two uploads with the same name", () => {
	it("/mnt/data/<mount name> answers by the mount name the sandbox uses", async () => {
		const id = await setup([
			{ name: "x.svg", text: "first upload", sentAt: 0 },
			{ name: "x.svg", text: "second upload", sentAt: 1 },
		]);
		const staging = await staged(id);
		expect(staging.get("x.svg")).toBe("first upload");
		expect(staging.get("x (2).svg")).toBe("second upload");
		expect(await sent(id, { $file: "/mnt/data/x.svg" })).toBe("first upload");
		expect(await sent(id, { $file: "/mnt/data/x (2).svg" })).toBe("second upload");
		expect(await sent(id, { $file: "/mnt/data/x.svg", original: true })).toBe("first upload");
	});
});

describe("a withheld attachment", () => {
	it("never resolves, under any form", async () => {
		const id = await setup();
		await collections.conversations.updateOne({ _id: id }, {
			$push: {
				messages: {
					id: "u1",
					from: "user",
					content: "x",
					createdAt: at(0),
					files: [
						{
							type: "hash",
							name: "s.svg",
							value: sha("secret words"),
							mime: "image/svg+xml",
							withheld: { rule: "no-health" },
						},
					],
				},
			},
		} as never);
		for (const value of [
			{ $file: "/mnt/data/s.svg" },
			{ $file: "/mnt/data/s.svg", original: true },
			{ $file: "s.svg" },
		]) {
			const r = await ref(id, value);
			expect(r.ok).toBe(false);
			if (!r.ok) expect(r.error).not.toContain("secret words");
		}
	});
});
