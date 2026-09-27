import DeliverablesPanel from "./DeliverablesPanel.svelte";
import { renderWithApp } from "../__tests__/renderWithApp";
import { sidePane } from "$lib/stores/sidePane.svelte";
import { exportConversation } from "$lib/stores/exportConversation";
import type { ArtifactRegistry } from "$lib/utils/artifacts";
import type { PaneItem } from "$lib/utils/paneItems";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// The panel fetches its list itself; stub the network per test. Every other
// fetch on this surface (none, currently) would hit the same stub, so each
// test sets exactly the response its path needs.
const listResponse = (files: unknown[]) =>
	vi.fn(async () => new Response(JSON.stringify({ files }), { status: 200 }));

const mountOpen = (props?: { items?: PaneItem[]; registry?: ArtifactRegistry }) => {
	sidePane.openLibrary();
	return renderWithApp(DeliverablesPanel, props, {
		page: { route: { id: "/conversation/[id]" }, params: { id: "conv123456" }, data: {} },
	});
};

const registryWith = (identifier: string, type: "markdown" | "code", title: string) =>
	({
		artifacts: new Map([
			[
				identifier,
				{
					identifier,
					versions: [
						{
							identifier,
							type,
							title,
							language: "python",
							content: "# hello",
							complete: true,
							op: "create",
							version: 1,
							messageId: "msg1",
						},
					],
				},
			],
		]),
		byMessageOp: new Map(),
	}) as ArtifactRegistry;

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

	it("lists pane artifacts with their latest title and kind", async () => {
		vi.stubGlobal("fetch", listResponse([]));
		const screen = await mountOpen({
			items: [{ kind: "artifact", identifier: "plan-1", label: "Trip plan" }],
			registry: registryWith("plan-1", "markdown", "Trip plan"),
		});
		await expect.element(screen.getByText("Trip plan")).toBeVisible();
		await expect.element(screen.getByText("Document")).toBeVisible();
		// The header count covers pane items, not just stored files.
		await expect.element(screen.getByText("1")).toBeVisible();
		screen.unmount();
	});

	it("opens the existing artifact view when its row is clicked", async () => {
		vi.stubGlobal("fetch", listResponse([]));
		const open = vi.spyOn(sidePane, "openArtifact");
		const screen = await mountOpen({
			items: [{ kind: "artifact", identifier: "plan-1", label: "Trip plan" }],
			registry: registryWith("plan-1", "markdown", "Trip plan"),
		});
		const button = screen.getByRole("button", { name: "Open Trip plan in panel" });
		await expect.element(button).toBeVisible();
		// A direct click: the scroll controller's re-measuring never lets
		// Playwright's actionability checks settle on chat surfaces.
		(button.element() as HTMLButtonElement).click();
		await vi.waitFor(() => expect(open).toHaveBeenCalledWith("plan-1", null));
		open.mockRestore();
		screen.unmount();
	});

	it("keeps file rows with Download links in conversation order", async () => {
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
			])
		);
		const screen = await mountOpen({
			items: [
				{ kind: "artifact", identifier: "plan-1", label: "Trip plan" },
				{ kind: "file", name: "report.csv", label: "report.csv" },
			],
			registry: registryWith("plan-1", "markdown", "Trip plan"),
		});
		await expect.element(screen.getByText("Trip plan")).toBeVisible();
		await expect.element(screen.getByText("report.csv")).toBeVisible();
		await expect.element(screen.getByText("Spreadsheet · 2.8 KB ·")).toBeVisible();
		const download = screen.getByRole("link", { name: "Download report.csv" });
		expect(download.element().getAttribute("href")).toBe(
			"/conversation/conv123456/code-execution/output/aaa"
		);
		// Conversation order, not files-first: the artifact row comes first.
		const rows = [...screen.baseElement.querySelectorAll("ul li")];
		expect(rows.map((row) => row.textContent)).toHaveLength(2);
		expect(rows[0].textContent).toContain("Trip plan");
		expect(rows[1].textContent).toContain("report.csv");
		screen.unmount();
	});

	it("opens the file-artifact view for a pane file with no stored row yet", async () => {
		vi.stubGlobal("fetch", listResponse([]));
		const open = vi.spyOn(sidePane, "openArtifact");
		const screen = await mountOpen({
			items: [{ kind: "file", name: "fresh.csv", label: "fresh.csv" }],
		});
		await expect.element(screen.getByText("fresh.csv")).toBeVisible();
		// No store metadata, so no Download link — only the panel open.
		expect(screen.baseElement.querySelector('a[aria-label="Download fresh.csv"]')).toBeNull();
		const button = screen.getByRole("button", { name: "Open fresh.csv in panel" });
		(button.element() as HTMLButtonElement).click();
		await vi.waitFor(() => expect(open).toHaveBeenCalledWith("fresh.csv", null));
		open.mockRestore();
		screen.unmount();
	});

	it("opens dashboards from their trackio rows", async () => {
		vi.stubGlobal("fetch", listResponse([]));
		const open = vi.spyOn(sidePane, "openTrackio");
		const screen = await mountOpen({
			items: [{ kind: "trackio", url: "https://trackio.example/run", label: "Training run" }],
		});
		await expect.element(screen.getByText("Training run")).toBeVisible();
		await expect.element(screen.getByText("Dashboard")).toBeVisible();
		const button = screen.getByRole("button", { name: "Open Training run in panel" });
		(button.element() as HTMLButtonElement).click();
		await vi.waitFor(() =>
			expect(open).toHaveBeenCalledWith("https://trackio.example/run", "Training run")
		);
		open.mockRestore();
		screen.unmount();
	});
});
