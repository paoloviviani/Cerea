import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The mount path's fetches carry the app's base path. Live serves the chat at
 * `/chat` (the kit's Caddy route), and a fetch spelled `/conversation/…` there
 * reaches the gateway instead of the app: every mount is skipped and the
 * sandbox's `/mnt/data` is empty — the attachment, the produced versions and
 * the knowledge documents alike, in every load mode. The default e2e run and
 * the other suites run at the root, where a missing base is invisible, so the
 * base is pinned here the way the deployment shapes it.
 */
vi.mock("$app/paths", () => ({ base: "/chat" }));

const sandbox = vi.hoisted(() => ({ fs: new Map<string, string>() }));
const session = vi.hoisted(() => ({
	loadFiles: vi.fn(async (files: Array<{ name: string; data: ArrayBuffer | string }>) =>
		files.map((file) => {
			const text =
				typeof file.data === "string"
					? file.data
					: new TextDecoder().decode(file.data as ArrayBuffer);
			sandbox.fs.set(`/mnt/data/${file.name}`, text);
			return `/mnt/data/${file.name}`;
		})
	),
	removeFile: vi.fn(async (path: string) => {
		sandbox.fs.delete(path);
	}),
	onStatus: vi.fn(() => () => undefined),
}));

vi.mock("./runtime", () => ({ getExecutionSession: () => session }));

import type { ProducedFile } from "./attachmentMounter";
import { AttachmentMounter } from "./attachmentMounter";
import type { AttachmentSource } from "./attachmentNames";
import { setAttachmentSource, withAttachmentMounts } from "./attachmentMounts.svelte";
import { mountConversationFile, mountKnowledgeFile, type KnowledgeFileRef } from "./files";
import type { MessageFile } from "$lib/types/Message";

const pdf = (value: string, name: string, extracted?: string): AttachmentSource => ({
	type: "hash",
	value,
	name,
	mime: "application/pdf",
	...(extracted ? { extracted: { value: extracted } } : {}),
});

const file = (value: string, name: string): MessageFile => ({
	type: "hash",
	value,
	name,
	mime: "application/pdf",
});

/** What the conversation's produced files are, as the list endpoint answers. */
let produced: ProducedFile[] = [];

const served = (url: string) =>
	url.endsWith("/code-execution/output")
		? Response.json({ files: produced })
		: url.endsWith("/content")
			? Response.json({ filename: "notes.md", text: "indexed text" })
			: new Response(`bytes of ${url.split("/").pop()}`, {
					headers: { "Content-Length": "20" },
				});

beforeEach(() => {
	produced = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string) => served(url))
	);
});

afterEach(() => {
	setAttachmentSource(null);
	sandbox.fs.clear();
	vi.unstubAllGlobals();
	session.loadFiles.mockClear();
	session.removeFile.mockClear();
});

describe("the mount path's URLs under the deployment's base path", () => {
	it("fetches an attachment and its extracted text under the base", async () => {
		const fetched: string[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string) => {
				fetched.push(url);
				return served(url);
			})
		);
		const mounter = new AttachmentMounter("conv1", session, {
			mounted: () => undefined,
			skipped: () => undefined,
		});
		await mounter.sync([pdf("h1", "form.pdf", "t1")]);
		expect(fetched).toEqual([
			"/chat/conversation/conv1/output/h1",
			"/chat/conversation/conv1/output/t1",
		]);
	});

	it("fetches a produced file under the base", async () => {
		const fetched: string[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string) => {
				fetched.push(url);
				return served(url);
			})
		);
		const mounter = new AttachmentMounter("conv1", session, {
			mounted: () => undefined,
			skipped: () => undefined,
		});
		produced.push({
			name: "form.pdf",
			size: 20,
			sha256: "p1",
			createdAt: new Date().toISOString(),
			version: 2,
		});
		// The list itself is fetched by the page's store, pinned below.
		await mounter.syncProduced(produced);
		expect(fetched).toEqual(["/chat/conversation/conv1/code-execution/output/p1"]);
	});

	it("lists the conversation's produced files under the base before a run", async () => {
		produced.push({
			name: "form.pdf",
			size: 20,
			sha256: "p1",
			createdAt: new Date().toISOString(),
			version: 2,
		});
		setAttachmentSource({ conversationId: "c1", messages: [{ files: [file("h1", "form.pdf")] }] });
		await withAttachmentMounts(async () => undefined);
		const urls = vi.mocked(fetch).mock.calls.map(([url]) => String(url));
		expect(urls).toContain("/chat/conversation/c1/code-execution/output");
		expect(urls).toContain("/chat/conversation/c1/output/h1");
	});

	it("mounts a message attachment and a knowledge document under the base", async () => {
		const fetched: string[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string) => {
				fetched.push(url);
				return served(url);
			})
		);
		await mountConversationFile(session as never, "conv1", { name: "form.pdf", value: "h1" });
		const ref: KnowledgeFileRef = {
			storeId: "s1",
			storeName: "Notes",
			documentId: "d1",
			title: "Notes",
			filename: "notes.md",
		};
		await mountKnowledgeFile(session as never, ref);
		expect(fetched).toEqual([
			"/chat/conversation/conv1/output/h1",
			"/chat/api/v2/gateway/vector_stores/s1/files/d1/content",
		]);
	});
});
