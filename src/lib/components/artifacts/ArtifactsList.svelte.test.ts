/**
 * The Artifacts list: a row per artifact with its kind, latest version and
 * version count, the chat it came from; links that open the chat with the
 * artifact in the side panel and download the latest version; a name filter;
 * more rows as the end scrolls into view; and the states around it.
 */
import { describe, expect, it, afterEach, vi } from "vitest";

import ArtifactsList from "./ArtifactsList.svelte";
import { renderWithApp } from "$lib/components/__tests__/renderWithApp";

vi.mock("$env/dynamic/public", () => ({
	env: { PUBLIC_APP_ASSETS: "chatui", PUBLIC_APP_NAME: "chat-ui" },
}));

const FILE = {
	kind: "file",
	name: "report.docx",
	identifier: "report.docx",
	type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	version: 3,
	versionCount: 3,
	conversationId: "c1",
	conversationTitle: "Quarterly report",
	at: "2026-11-01T10:00:00Z",
	sha256: "a".repeat(64),
	size: 2048,
};
const TEXT = {
	kind: "artifact",
	name: "Landing page",
	identifier: "landing page",
	type: "html",
	version: 1,
	versionCount: 1,
	conversationId: "c2",
	conversationTitle: "Website",
	at: "2026-10-01T10:00:00Z",
};

const text = () => document.body.textContent ?? "";

function stub(respond: (url: URL) => { data: unknown[]; hasMore?: boolean } | Response) {
	const asked: URL[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL) => {
			const url = new URL(String(input), "http://localhost");
			asked.push(url);
			const result = respond(url);
			return result instanceof Response ? result : Response.json({ hasMore: false, ...result });
		})
	);
	return asked;
}

afterEach(() => {
	vi.unstubAllGlobals();
	document.body.innerHTML = "";
});

describe("ArtifactsList", () => {
	it("shows name, kind, version, count and source chat, with open and download links", async () => {
		const asked = stub(() => ({ data: [FILE, TEXT] }));
		renderWithApp(ArtifactsList, { project: "p1" } as never);
		await vi.waitFor(() => expect(text()).toContain("report.docx"));

		expect(asked[0].searchParams.get("project")).toBe("p1");
		expect(text()).toContain("Word");
		expect(text()).toContain("v3");
		expect(text()).toContain("3 versions");
		expect(text()).toContain("1 version");
		expect(text()).toContain("Web app");
		expect(text()).toContain("From Quarterly report");

		const open = document.body.querySelector(
			'a[aria-label="Open report.docx in its chat"]'
		) as HTMLAnchorElement;
		expect(open.getAttribute("href")).toBe("/conversation/c1?artifact=report.docx");
		const download = document.body.querySelector(
			'a[aria-label="Download report.docx"]'
		) as HTMLAnchorElement;
		expect(download.getAttribute("href")).toBe(
			`/conversation/c1/code-execution/output/${"a".repeat(64)}`
		);
		const textOpen = document.body.querySelector(
			'a[aria-label="Open Landing page in its chat"]'
		) as HTMLAnchorElement;
		expect(textOpen.getAttribute("href")).toBe("/conversation/c2?artifact=landing%20page");
		const textDownload = document.body.querySelector(
			'a[aria-label="Download Landing page"]'
		) as HTMLAnchorElement;
		expect(textDownload.getAttribute("href")).toBe(
			"/api/v2/artifacts/download?conversation=c2&identifier=landing%20page"
		);
	});

	it("asks for the chats outside projects with project=none, and says when there are none", async () => {
		const asked = stub(() => ({ data: [] }));
		renderWithApp(ArtifactsList, { project: "none" } as never);
		await vi.waitFor(() =>
			expect(document.body.querySelector('[data-testid="artifacts-empty"]')).not.toBeNull()
		);
		expect(asked[0].searchParams.get("project")).toBe("none");
		expect(text()).toContain("No artifacts yet");
	});

	it("filters by name on the server, and offers to show all when nothing matches", async () => {
		const asked = stub((url) => ({ data: url.searchParams.get("q") ? [] : [FILE] }));
		renderWithApp(ArtifactsList, { project: "none" } as never);
		await vi.waitFor(() => expect(text()).toContain("report.docx"));

		const input = document.body.querySelector(
			'[data-testid="artifacts-search"]'
		) as HTMLInputElement;
		input.value = "zzz";
		input.dispatchEvent(new Event("input", { bubbles: true }));
		await vi.waitFor(() =>
			expect(document.body.querySelector('[data-testid="artifacts-no-results"]')).not.toBeNull()
		);
		expect(asked.at(-1)?.searchParams.get("q")).toBe("zzz");
		expect(text()).toContain("No artifacts match");

		const showAll = [...document.body.querySelectorAll("button")].find((b) =>
			b.textContent?.includes("Show all artifacts")
		) as HTMLButtonElement;
		showAll.click();
		await vi.waitFor(() => expect(text()).toContain("report.docx"));
	});

	it("loads the next page when the end of the list scrolls into view", async () => {
		const many = Array.from({ length: 30 }, (_, i) => ({
			...FILE,
			name: `file-${i}.csv`,
			identifier: `file-${i}.csv`,
		}));
		const asked = stub((url) =>
			url.searchParams.get("p") === "0"
				? { data: many, hasMore: true }
				: { data: [{ ...FILE, name: "last.csv", identifier: "last.csv" }] }
		);
		renderWithApp(ArtifactsList, { project: "none" } as never);
		await vi.waitFor(() => expect(text()).toContain("file-29.csv"));
		// The loader sits under the rows; bring it into view as a scroll would.
		(
			document.body.querySelector('[data-testid="artifacts-rows"]')
				?.nextElementSibling as HTMLElement
		).scrollIntoView();
		await vi.waitFor(() => expect(text()).toContain("last.csv"), { timeout: 4000 });
		expect(asked.map((u) => u.searchParams.get("p"))).toContain("1");
		expect(document.body.querySelectorAll('[data-testid="artifacts-row"]')).toHaveLength(31);
	});

	it("shows a failure instead of an empty list", async () => {
		stub(() => new Response("nope", { status: 500 }));
		renderWithApp(ArtifactsList, { project: "none" } as never);
		await vi.waitFor(() => expect(text()).toContain("Could not load the artifacts"));
		expect(document.body.querySelector('[data-testid="artifacts-empty"]')).toBeNull();
	});
});
