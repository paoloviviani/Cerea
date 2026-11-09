/**
 * The document reader on a knowledge base: the create form, base settings (no
 * prompt: it applies to new uploads), and "Re-read with…" per file document.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import KnowledgeManager from "./KnowledgeManager.svelte";
import { renderWithApp } from "$lib/components/__tests__/renderWithApp";

const ID = "b".repeat(24);

interface Setup {
	owned?: boolean;
	role?: string;
	readerModel?: string | null;
	documents?: { id: string; status: string; file_id: string | null; title: string }[];
}

const FILE_DOC = { id: "f1", status: "ready", file_id: "c".repeat(24), title: "report.pdf" };
const TEXT_DOC = { id: "t1", status: "ready", file_id: null, title: "pasted note" };

function stub({ owned = true, role = "owner", readerModel = null, documents }: Setup = {}) {
	const posts: { url: string; body: unknown }[] = [];
	const store = {
		id: ID,
		name: "Handbook",
		description: "",
		owned,
		role,
		embedding_model: "embed-1",
		reader_model: readerModel,
		file_counts: { total: 2, completed: 2, in_progress: 0, failed: 0 },
	};
	const docs = (documents ?? [FILE_DOC, TEXT_DOC]).map((d) => ({
		...d,
		filename: d.title,
		chunk_count: 1,
		error: null,
	}));
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			const method = init?.method ?? "GET";
			if (method === "POST") {
				const body = init?.body ? JSON.parse(String(init.body)) : undefined;
				posts.push({ url, body });
				if (url.endsWith(`/vector_stores/${ID}`))
					return Response.json({ ...store, reader_model: body.reader_model || null });
				return Response.json({ data: [] });
			}
			if (url.endsWith("/vector_stores/status"))
				return Response.json({
					ready: true,
					embedding_model: "embed-1",
					reader_models: ["markitdown", "docling", "mistral-ocr"],
					reader_default: "markitdown",
					max_upload_bytes: 1_000_000,
				});
			if (url.endsWith(`/vector_stores/${ID}/files`)) return Response.json({ data: docs });
			if (url.endsWith(`/vector_stores/${ID}`)) return Response.json(store);
			if (url.endsWith("/vector_stores")) return Response.json({ data: [store] });
			if (url.includes("billing/groups")) return Response.json({ data: [] });
			throw new Error(`unexpected fetch: ${url}`);
		})
	);
	return posts;
}

const buttons = () => [...document.querySelectorAll("button")];
const byText = (text: string) => buttons().find((b) => b.textContent?.trim() === text);

async function open(setup: Setup = {}) {
	const posts = stub(setup);
	renderWithApp(KnowledgeManager, { initialId: ID });
	await vi.waitFor(() => expect(document.body.textContent).toContain("report.pdf"));
	return posts;
}

const select = (id: string) => document.getElementById(id) as HTMLSelectElement;

function choose(el: HTMLSelectElement, value: string) {
	el.value = value;
	el.dispatchEvent(new Event("change", { bubbles: true }));
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	document.body.innerHTML = "";
});

describe("a base's reader", () => {
	it("shows the base's reader in settings and saves a change at once, with no confirm", async () => {
		const posts = await open({ readerModel: "docling" });
		const picker = select("kb-reader-current");
		expect(picker.value).toBe("docling");
		expect([...picker.options].map((o) => o.text)).toEqual([
			"Default (markitdown)",
			"markitdown",
			"docling",
			"mistral-ocr",
		]);
		const confirm = vi.spyOn(window, "confirm");
		choose(picker, "mistral-ocr");
		await vi.waitFor(() => expect(posts).toHaveLength(1));
		expect(posts[0]).toEqual({
			url: expect.stringContaining(`/vector_stores/${ID}`),
			body: { reader_model: "mistral-ocr" },
		});
		expect(confirm).not.toHaveBeenCalled();
		await vi.waitFor(() =>
			expect(document.body.textContent).toContain("New uploads to this base use this reader")
		);
	});

	it("says it applies to files added from now on", async () => {
		await open();
		expect(document.body.textContent).toContain("Used for files you add from now on");
	});

	it("is read-only text for a viewer", async () => {
		await open({ owned: false, role: "viewer", readerModel: "docling" });
		expect(document.getElementById("kb-reader-current")?.tagName).toBe("P");
	});
});

describe("Re-read with…", () => {
	it("is offered on a file document, not on a text-only one", async () => {
		await open();
		const reread = buttons().filter((b) => b.textContent?.includes("Re-read with"));
		expect(reread).toHaveLength(1);
		expect(reread[0].getAttribute("aria-label")).toBe("Re-read report.pdf with another reader");
	});

	it("is offered to an editor but not to a viewer", async () => {
		await open({ owned: false, role: "viewer" });
		expect(buttons().some((b) => b.textContent?.includes("Re-read with"))).toBe(false);
	});

	it("asks which reader, then posts the choice to the reread route", async () => {
		const posts = await open();
		byText("Re-read with…")?.click();
		await vi.waitFor(() =>
			expect(document.querySelector('[data-testid="reread-form"]')).not.toBeNull()
		);
		choose(select(`kb-reread-${FILE_DOC.id}`), "docling");
		byText("Re-read")?.click();
		await vi.waitFor(() => expect(posts).toHaveLength(1));
		expect(posts[0]).toEqual({
			url: expect.stringContaining(`/vector_stores/${ID}/files/f1/reread`),
			body: { reader_model: "docling" },
		});
	});

	it("shows the server's refusal on the screen", async () => {
		stub();
		const inner = fetch;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
				if (String(input).endsWith("/reread"))
					return Response.json(
						{
							error: { message: "This document is already being indexed. Wait for it to finish." },
						},
						{ status: 409 }
					);
				return inner(input, init);
			})
		);
		renderWithApp(KnowledgeManager, { initialId: ID });
		await vi.waitFor(() => expect(document.body.textContent).toContain("report.pdf"));
		byText("Re-read with…")?.click();
		await vi.waitFor(() => expect(byText("Re-read")).toBeDefined());
		byText("Re-read")?.click();
		await vi.waitFor(() => expect(document.body.textContent).toContain("already being indexed"));
	});
});

describe("create form", () => {
	it("offers the reader, defaulting to the admin's, and sends the choice", async () => {
		const posts = stub();
		renderWithApp(KnowledgeManager, {});
		await vi.waitFor(() => expect(document.body.textContent).toContain("Handbook"));
		const newButton = buttons().find((b) => /new|create/i.test(b.textContent ?? ""));
		newButton?.click();
		await vi.waitFor(() => expect(document.getElementById("kb-reader")).not.toBeNull());
		const picker = select("kb-reader");
		expect(picker.value).toBe("");
		expect(picker.options[0].text).toBe("Default (markitdown)");
		const name = document.getElementById("kb-name") as HTMLInputElement;
		name.value = "New base";
		name.dispatchEvent(new Event("input", { bubbles: true }));
		choose(picker, "docling");
		(document.querySelector("form") as HTMLFormElement).requestSubmit();
		await vi.waitFor(() => expect(posts.length).toBeGreaterThan(0));
		expect(posts[0].body).toMatchObject({ name: "New base", reader_model: "docling" });
	});
});
