/**
 * Pruning old artifact versions (C122), seen from the panel and the chat: the
 * "Delete older versions" action and its confirmation, the note that follows it, and the
 * card an old message shows for a version that was deleted.
 */
import ArtifactPanel from "./ArtifactPanel.svelte";
import ArtifactCard from "./ArtifactCard.svelte";
import FileArtifactCard from "./FileArtifactCard.svelte";
import { renderWithApp } from "../__tests__/renderWithApp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page as browserPage } from "@vitest/browser/context";
import { sidePane } from "$lib/stores/sidePane.svelte";
import { prunedVersions } from "$lib/stores/prunedVersions.svelte";
import { artifactOpKey, collectArtifacts, type ArtifactRegistry } from "$lib/utils/artifacts";
import type { FileArtifactRegistry } from "$lib/utils/fileArtifacts";

const emptyFiles: FileArtifactRegistry = { artifacts: new Map() };
const pageOverrides = {
	route: { id: "/conversation/[id]" },
	params: { id: "conv123456" },
	data: {},
};

beforeEach(async () => {
	sidePane.reset();
	prunedVersions.set([]);
	await browserPage.viewport(1280, 800);
});
afterEach(() => {
	vi.unstubAllGlobals();
	sidePane.reset();
	prunedVersions.set([]);
});

const tag = (body: string) =>
	`<artifact identifier="notes" type="markdown" title="Notes">${body}</artifact>`;
const messages = [
	{ id: "m1", from: "assistant" as const, content: tag("# one") },
	{ id: "m2", from: "assistant" as const, content: tag("# two") },
	{ id: "m3", from: "assistant" as const, content: tag("# three") },
];

function panel(registry: ArtifactRegistry, canPersistFiles = true) {
	return renderWithApp(
		ArtifactPanel,
		{ registry, fileRegistry: emptyFiles, items: [], loading: false, drafts: [], canPersistFiles },
		{ page: pageOverrides }
	);
}

describe("Delete older versions", () => {
	it("is offered on the owner's artifact with older versions, and confirms with the count", async () => {
		sidePane.openArtifact("notes");
		const screen = panel(collectArtifacts(messages));
		await screen.getByTestId("delete-older-versions").click();
		await expect
			.element(screen.getByText(/2 older versions of this artifact will be deleted/))
			.toBeVisible();
		await expect
			.element(screen.getByText(/any version that has an active share link/))
			.toBeVisible();
	});

	it("is not offered without older versions, or away from the owner's chat", async () => {
		sidePane.openArtifact("notes");
		const single = panel(collectArtifacts(messages.slice(0, 1)));
		expect(single.getByTestId("delete-older-versions").query()).toBeNull();
		single.unmount();
		const readOnly = panel(collectArtifacts(messages), false);
		expect(readOnly.getByTestId("delete-older-versions").query()).toBeNull();
	});

	it("sends the request, hides the deleted versions and reports the counts", async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						deleted: 1,
						keptShared: 1,
						freedFiles: 0,
						pruned: [artifactOpKey("m2", 0)],
					})
				)
		);
		vi.stubGlobal("fetch", fetchMock);
		sidePane.openArtifact("notes");
		const registry = collectArtifacts(messages);
		const screen = panel(registry);
		await screen.getByTestId("delete-older-versions").click();
		await screen.getByTestId("delete-older-confirm").click();
		await expect
			.element(screen.getByText("1 version deleted; 1 kept because they are shared."))
			.toBeVisible();
		const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toContain("/api/v2/artifacts/versions");
		expect(JSON.parse(String(init.body))).toEqual({
			conversationId: "conv123456",
			identifier: "notes",
			leafMessageId: "m3",
		});
		expect(prunedVersions.all.has("m2:0")).toBe(true);
	});

	it("says so when it fails", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("{}", { status: 500 }))
		);
		sidePane.openArtifact("notes");
		const screen = panel(collectArtifacts(messages));
		await screen.getByTestId("delete-older-versions").click();
		await screen.getByTestId("delete-older-confirm").click();
		await expect.element(screen.getByText("Could not delete the older versions.")).toBeVisible();
	});
});

describe("a card for a deleted version", () => {
	function card(opIndex = 0, messageId = "m1") {
		const registry = collectArtifacts(messages, undefined, new Set(["m1:0"]));
		return renderWithApp(
			ArtifactCard,
			{
				op: {
					kind: "create",
					identifier: "notes",
					type: "markdown",
					title: "Notes",
					content: "# one",
					closed: true,
				},
				messageId,
				opIndex,
			},
			{ artifacts: { registry, fileRegistry: emptyFiles, panel: sidePane, requestFix: undefined } }
		);
	}

	it("says the version was deleted and links to the current one", async () => {
		const screen = card();
		await expect.element(screen.getByText("This version was deleted")).toBeVisible();
		await screen.getByRole("button", { name: "Open the current version" }).click();
		expect(sidePane.open).toBe(true);
		expect(sidePane.identifier).toBe("notes");
		expect(sidePane.version).toBeNull();
	});

	it("leaves a card for a kept version alone", async () => {
		const registry = collectArtifacts(messages, undefined, new Set(["m1:0"]));
		const screen = renderWithApp(
			ArtifactCard,
			{
				op: {
					kind: "create",
					identifier: "notes",
					type: "markdown",
					title: "Notes",
					content: "# three",
					closed: true,
				},
				messageId: "m3",
				opIndex: 0,
			},
			{ artifacts: { registry, fileRegistry: emptyFiles, panel: sidePane, requestFix: undefined } }
		);
		expect(screen.getByText("This version was deleted").query()).toBeNull();
	});

	it("a file card says it too", async () => {
		const SHA = "1".repeat(64);
		const fileRegistry: FileArtifactRegistry = {
			artifacts: new Map([
				[
					"report.docx",
					{
						name: "report.docx",
						versions: [
							{
								name: "report.docx",
								size: 10,
								sha256: SHA,
								version: 1,
								messageId: "m1",
								deleted: true,
							},
							{
								name: "report.docx",
								size: 12,
								sha256: "2".repeat(64),
								version: 2,
								messageId: "m2",
							},
						],
					},
				],
			]),
		};
		const screen = renderWithApp(
			FileArtifactCard,
			{ file: { path: "report.docx", size: 10 }, sha256: SHA, uploaded: true },
			{
				artifacts: {
					registry: { artifacts: new Map(), byMessageOp: new Map() },
					fileRegistry,
					panel: sidePane,
				},
				page: pageOverrides,
			}
		);
		await expect.element(screen.getByTestId("file-deleted")).toBeVisible();
		await screen.getByTestId("file-card-open-current").click();
		expect(sidePane.identifier).toBe("report.docx");
	});
});
