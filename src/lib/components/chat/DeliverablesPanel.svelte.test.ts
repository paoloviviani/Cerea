import DeliverablesPanel from "./DeliverablesPanel.svelte";
import { renderWithApp } from "../__tests__/renderWithApp";
import { sidePane } from "$lib/stores/sidePane.svelte";
import { exportConversation } from "$lib/stores/exportConversation";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// The panel fetches its list itself; stub the network per test. Every other
// fetch on this surface (none, currently) would hit the same stub, so each
// test sets exactly the response its path needs.
const listResponse = (files: unknown[]) =>
	vi.fn(async () => new Response(JSON.stringify({ files }), { status: 200 }));

const mountOpen = () => {
	sidePane.openLibrary();
	return renderWithApp(DeliverablesPanel, undefined, {
		page: { route: { id: "/conversation/[id]" }, params: { id: "conv123456" }, data: {} },
	});
};

beforeEach(() => {
	sidePane.reset();
	exportConversation.reset();
});

afterEach(() => {
	vi.unstubAllGlobals();
	sidePane.reset();
	exportConversation.reset();
});

describe("DeliverablesPanel", () => {
	it("shows a legible empty state when the chat generated nothing", async () => {
		vi.stubGlobal("fetch", listResponse([]));
		const screen = await mountOpen();
		await expect.element(screen.getByRole("heading", { name: "Artifacts" })).toBeVisible();
		await expect.element(screen.getByText("No artifacts yet")).toBeVisible();
		screen.unmount();
	});

	it("lists persisted files with kind, size, date and download/open", async () => {
		vi.stubGlobal(
			"fetch",
			listResponse([
				{
					name: "report.csv",
					mime: "text/csv",
					size: 2916,
					sha256: "aaa",
					createdAt: "2026-09-10T12:00:00.000Z",
				},
				{
					name: "chart.png",
					mime: "image/png",
					size: 2048,
					sha256: "bbb",
					createdAt: "2026-09-11T12:00:00.000Z",
				},
			])
		);
		const screen = await mountOpen();
		await expect.element(screen.getByText("report.csv")).toBeVisible();
		// Kind, size and date share one meta line per row.
		await expect.element(screen.getByText("Spreadsheet · 2.8 KB ·")).toBeVisible();
		await expect.element(screen.getByText("Image · 2.0 KB ·")).toBeVisible();
		const download = screen.getByRole("link", { name: "Download report.csv" });
		await expect.element(download).toBeVisible();
		expect(download.element().getAttribute("href")).toBe(
			"/conversation/conv123456/code-execution/output/aaa"
		);
		await expect.element(screen.getByRole("link", { name: "Open chart.png" })).toBeVisible();
		screen.unmount();
	});

	it("carries the chat export in the pane, running the same action", async () => {
		vi.stubGlobal("fetch", listResponse([]));
		const run = vi.fn();
		exportConversation.set({ canExport: true, loading: false, run });
		const screen = await mountOpen();
		const button = screen.getByRole("button", { name: "Export conversation as Markdown" });
		await expect.element(button).toBeVisible();
		// A direct click: the scroll controller's re-measuring never lets
		// Playwright's actionability checks settle on chat surfaces.
		(button.element() as HTMLButtonElement).click();
		await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
		screen.unmount();
	});

	it("stays shut until the menu button opens it", async () => {
		vi.stubGlobal("fetch", listResponse([]));
		const screen = renderWithApp(DeliverablesPanel, undefined, {
			page: { route: { id: "/conversation/[id]" }, params: { id: "conv123456" }, data: {} },
		});
		expect(screen.baseElement.textContent).not.toContain("Artifacts");
		screen.unmount();
	});
});
