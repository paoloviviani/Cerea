import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MessageFile } from "$lib/types/Message";

/**
 * The page-facing lifecycle: nothing mounts until a code run asks, the open
 * conversation's files are offered to the sandbox, and leaving takes them back
 * without touching a knowledge mount. The worker session is a fake whose
 * `loadFiles` is the assertion point; the stores are real.
 */
const sandbox = vi.hoisted(() => ({ fs: new Map<string, string>() }));
const session = vi.hoisted(() => ({
	loadFiles: vi.fn(async (files: Array<{ name: string; data: ArrayBuffer | string }>) =>
		files.map((file) => {
			// What `execute_code` would list: the file and the bytes it holds.
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

import { getMountsStore } from "./mounts.svelte";
import { mount, unmount } from "svelte";
import { setAttachmentSource, withAttachmentMounts } from "./attachmentMounts.svelte";
import AttachmentSourceFixture from "./AttachmentSourceFixture.svelte";
import type { ProducedFile } from "./attachmentMounter";

const file = (value: string, name: string): MessageFile => ({
	type: "hash",
	value,
	name,
	mime: "application/pdf",
	extracted: { value: `${value}-text`, pages: 1 },
});

/** What the conversation's produced files are, as the list endpoint answers. */
let produced: ProducedFile[] = [];

const served = (url: string) =>
	url.endsWith("/code-execution/output")
		? Response.json({ files: produced })
		: new Response(`bytes of ${url.split("/").pop()}`, {
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
	produced = [];
	sandbox.fs.clear();
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

		// A second run mounts nothing again (it only asks which files the conversation has now).
		session.loadFiles.mockClear();
		const run = vi.fn(async () => "ran");
		await withAttachmentMounts(run);
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
		// z.pdf and its text, and the list of the conversation's produced files.
		expect(urls.filter((url) => url.includes("/conversation/c2/"))).toHaveLength(3);
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

	it("makes a run wait for a mount still in flight", async () => {
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

/** The model's view: what `execute_code` lists at /mnt/data once the run's mounts have settled. */
const listing = () => [...sandbox.fs.keys()].sort();

describe("every file of the conversation is in /mnt/data", () => {
	const pdf = (): MessageFile => ({
		type: "hash",
		value: "h1",
		name: "form.pdf",
		mime: "application/pdf",
	});

	it("mounts an attached PDF for the first run", async () => {
		setAttachmentSource({ conversationId: "c1", messages: [{ files: [pdf()] }] });
		await withAttachmentMounts(async () => undefined);
		expect(listing()).toEqual(["/mnt/data/form.pdf"]);
	});

	it("mounts what the document tools produced, and the latest version where a name has several", async () => {
		produced = [
			{ name: "form.pdf", size: 9, sha256: "v2", createdAt: "2026-10-28T10:00:00Z" },
			{ name: "form.pdf", size: 9, sha256: "v3", createdAt: "2026-10-28T10:05:00Z" },
			{ name: "letter.docx", size: 9, sha256: "l1", createdAt: "2026-10-28T10:06:00Z" },
		];
		setAttachmentSource({ conversationId: "c1", messages: [{ files: [pdf()] }] });
		await withAttachmentMounts(async () => undefined);

		// The produced file replaces the attachment of the same name, and only its latest version is fetched.
		expect(listing()).toEqual(["/mnt/data/form.pdf", "/mnt/data/letter.docx"]);
		expect(sandbox.fs.get("/mnt/data/form.pdf")).toBe("bytes of v3");
		const urls = vi.mocked(fetch).mock.calls.map(([url]) => String(url));
		expect(urls.some((url) => url.endsWith("/code-execution/output/v2"))).toBe(false);
	});

	it("follows a version saved between two runs, and a restore of an older one", async () => {
		produced = [{ name: "form.pdf", size: 9, sha256: "v2", createdAt: "2026-10-28T10:00:00Z" }];
		setAttachmentSource({ conversationId: "c1", messages: [{ files: [pdf()] }] });
		await withAttachmentMounts(async () => undefined);
		expect(sandbox.fs.get("/mnt/data/form.pdf")).toBe("bytes of v2");

		produced = [
			...produced,
			{ name: "form.pdf", size: 9, sha256: "v3", createdAt: "2026-10-28T10:05:00Z" },
		];
		await withAttachmentMounts(async () => undefined);
		expect(sandbox.fs.get("/mnt/data/form.pdf")).toBe("bytes of v3");

		// Version 2 was restored: it is the latest again, though v3 was made later.
		produced = [
			{
				name: "form.pdf",
				size: 9,
				sha256: "v2",
				createdAt: "2026-10-28T10:00:00Z",
				latestAt: "2026-10-28T10:10:00Z",
			},
			produced[1],
		];
		await withAttachmentMounts(async () => undefined);
		expect(sandbox.fs.get("/mnt/data/form.pdf")).toBe("bytes of v2");

		// Nothing changed: nothing is fetched or written again.
		session.loadFiles.mockClear();
		await withAttachmentMounts(async () => undefined);
		expect(session.loadFiles).not.toHaveBeenCalled();
	});

	it("takes produced files out with the conversation", async () => {
		produced = [{ name: "letter.docx", size: 9, sha256: "l1", createdAt: "2026-10-28T10:00:00Z" }];
		setAttachmentSource({ conversationId: "c1", messages: [] });
		await withAttachmentMounts(async () => undefined);
		expect(listing()).toEqual(["/mnt/data/letter.docx"]);

		setAttachmentSource({ conversationId: "c2", messages: [] });
		produced = [];
		await withAttachmentMounts(async () => undefined);
		expect(listing()).toEqual([]);
	});

	it("a code card that runs the moment the page mounts already finds the attached files", async () => {
		const seen: string[][] = [];
		const target = document.createElement("div");
		document.body.append(target);
		const app = mount(AttachmentSourceFixture, {
			target,
			props: {
				files: [pdf()],
				// The card's run, as `RunsStore.run` does it: mounts first, then the code.
				run: () => void withAttachmentMounts(async () => seen.push(listing())),
			},
		});
		await vi.waitFor(() => expect(seen).toHaveLength(1));
		expect(seen[0]).toEqual(["/mnt/data/form.pdf"]);
		void unmount(app);
		target.remove();
	});

	it("goes ahead with what is mounted when the list of produced files stalls", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init?: { signal?: AbortSignal }) => {
				if (!url.endsWith("/code-execution/output")) return served(url);
				// A list that never answers: only the run's own deadline ends it.
				return new Promise<Response>((_resolve, reject) =>
					init?.signal?.addEventListener("abort", () => reject(init.signal?.reason))
				);
			})
		);
		setAttachmentSource({ conversationId: "c1", messages: [{ files: [pdf()] }] });
		const run = vi.fn(async () => "ran");
		await withAttachmentMounts(run);
		expect(run).toHaveBeenCalledTimes(1);
		expect(listing()).toEqual(["/mnt/data/form.pdf"]);
		warn.mockRestore();
	}, 15000);

	it("mounts an image output only for code that names it", async () => {
		produced = [
			{
				name: "figure-1.png",
				size: 9,
				sha256: "i1",
				mime: "image/png",
				createdAt: "2026-10-28T10:00:00Z",
			},
		];
		setAttachmentSource({ conversationId: "c1", messages: [] });
		await withAttachmentMounts(async () => undefined, "print(1)");
		expect(listing()).toEqual([]);
		await withAttachmentMounts(async () => undefined, 'open("/mnt/data/figure-1.png")');
		expect(listing()).toEqual(["/mnt/data/figure-1.png"]);
	});
});
