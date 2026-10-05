import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MessageFile } from "$lib/types/Message";

/**
 * The page-facing lifecycle: nothing mounts until a code run asks, the open
 * conversation's files are offered to the sandbox, and leaving takes them back
 * without touching a knowledge mount. The worker session is a fake whose
 * `loadFiles` is the assertion point; the stores are real.
 */
const session = vi.hoisted(() => ({
	loadFiles: vi.fn(async (files: Array<{ name: string }>) =>
		files.map((file) => `/mnt/data/${file.name}`)
	),
	removeFile: vi.fn(async (_path: string) => undefined),
	onStatus: vi.fn(() => () => undefined),
}));

vi.mock("./runtime", () => ({ getExecutionSession: () => session }));

import { getMountsStore } from "./mounts.svelte";
import { setAttachmentSource, withAttachmentMounts } from "./attachmentMounts.svelte";

const file = (value: string, name: string): MessageFile => ({
	type: "hash",
	value,
	name,
	mime: "application/pdf",
	extracted: { value: `${value}-text`, pages: 1 },
});

const served = (url: string) =>
	new Response(`bytes of ${url.split("/").pop()}`, {
		headers: { "Content-Length": "20" },
	});

beforeEach(() => {
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string) => served(url))
	);
});

afterEach(() => {
	setAttachmentSource(null);
	vi.unstubAllGlobals();
	session.loadFiles.mockClear();
	session.removeFile.mockClear();
});

describe("conversation attachments in the sandbox", () => {
	it("runs at once, synchronously, when no conversation is open", () => {
		const run = vi.fn(async () => "ran");
		void withAttachmentMounts(run);
		expect(run).toHaveBeenCalledTimes(1);
		expect(session.loadFiles).not.toHaveBeenCalled();
	});

	it("mounts the open conversation's files before the first run, and shows them as chips", async () => {
		setAttachmentSource({
			conversationId: "c1",
			messages: [{ files: [file("h1", "report.pdf")] }],
		});
		// Registering a source mounts nothing by itself.
		expect(session.loadFiles).not.toHaveBeenCalled();

		const order: string[] = [];
		session.loadFiles.mockImplementationOnce(async (files) => {
			order.push("mount");
			return files.map((f) => `/mnt/data/${f.name}`);
		});
		await withAttachmentMounts(async () => order.push("run"));
		expect(order[0]).toBe("mount");
		expect(order.at(-1)).toBe("run");
		const names = session.loadFiles.mock.calls.flatMap(([files]) => files.map((f) => f.name));
		expect(names.sort()).toEqual(["report.pdf", "report.pdf.md"]);
		expect(
			getMountsStore()
				?.files.map((f) => f.path)
				.sort()
		).toEqual(["/mnt/data/report.pdf", "/mnt/data/report.pdf.md"]);

		// A second run has nothing pending: no new mount, and it runs synchronously.
		session.loadFiles.mockClear();
		const run = vi.fn(async () => "ran");
		void withAttachmentMounts(run);
		expect(run).toHaveBeenCalledTimes(1);
		expect(session.loadFiles).not.toHaveBeenCalled();
	});

	it("mounts files that arrive later, and nothing for a conversation that was left", async () => {
		setAttachmentSource({ conversationId: "c1", messages: [{ files: [file("h1", "a.pdf")] }] });
		await withAttachmentMounts(async () => undefined);
		session.loadFiles.mockClear();

		setAttachmentSource({
			conversationId: "c1",
			messages: [{ files: [file("h1", "a.pdf")] }, { files: [file("h2", "b.pdf")] }],
		});
		await withAttachmentMounts(async () => undefined);
		const names = session.loadFiles.mock.calls.flatMap(([files]) => files.map((f) => f.name));
		expect(names).toContain("b.pdf");
		expect(names).not.toContain("a.pdf");
	});

	it("unmounts on switching conversation and never fetches the other one's files", async () => {
		const mounts = getMountsStore();
		setAttachmentSource({ conversationId: "c1", messages: [{ files: [file("h1", "a.pdf")] }] });
		await withAttachmentMounts(async () => undefined);
		expect(mounts?.files.length).toBeGreaterThan(0);

		setAttachmentSource({ conversationId: "c2", messages: [{ files: [file("h9", "z.pdf")] }] });
		expect(mounts?.files).toEqual([]);
		await withAttachmentMounts(async () => undefined);
		const urls = vi.mocked(fetch).mock.calls.map(([url]) => String(url));
		expect(urls.filter((url) => url.includes("/conversation/c2/"))).toHaveLength(2);
		// c1's files were taken out of the sandbox before c2's went in.
		const removed = session.removeFile.mock.calls.map(([path]) => path);
		expect(removed).toEqual(expect.arrayContaining(["/mnt/data/a.pdf", "/mnt/data/a.pdf.md"]));
		expect(removed).not.toContain("/mnt/data/z.pdf");
		expect(urls.some((url) => url.includes("/conversation/c2/output/h1"))).toBe(false);
	});

	it("takes nothing in for a shared or read-only view (no source)", async () => {
		setAttachmentSource({ conversationId: "c1", messages: [{ files: [file("h1", "a.pdf")] }] });
		setAttachmentSource(null);
		session.loadFiles.mockClear();
		await withAttachmentMounts(async () => undefined);
		expect(session.loadFiles).not.toHaveBeenCalled();
	});

	it("keeps knowledge mounts when the conversation changes", async () => {
		const mounts = getMountsStore();
		await mounts?.addConversationFile("c0", { name: "kb.txt", value: "kbhash" });
		setAttachmentSource({ conversationId: "c1", messages: [{ files: [file("h1", "a.pdf")] }] });
		await withAttachmentMounts(async () => undefined);
		setAttachmentSource({ conversationId: "c2", messages: [] });
		expect(mounts?.files.map((f) => f.name)).toEqual(["kb.txt"]);
	});

	it("shows a file whose fetch failed as not available, still runs, and mounts it once it can", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const mounts = getMountsStore();
		let up = false;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string) => (up ? served(url) : new Response("{}", { status: 404 })))
		);
		setAttachmentSource({ conversationId: "c1", messages: [{ files: [file("h1", "gone.pdf")] }] });

		const run = vi.fn(async () => "ran");
		await withAttachmentMounts(run);
		expect(run).toHaveBeenCalledTimes(1);
		expect(session.loadFiles).not.toHaveBeenCalled();
		expect(mounts?.skipped).toEqual([{ name: "gone.pdf", reason: "the request failed (404)" }]);
		expect(warn.mock.calls.map((call) => String(call[0])).join("\n")).toContain(
			"/conversation/c1/output/h1"
		);

		// The next run retries, and a success clears the note.
		up = true;
		await withAttachmentMounts(async () => undefined);
		expect(mounts?.skipped).toEqual([]);
		expect(mounts?.files.map((f) => f.name)).toContain("gone.pdf");
		warn.mockRestore();
	});

	it("makes a run wait for a mount still in flight, even when there is nothing new to mount", async () => {
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => (release = resolve));
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string) => {
				await gate;
				return served(url);
			})
		);
		setAttachmentSource({ conversationId: "c1", messages: [{ files: [file("h1", "slow.pdf")] }] });

		const order: string[] = [];
		const first = withAttachmentMounts(async () => order.push("first"));
		// Let the first mount reach its fetch, then ask for a second run while
		// every file is already being handled.
		await Promise.resolve();
		const second = withAttachmentMounts(async () => order.push("second"));
		await Promise.resolve();
		expect(order).toEqual([]);

		release?.();
		await Promise.all([first, second]);
		expect(order).toEqual(["first", "second"]);
		expect(session.loadFiles).toHaveBeenCalled();
	});

	it("does not let a mount that blew up stop later mounts", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		session.loadFiles.mockRejectedValueOnce(new Error("worker died"));
		setAttachmentSource({ conversationId: "c1", messages: [{ files: [file("h1", "a.pdf")] }] });
		await withAttachmentMounts(async () => undefined);
		expect(getMountsStore()?.skipped.map((note) => note.name)).toContain("a.pdf");

		session.loadFiles.mockClear();
		await withAttachmentMounts(async () => undefined);
		expect(session.loadFiles).toHaveBeenCalled();
		warn.mockRestore();
	});
});
