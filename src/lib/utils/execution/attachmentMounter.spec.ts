import { afterEach, describe, expect, it, vi } from "vitest";
import { AttachmentMounter, type MounterSession } from "./attachmentMounter";
import { MAX_ATTACHMENT_FILE_BYTES, type AttachmentSource } from "./attachmentNames";

const pdf = (value: string, name: string, extracted?: string): AttachmentSource => ({
	type: "hash",
	value,
	name,
	mime: "application/pdf",
	...(extracted ? { extracted: { value: extracted } } : {}),
});

function setup(responses: Record<string, Response | (() => Response)>) {
	const fetched: string[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string) => {
			fetched.push(url);
			const made = responses[url];
			if (!made) return new Response("{}", { status: 404 });
			return typeof made === "function" ? made() : made;
		})
	);
	const loaded: Array<{ name: string; data: ArrayBuffer | string }> = [];
	const removed: string[] = [];
	const session: MounterSession = {
		loadFiles: async (files) => {
			loaded.push(...files);
			return files.map((f) => `/mnt/data/${f.name}`);
		},
		removeFile: async (path) => {
			removed.push(path);
		},
	};
	const mounted: string[] = [];
	const skipped: Array<{ name: string; reason: string }> = [];
	const mounter = new AttachmentMounter("conv1", session, {
		mounted: (file) => mounted.push(file.path),
		skipped: (note) => skipped.push(note),
	});
	return { mounter, fetched, loaded, removed, mounted, skipped };
}

const body = (text: string) =>
	new Response(text, { headers: { "Content-Length": String(text.length) } });

afterEach(() => vi.unstubAllGlobals());

describe("AttachmentMounter", () => {
	it("mounts the original bytes and the extracted text through the conversation's route", async () => {
		const { mounter, fetched, loaded, mounted } = setup({
			"/conversation/conv1/output/h1": body("PDFBYTES"),
			"/conversation/conv1/output/t1": body("# extracted"),
		});
		await mounter.sync([pdf("h1", "report.pdf", "t1")]);
		expect(mounted).toEqual(["/mnt/data/report.pdf", "/mnt/data/report.pdf.md"]);
		expect(new TextDecoder().decode(loaded[0].data as ArrayBuffer)).toBe("PDFBYTES");
		expect(new TextDecoder().decode(loaded[1].data as ArrayBuffer)).toBe("# extracted");
		// Only this conversation's route is ever asked.
		expect(fetched.every((url) => url.startsWith("/conversation/conv1/output/"))).toBe(true);
	});

	it("mounts lazily and only what is new on the next sync", async () => {
		const { mounter, fetched } = setup({
			"/conversation/conv1/output/h1": body("one"),
			"/conversation/conv1/output/h2": body("two"),
			"/conversation/conv1/output/t1": body("text"),
		});
		await mounter.sync([pdf("h1", "a.pdf")]);
		expect(fetched).toEqual(["/conversation/conv1/output/h1"]);
		expect(mounter.needsSync([pdf("h1", "a.pdf")])).toBe(false);
		// A second file arrives, and the first one's text turns up.
		const next = [pdf("h1", "a.pdf", "t1"), pdf("h2", "b.pdf")];
		expect(mounter.needsSync(next)).toBe(true);
		await mounter.sync(next);
		expect(fetched.slice(1).sort()).toEqual([
			"/conversation/conv1/output/h2",
			"/conversation/conv1/output/t1",
		]);
	});

	it("mounts a file from this turn from its own bytes, without a request", async () => {
		const { mounter, fetched, loaded } = setup({});
		await mounter.sync([
			{ type: "base64", name: "data.csv", mime: "text/csv", value: btoa("a,b\n1,2\n") },
		]);
		expect(fetched).toEqual([]);
		expect(new TextDecoder().decode(loaded[0].data as ArrayBuffer)).toBe("a,b\n1,2\n");
	});

	it("skips a file over 20 MB by its declared size and says so", async () => {
		const { mounter, loaded, skipped } = setup({
			"/conversation/conv1/output/h1": new Response("x", {
				headers: { "Content-Length": String(MAX_ATTACHMENT_FILE_BYTES + 1) },
			}),
			"/conversation/conv1/output/h2": body("small"),
		});
		await mounter.sync([pdf("h1", "huge.bin"), pdf("h2", "small.txt")]);
		expect(loaded.map((f) => f.name)).toEqual(["small.txt"]);
		expect(skipped).toHaveLength(1);
		expect(skipped[0].name).toBe("huge.bin");
		expect(skipped[0].reason).toContain("20 MB");
		// Not retried every run.
		expect(mounter.needsSync([pdf("h1", "huge.bin"), pdf("h2", "small.txt")])).toBe(false);
	});

	it("stops mounting past 100 MB in total", async () => {
		const chunk = 19 * 1024 * 1024;
		const big = () =>
			new Response(new Uint8Array(chunk), { headers: { "Content-Length": String(chunk) } });
		const responses: Record<string, () => Response> = {};
		const files = Array.from({ length: 6 }, (_, i) => {
			responses[`/conversation/conv1/output/h${i}`] = big;
			return pdf(`h${i}`, `f${i}.bin`);
		});
		const { mounter, loaded, skipped } = setup(responses);
		await mounter.sync(files);
		expect(loaded).toHaveLength(5);
		expect(skipped.map((s) => s.name)).toEqual(["f5.bin"]);
		expect(skipped[0].reason).toContain("100 MB");
	});

	it("retries a failed download on the next sync, and never throws", async () => {
		const { mounter, skipped } = setup({});
		await expect(mounter.sync([pdf("h1", "a.pdf")])).resolves.toBeUndefined();
		expect(skipped[0].name).toBe("a.pdf");
		expect(mounter.needsSync([pdf("h1", "a.pdf")])).toBe(true);
	});

	it("warns with the URL and the status of a failed fetch, and reports the reason on the chip", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const { mounter, skipped } = setup({
			"/conversation/conv1/output/h1": new Response("{}", { status: 403 }),
		});
		await mounter.sync([pdf("h1", "a.pdf")]);
		expect(skipped).toEqual([{ name: "a.pdf", reason: "the request failed (403)" }]);
		const line = warn.mock.calls.map((call) => String(call[0])).join("\n");
		expect(line).toContain("/conversation/conv1/output/h1");
		expect(line).toContain("status 403");
		expect(line).toContain("a.pdf");
		warn.mockRestore();
	});

	it("warns and reports when the sandbox refuses a file", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => body("x"))
		);
		const skipped: Array<{ name: string; reason: string }> = [];
		const mounter = new AttachmentMounter(
			"conv1",
			{
				loadFiles: async () => {
					throw new Error("the worker is gone");
				},
				removeFile: async () => undefined,
			},
			{ mounted: () => undefined, skipped: (note) => skipped.push(note) }
		);
		await mounter.sync([pdf("h1", "a.pdf")]);
		expect(skipped).toEqual([{ name: "a.pdf", reason: "the worker is gone" }]);
		expect(warn.mock.calls.map((call) => String(call[0])).join("\n")).toContain("a.pdf");
		warn.mockRestore();
	});

	it("reports an undecodable inline file instead of throwing, and still mounts the others", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const { mounter, skipped, mounted } = setup({
			"/conversation/conv1/output/h2": body("fine"),
		});
		await expect(
			mounter.sync([
				{
					type: "base64",
					value: "not base64 !!",
					name: "bad.bin",
					mime: "application/octet-stream",
				},
				pdf("h2", "ok.pdf"),
			])
		).resolves.toBeUndefined();
		expect(skipped.map((note) => note.name)).toEqual(["bad.bin"]);
		expect(mounted).toEqual(["/mnt/data/ok.pdf"]);
		warn.mockRestore();
	});

	it("takes back only what it mounted", async () => {
		const { mounter, removed } = setup({
			"/conversation/conv1/output/h1": body("x"),
			"/conversation/conv1/output/t1": body("y"),
		});
		await mounter.sync([pdf("h1", "a.pdf", "t1")]);
		expect(await mounter.unmountAll()).toEqual(["/mnt/data/a.pdf", "/mnt/data/a.pdf.md"]);
		expect(removed).toEqual(["/mnt/data/a.pdf", "/mnt/data/a.pdf.md"]);
	});
});
