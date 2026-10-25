/**
 * The project page in the pseudo-locale, on each of its three faces (new, the
 * conversations tab, the settings tab with its documents and notes sections):
 * every word on it comes from the catalogue.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "@vitest/browser/context";
import { writable } from "svelte/store";

import ProjectPage from "./ProjectPage.svelte";
import { renderWithApp } from "$lib/components/__tests__/renderWithApp";
import {
	unbracketedWords,
	useEnglish,
	usePseudoLocale,
} from "$lib/components/__tests__/enXaManage";
import { connectors, connectorsLoaded } from "$lib/stores/mcpConnectors";
import { m } from "$lib/paraglide/messages";

vi.mock("$env/dynamic/public", () => ({
	env: { PUBLIC_APP_ASSETS: "chatui", PUBLIC_APP_NAME: "chat-ui" },
}));

const PROJECT = {
	id: "proj-1",
	name: "Grant application",
	description: "",
	instructions: "",
	knowledgeBaseIds: ["a".repeat(24)],
	indexPastChats: true,
	hasMemory: false,
	retrievalLimit: 6,
	owned: true,
	shares: [{ kind: "user", principal: "ana@example.org" }],
	conversationCount: 1,
	updatedAt: "2026-01-01T00:00:00.000Z",
};

function stubApi() {
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.endsWith("/api/v2/mcp/connectors")) return Response.json({ data: [] });
			if (url.includes("/api/v2/gateway/vector_stores"))
				return Response.json({
					data: [
						{ id: "a".repeat(24), name: "Call texts", file_counts: { completed: 3 }, owned: true },
						{
							id: "b".repeat(24),
							name: "Past proposals",
							file_counts: { completed: 9 },
							owned: false,
						},
					],
				});
			if (url.includes("/api/v2/gateway/billing/groups")) return Response.json({ data: [] });
			if (/\/documents$/.test(url))
				return Response.json({
					data: {
						documents: [
							{
								id: "d1",
								name: "call.pdf",
								status: "ready",
								chars: 1200,
								mine: true,
								addedBy: "x",
							},
						],
						usedChars: 1200,
					},
				});
			if (/\/memory$/.test(url))
				return Response.json({
					data: {
						notes: [
							{
								id: "n1",
								text: "Staging resets on Monday",
								source: "user",
								mine: true,
								author: "x",
								createdAt: "2026-01-01T00:00:00.000Z",
							},
						],
					},
				});
			if (/\/conversations$/.test(url))
				return Response.json({
					data: [
						{
							id: "c1",
							title: "Budget questions",
							model: "m",
							updatedAt: "2026-01-01T00:00:00Z",
							mine: false,
						},
					],
				});
			if (/\/api\/v2\/projects\/[^/]+$/.test(url)) return Response.json(PROJECT);
			throw new Error(`unexpected fetch: ${url}`);
		})
	);
}

const settings = () => {
	const store = writable({ activeModel: "m", webSearchEnabled: false });
	return new Map<unknown, unknown>([
		["settings", { subscribe: store.subscribe, update: store.update }],
	]);
};

const ALLOWED: (string | RegExp)[] = [
	"Grant application",
	"Call texts",
	"Past proposals",
	"call.pdf",
	"Staging resets on Monday",
	"Budget questions",
	"ana@example.org",
	// A date, formatted by `Intl` in the page's language rather than spelled by a message.
	/^[A-Z][a-z]{2} \d{1,2}, \d{4}$/,
	// The row menu's own label: `MoveMenu` is shared with the sidebar, not part of this screen.
	"More options",
];

beforeEach(() => {
	connectors.set([]);
	connectorsLoaded.set(false);
	usePseudoLocale();
	stubApi();
});

afterEach(() => {
	useEnglish();
	vi.unstubAllGlobals();
	document.body.innerHTML = "";
});

describe("Project page, in the pseudo-locale", () => {
	it("renders a new project's form from the catalogue", async () => {
		renderWithApp(ProjectPage, {} as never, {
			page: { data: { models: [{ id: "m" }] } },
			context: settings(),
		});
		const heading = m["projects.page.defaults.web_search"]({}, { locale: "en-XA" });
		await expect.element(page.getByText(heading)).toBeVisible();
		expect(unbracketedWords(ALLOWED)).toEqual([]);
	});

	it("renders the conversations tab from the catalogue", async () => {
		renderWithApp(ProjectPage, { id: "proj-1" } as never, {
			page: { url: "/projects/proj-1", data: { models: [{ id: "m", displayName: "Model" }] } },
			context: settings(),
		});
		await expect.element(page.getByText("Budget questions")).toBeVisible();
		expect(unbracketedWords([...ALLOWED, "Model"])).toEqual([]);
	});

	it("renders the settings tab, with its files, notes, bases and sharing, from the catalogue", async () => {
		renderWithApp(ProjectPage, { id: "proj-1" } as never, {
			page: {
				url: "/projects/proj-1?tab=settings",
				data: { models: [{ id: "m" }] },
			},
			context: settings(),
		});
		await expect.element(page.getByText("call.pdf")).toBeVisible();
		await expect.element(page.getByText("Staging resets on Monday")).toBeVisible();
		await expect.element(page.getByText("ana@example.org")).toBeVisible();
		expect(unbracketedWords(ALLOWED)).toEqual([]);
	});
});
