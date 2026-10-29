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

describe("AttachmentMounter: produced files", () => {
	const MB = 1024 * 1024;
	const big = (mb: number) =>
		new Response(new Uint8Array(mb * MB), { headers: { "Content-Length": String(mb * MB) } });
	const row = (
		name: string,
		sha256: string,
		size: number,
		extra: Record<string, unknown> = {}
	) => ({
		name,
		size,
		sha256,
		createdAt: "2026-10-28T10:00:00Z",
		...extra,
	});
	const out = (sha: string) => `/conversation/conv1/code-execution/output/${sha}`;

	it("leaves a re-uploaded attachment mounted: it is the current version of the name", async () => {
		// Factories: each fetch must get a fresh body, so a second sync of the
		// same row really re-fetches instead of failing on a consumed response.
		const { mounter, loaded, mounted } = setup({
			[out("p1")]: () => body("EDITED"),
			[out("p2")]: () => body("EDITED MORE"),
			[out("p3")]: () => body("EDITED AGAIN"),
			"/conversation/conv1/output/h1": () => body("RE-UPLOADED"),
		});
		// Two produced versions of the name; the newest row is mounted.
		const rows = [
			row("report.docx", "p1", 6, { version: 1 }),
			row("report.docx", "p2", 11, { version: 2, createdAt: "2026-10-28T11:00:00Z" }),
		];
		await mounter.syncProduced(rows);
		expect(mounted).toEqual(["/mnt/data/report.docx"]);

		// The name is re-uploaded, numbered 3 at upload: the newest content,
		// mounted over the row like any attachment.
		await mounter.sync([
			{ type: "hash", name: "report.docx", value: "h1", mime: "application/pdf", version: 3 },
		]);
		expect(new TextDecoder().decode(loaded.at(-1)?.data as ArrayBuffer)).toBe("RE-UPLOADED");

		// The rows do not come back over it on the next runs.
		await mounter.syncProduced(rows);
		expect(new TextDecoder().decode(loaded.at(-1)?.data as ArrayBuffer)).toBe("RE-UPLOADED");

		// A row numbered past the attachment takes the path back.
		await mounter.syncProduced([
			row("report.docx", "p3", 11, { version: 4, createdAt: "2026-10-28T12:00:00Z" }),
		]);
		expect(new TextDecoder().decode(loaded.at(-1)?.data as ArrayBuffer)).toBe("EDITED AGAIN");
	});

	it("keeps a file attached again mounted over an older produced version, by when it was sent", async () => {
		const { mounter, loaded } = setup({
			"/conversation/conv1/output/h1": () => body("BLANK"),
			[out("p1")]: () => body("FILLED"),
		});
		const filled = row("form.pdf", "p1", 6, { version: 2, createdAt: "2026-10-28T11:00:00Z" });
		// The original (number 1) was sent before the fill: the fill is newer content.
		await mounter.sync([{ ...pdf("h1", "form.pdf"), sentAt: Date.parse("2026-10-28T10:00:00Z") }]);
		await mounter.syncProduced([filled]);
		expect(new TextDecoder().decode(loaded.at(-1)?.data as ArrayBuffer)).toBe("FILLED");
		// Sent again afterwards (the same content, so the same number): it is the newest again.
		const again = setup({
			"/conversation/conv1/output/h1": () => body("BLANK"),
			[out("p1")]: () => body("FILLED"),
		});
		await again.mounter.sync([
			{ ...pdf("h1", "form.pdf"), sentAt: Date.parse("2026-10-28T12:00:00Z") },
		]);
		await again.mounter.syncProduced([filled]);
		expect(new TextDecoder().decode(again.loaded.at(-1)?.data as ArrayBuffer)).toBe("BLANK");
		expect(again.loaded).toHaveLength(1);
	});

	it("takes a produced file out when the list no longer holds it (another branch), and swaps a changed attachment", async () => {
		const { mounter, loaded, removed } = setup({
			"/conversation/conv1/output/h1": () => body("BLANK"),
			"/conversation/conv1/output/h2": () => body("OTHER"),
			[out("p1")]: () => body("FILLED"),
		});
		await mounter.syncProduced([row("filled.pdf", "p1", 6)]);
		expect(loaded.map((f) => f.name)).toEqual(["filled.pdf"]);
		// The open branch changed: its list has no such file.
		await mounter.syncProduced([]);
		expect(removed).toEqual(["/mnt/data/filled.pdf"]);

		await mounter.sync([pdf("h1", "form.pdf")]);
		await mounter.sync([pdf("h2", "form.pdf")]);
		expect(removed.at(-1)).toBe("/mnt/data/form.pdf");
		expect(new TextDecoder().decode(loaded.at(-1)?.data as ArrayBuffer)).toBe("OTHER");
	});

	it("takes the attachment's extracted text out when a produced file replaces the attachment, and fetches it no more", async () => {
		const { mounter, fetched, removed, mounted } = setup({
			"/conversation/conv1/output/h1": body("ORIGINAL"),
			"/conversation/conv1/output/t1": body("old text"),
			[out("p1")]: body("EDITED"),
		});
		const files = [pdf("h1", "report.pdf", "t1")];
		await mounter.sync(files);
		await mounter.syncProduced([row("report.pdf", "p1", 6)]);
		expect(mounted.at(-1)).toBe("/mnt/data/report.pdf");
		expect(removed).toEqual(["/mnt/data/report.pdf.md"]);

		fetched.length = 0;
		expect(mounter.needsSync(files)).toBe(false);
		await mounter.sync(files);
		expect(fetched).toEqual([]);
	});

	it("gives back the bytes of what a produced file replaces, so the replacement is not turned away", async () => {
		const responses: Record<string, Response> = {};
		const files = [1, 2, 3, 4, 5].map((n) => pdf(`h${n}`, `a${n}.pdf`));
		for (let n = 1; n <= 5; n += 1) responses[`/conversation/conv1/output/h${n}`] = big(19);
		responses[out("p1")] = big(19);
		const { mounter, skipped, mounted } = setup(responses);
		await mounter.sync(files); // 95 MB of the 100
		await mounter.syncProduced([row("a5.pdf", "p1", 19 * MB)]);
		expect(skipped).toEqual([]);
		expect(mounted.at(-1)).toBe("/mnt/data/a5.pdf");
	});

	it("does not remember a total-cap refusal forever: it retries once room is freed", async () => {
		const { mounter, fetched, skipped, mounted } = setup({
			"/conversation/conv1/output/h1": big(19),
			"/conversation/conv1/output/h2": big(19),
			"/conversation/conv1/output/h3": big(19),
			"/conversation/conv1/output/h4": big(19),
			[out("a")]: big(19),
			[out("a2")]: body("small"),
			[out("b")]: big(19),
		});
		await mounter.sync([1, 2, 3, 4].map((n) => pdf(`h${n}`, `a${n}.pdf`))); // 76 MB
		await mounter.syncProduced([row("a.bin", "a", 19 * MB)]); // 95 MB
		await mounter.syncProduced([row("a.bin", "a", 19 * MB), row("b.bin", "b", 19 * MB)]);
		expect(skipped.map((n) => n.name)).toEqual(["b.bin"]);
		expect(skipped[0].reason).toContain("100 MB total limit");
		// Turned away before the download: nothing was fetched for it.
		expect(fetched).not.toContain(out("b"));
		// Still no room: still no fetch.
		await mounter.syncProduced([row("a.bin", "a", 19 * MB), row("b.bin", "b", 19 * MB)]);
		expect(fetched).not.toContain(out("b"));

		// a.bin is replaced by a tiny version: 18+ MB are free and b.bin goes in.
		await mounter.syncProduced([
			row("a.bin", "a2", 5, { createdAt: "2026-10-28T11:00:00Z" }),
			row("b.bin", "b", 19 * MB),
		]);
		expect(mounted).toContain("/mnt/data/b.bin");
	});

	it("does not remember an attachment turned away for the total either", async () => {
		const responses: Record<string, Response> = {};
		for (let n = 1; n <= 5; n += 1) responses[`/conversation/conv1/output/h${n}`] = big(19);
		responses["/conversation/conv1/output/h6"] = big(19);
		const { mounter, skipped } = setup(responses);
		const files = [1, 2, 3, 4, 5, 6].map((n) => pdf(`h${n}`, `a${n}.pdf`));
		await mounter.sync(files);
		expect(skipped.map((n) => n.name)).toEqual(["a6.pdf"]);
		// Not final: but with no room freed there is nothing to try, so the next run does not refetch it.
		expect(mounter.needsSync(files)).toBe(false);
	});

	it("leaves image outputs unmounted unless the code names them", async () => {
		const { mounter, mounted } = setup({
			[out("i1")]: body("PNG"),
			[out("d1")]: body("CSV"),
		});
		const list = [
			row("figure-1.png", "i1", 3, { mime: "image/png" }),
			row("data.csv", "d1", 3, { mime: "text/csv" }),
		];
		await mounter.syncProduced(list, { code: "print(1)" });
		expect(mounted).toEqual(["/mnt/data/data.csv"]);
		await mounter.syncProduced(list, { code: 'Image.open("/mnt/data/figure-1.png")' });
		expect(mounted).toEqual(["/mnt/data/data.csv", "/mnt/data/figure-1.png"]);
	});

	it("gives a download a timeout, and carries on without the file when it stalls", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		let stall = true;
		const signals: Array<AbortSignal | undefined> = [];
		const { mounter, skipped, mounted } = setup({});
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: string, init?: { signal?: AbortSignal }) => {
				signals.push(init?.signal);
				if (stall) throw new DOMException("signal timed out", "TimeoutError");
				return body("late");
			})
		);
		await mounter.syncProduced([row("a.csv", "c1", 4)]);
		expect(signals[0]).toBeInstanceOf(AbortSignal);
		expect(mounted).toEqual([]);
		expect(skipped[0].reason).toContain("took too long");

		stall = false;
		await mounter.syncProduced([row("a.csv", "c1", 4)]);
		expect(mounted).toEqual(["/mnt/data/a.csv"]);
		warn.mockRestore();
	});
});
