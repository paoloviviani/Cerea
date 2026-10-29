/**
 * The administration area in the pseudo-locale: the layout's refusal and each
 * section's page. Every word on them comes from the catalogue; what the
 * gateway, an administrator or the deployment supplied (names, addresses,
 * environment variables) is named in `allow`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "@vitest/browser/context";

import Layout from "./+layout.svelte";
import Connectors from "./connectors/+page.svelte";
import Knowledge from "./knowledge/+page.svelte";
import Storage from "./storage/+page.svelte";
import Web from "./web/+page.svelte";
import Assistant from "./assistant/+page.svelte";
import { renderWithApp } from "$lib/components/__tests__/renderWithApp";
import {
	unbracketedWords,
	useEnglish,
	usePseudoLocale,
} from "$lib/components/__tests__/enXaManage";
import { m } from "$lib/paraglide/messages";

vi.mock("$env/dynamic/public", () => ({ env: { PUBLIC_APP_NAME: "chat-ui" } }));

const en = (key: keyof typeof m) =>
	(m[key] as (i: object, o: { locale: string }) => string)({}, { locale: "en-XA" });

function stub(routes: Record<string, unknown>) {
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			const hit = Object.entries(routes).find(([suffix]) => url.includes(suffix));
			if (!hit) throw new Error(`unexpected fetch: ${url}`);
			return Response.json(hit[1]);
		})
	);
}

afterEach(() => {
	useEnglish();
	vi.unstubAllGlobals();
	document.body.innerHTML = "";
});

describe("Administration, in the pseudo-locale", () => {
	it("renders the layout's refusal, and its tabs for an administrator", async () => {
		usePseudoLocale();
		const children = (() => {}) as never;
		renderWithApp(
			Layout,
			{
				children,
				data: { signedIn: true, identity: { email: "ana@example.org", isAdmin: false } },
			} as never,
			{ page: { data: {} } }
		);
		await expect.element(page.getByText(en("admin.layout.denied.title"))).toBeVisible();
		expect(unbracketedWords(["ana@example.org"])).toEqual([]);
		document.body.innerHTML = "";

		renderWithApp(
			Layout,
			{ children, data: { signedIn: true, identity: { email: "a@b.c", isAdmin: true } } } as never,
			{ page: { data: { consoleEnabled: true } } }
		);
		await expect.element(page.getByText(en("admin.layout.console"))).toBeVisible();
		expect(unbracketedWords()).toEqual([]);
	});

	it("renders Assistant: instructions, sub-agents and voice", async () => {
		usePseudoLocale();
		stub({
			"/admin/delegation": { enabled: true, configurable: false },
			"/admin/instructions": { instructions: "", visible: true, max: 4000, configurable: false },
			"/admin/dictation": { mode: "fallback", transcriptionEnabled: true, configurable: false },
		});
		renderWithApp(Assistant, {});
		await expect.element(page.getByText(en("admin.instructions.title"))).toBeVisible();
		await expect.element(page.getByText(en("admin.delegation.title"))).toBeVisible();
		await expect.element(page.getByText(en("admin.voice.option.yes.title"))).toBeVisible();
		expect(
			unbracketedWords([
				"ADMIN_INSTRUCTIONS",
				"CHAT_DELEGATION",
				"CHAT_DICTATION",
				"research",
				"delegate",
			])
		).toEqual([]);
	});

	it("renders Web: web search and fetching", async () => {
		usePseudoLocale();
		stub({
			"/admin/web-search": {
				available_backends: [],
				backend: null,
				stored_backend: "old-backend",
				source: "stored",
				stale: true,
			},
			"/admin/fetching": {
				backend: "playwright",
				configurable: false,
				playwright: { reachable: false, reason: "refused" },
			},
		});
		renderWithApp(Web, {});
		await expect.element(page.getByText(en("admin.web_search.backend.label"))).toBeVisible();
		await expect.element(page.getByText(en("admin.fetch.option.direct.title"))).toBeVisible();
		expect(unbracketedWords(["FETCH_BACKEND", "PLAYWRIGHT_WS_ENDPOINT", "refused"])).toEqual([]);
	});

	it("renders Storage", async () => {
		usePseudoLocale();
		stub({
			"/admin/storage": {
				retentionDays: 30,
				defaultDays: 30,
				maxDays: 3650,
				configurable: false,
				files: 3,
				bytes: 4096,
				expiring: { files: 0, bytes: 0 },
			},
		});
		renderWithApp(Storage, {});
		await expect.element(page.getByText(en("admin.storage.keep_for"))).toBeVisible();
		expect(unbracketedWords(["CHAT_FILE_RETENTION_DAYS"])).toEqual([]);
	});

	it("renders Knowledge", async () => {
		usePseudoLocale();
		stub({
			"/admin/knowledge": {
				enabled: true,
				ready: true,
				embedding_model: "embed-1",
				extractor_model: "ocr-1",
				extractor_source: "env",
				vector_store: "pg",
				chunk_chars: 1200,
				chunk_overlap: 150,
				max_upload_bytes: 1000,
				source: "console",
				propagation_seconds: 30,
				detail: null,
				available_embedding_models: ["embed-1"],
				available_extractor_models: [{ id: "ocr-1", local: false }],
				bases: [
					{
						id: "b1",
						name: "Team handbook",
						description: "How we work",
						owner_email: "ana@example.org",
						group_name: null,
						embedding_model: "embed-0",
						dimensions: 3,
						document_count: 2,
						chunk_count: 9,
						failed_count: 1,
						stale: true,
						share_count: 0,
						created_at: "2026-01-01T00:00:00Z",
					},
				],
				stale_base_count: 1,
				history: [
					{
						id: "h1",
						embedding_model: "embed-1",
						extractor_model: null,
						chunk_chars: null,
						chunk_overlap: null,
						reason: "",
						changed_by: "ana@example.org",
						created_at: "2026-01-01T00:00:00Z",
					},
				],
			},
		});
		renderWithApp(Knowledge, {});
		await expect.element(page.getByText(en("admin.knowledge.pipeline.title"))).toBeVisible();
		expect(
			unbracketedWords([
				"embed-1",
				"embed-0",
				"ocr-1",
				"Team handbook",
				"How we work",
				"ana@example.org",
				"CHAT_OCR_MODEL",
				// A date, formatted by `Intl` in the page's language.
				/^[A-Z][a-z]{2} \d{1,2}, \d{4}/,
			])
		).toEqual([]);
	});

	it("renders Connectors, with its add form", async () => {
		usePseudoLocale();
		stub({
			"/api/mcp/servers": [
				{ id: "base-wiki", name: "wiki", url: "https://wiki.test/mcp", type: "base", mode: "on" },
			],
			"/api/v2/mcp/connectors": {
				data: [
					{
						id: "c1",
						name: "Notion",
						url: "https://notion.test/mcp",
						auth: "oauth",
						scope: "deployment",
						mode: "locked",
						alwaysLoaded: true,
					},
				],
			},
		});
		renderWithApp(Connectors, {});
		await expect.element(page.getByText("Notion", { exact: true })).toBeVisible();
		(
			[...document.querySelectorAll("button")].find((b) =>
				b.textContent?.includes(en("admin.connectors.add"))
			) as HTMLButtonElement
		).click();
		await expect.element(page.getByText(en("admin.connectors.form.auth"))).toBeVisible();
		expect(
			unbracketedWords([
				"Notion",
				"wiki",
				"https://",
				"MCP_SERVERS",
				".env",
				// The example name in the form is a message that happens to be a product name.
				/^\[?Notion/,
			])
		).toEqual([]);
	});
});
