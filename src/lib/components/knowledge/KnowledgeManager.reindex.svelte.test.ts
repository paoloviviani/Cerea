/**
 * One base: who is offered Reindex and Retry, when, and the one confirm.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import KnowledgeManager from "./KnowledgeManager.svelte";
import { renderWithApp } from "$lib/components/__tests__/renderWithApp";

const ID = "a".repeat(24);

interface Setup {
	owned?: boolean;
	role?: string;
	baseModel?: string;
	deploymentModel?: string;
	statuses?: string[];
}

function stub({
	owned = true,
	role = "owner",
	baseModel = "embed-1",
	deploymentModel = "embed-1",
	statuses = ["ready"],
}: Setup = {}) {
	const calls: { url: string; method: string }[] = [];
	const store = {
		id: ID,
		name: "Team handbook",
		description: "",
		owned,
		role,
		embedding_model: baseModel,
		file_counts: {
			total: statuses.length,
			completed: statuses.filter((s) => s === "ready").length,
			in_progress: 0,
			failed: statuses.filter((s) => s === "failed").length,
		},
	};
	const documents = statuses.map((status, i) => ({
		id: `d${i}`,
		title: `doc-${i}.txt`,
		filename: `doc-${i}.txt`,
		status,
		chunk_count: 1,
		error: status === "failed" ? "Indexing failed." : null,
	}));
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			const method = init?.method ?? "GET";
			calls.push({ url, method });
			if (method === "POST") return Response.json({ data: [] });
			if (url.endsWith("/vector_stores/status"))
				return Response.json({
					ready: true,
					embedding_model: deploymentModel,
					max_upload_bytes: 1_000_000,
				});
			if (url.endsWith(`/vector_stores/${ID}/files`)) return Response.json({ data: documents });
			if (url.endsWith(`/vector_stores/${ID}`)) return Response.json(store);
			if (url.endsWith("/vector_stores")) return Response.json({ data: [store] });
			if (url.includes("billing/groups")) return Response.json({ data: [] });
			throw new Error(`unexpected fetch: ${url}`);
		})
	);
	return calls;
}

const buttons = () => [...document.querySelectorAll("button")];
const byText = (text: string) => buttons().find((b) => b.textContent?.trim() === text);
const menuButton = () => document.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]');

async function open(setup: Setup = {}) {
	const calls = stub(setup);
	renderWithApp(KnowledgeManager, { initialId: ID });
	await vi.waitFor(() => expect(document.body.textContent).toContain("doc-0.txt"));
	return calls;
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	document.body.innerHTML = "";
});

describe("Reindex", () => {
	it("is in the ⋯ menu when the base is current and nothing failed", async () => {
		await open();
		expect(byText("Reindex")).toBeUndefined();
		expect(document.body.textContent).not.toContain("older embedding model");
		menuButton()?.click();
		await vi.waitFor(() =>
			expect(document.querySelector('[role="menuitem"]')?.textContent).toContain("Reindex")
		);
	});

	it("is a button, with the notice, when the base's model is not the deployment's", async () => {
		await open({ baseModel: "old-embed", deploymentModel: "embed-2" });
		expect(byText("Reindex")).toBeDefined();
		expect(menuButton()).toBeNull();
		expect(document.body.textContent).toContain(
			"Built with an older embedding model. Reindex to search it."
		);
	});

	it("is a button when a document failed", async () => {
		await open({ statuses: ["ready", "failed"] });
		expect(byText("Reindex")).toBeDefined();
		expect(menuButton()).toBeNull();
		expect(document.body.textContent).not.toContain("older embedding model");
	});

	it("is not offered to an editor", async () => {
		await open({
			owned: false,
			role: "editor",
			baseModel: "old-embed",
			deploymentModel: "embed-2",
			statuses: ["failed"],
		});
		expect(byText("Reindex")).toBeUndefined();
		expect(menuButton()).toBeNull();
	});

	it("asks once, and does nothing when declined", async () => {
		const calls = await open({ statuses: ["failed", "ready"] });
		const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
		byText("Reindex")?.click();
		await vi.waitFor(() => expect(confirmSpy).toHaveBeenCalledTimes(1));
		expect(confirmSpy).toHaveBeenCalledWith(
			"Re-embed all 2 documents with the current model? This uses your allowance."
		);
		expect(calls.some((c) => c.method === "POST")).toBe(false);
	});

	it("reindexes when confirmed", async () => {
		const calls = await open({ statuses: ["failed"] });
		vi.spyOn(window, "confirm").mockReturnValue(true);
		byText("Reindex")?.click();
		await vi.waitFor(() =>
			expect(
				calls.some((c) => c.method === "POST" && c.url.endsWith(`/vector_stores/${ID}/reindex`))
			).toBe(true)
		);
	});
});

describe("Retry", () => {
	it("is on a failed document only", async () => {
		await open({ statuses: ["ready", "failed"] });
		const retries = buttons().filter((b) => b.textContent?.trim() === "Retry");
		expect(retries).toHaveLength(1);
		expect(retries[0].getAttribute("aria-label")).toBe("Retry doc-1.txt");
	});

	it("is there for an editor, and re-ingests just that document", async () => {
		const calls = await open({ owned: false, role: "editor", statuses: ["ready", "failed"] });
		byText("Retry")?.click();
		await vi.waitFor(() =>
			expect(
				calls.some(
					(c) => c.method === "POST" && c.url.endsWith(`/vector_stores/${ID}/files/d1/retry`)
				)
			).toBe(true)
		);
	});

	it("is not there for a viewer", async () => {
		await open({ owned: false, role: "viewer", statuses: ["failed"] });
		expect(byText("Retry")).toBeUndefined();
	});
});
