/**
 * Tool-based artifacts (chat side): one `artifact` builtin tool writes
 * canonical inline blocks, streamed-argument drafts preview in the panel, and
 * inline tags stay as the fallback (never inside `<think>`).
 */
import { test, expect, E2E_APP_BASE } from "./fixtures.ts";
import type { Db } from "mongodb";
import type { Page } from "playwright/test";

const TOOL_MODEL = "test-org/artifact-tool";
const TAGS_MODEL = "test-org/artifact-tags";
const PANEL_LABEL = "File panel";

async function useModel(db: Db, session: { sessionId: string }, model: string) {
	await db
		.collection("settings")
		.updateOne({ sessionId: session.sessionId }, { $set: { activeModel: model } });
}

async function send(page: Page, text: string) {
	await page.getByPlaceholder("Ask anything").fill(text);
	await page.getByRole("button", { name: "Send message" }).click();
}

const CREATE_ARGS = JSON.stringify({
	command: "create",
	identifier: "playground",
	type: "markdown",
	title: "Playground",
	content: "# Playground\n\nVersion one.\n",
});

test("create, update and rewrite render as v1 to v3 with history", async ({
	page,
	mockOpenAI,
	db,
	session,
}) => {
	await useModel(db, session, TOOL_MODEL);
	await mockOpenAI.setDefaultScenario({
		toolCalls: [{ id: "call_create", name: "artifact", arguments: CREATE_ARGS }],
		content: ["Built", " the", " playground", "."],
		chunkDelayMs: 10,
	});

	await page.goto(`${E2E_APP_BASE}/`);
	await send(page, "build me a playground");
	await page.waitForURL(/\/conversation\/[a-f0-9]{24}/);

	const panel = page.getByLabel(PANEL_LABEL, { exact: true });
	await expect(panel).toBeVisible({ timeout: 30_000 });
	// Level 2 is the panel's own header: the live preview renders the
	// artifact's content heading (`# Playground`) beside it.
	await expect(panel.getByRole("heading", { name: "Playground", level: 2 })).toBeVisible({
		timeout: 30_000,
	});
	await expect(panel).toContainText("Version one.", { timeout: 30_000 });

	// Turn 2: targeted update.
	await mockOpenAI.setDefaultScenario({
		toolCalls: [
			{
				id: "call_update",
				name: "artifact",
				arguments: JSON.stringify({
					command: "update",
					identifier: "playground",
					old_str: "Version one.",
					new_str: "Version two.",
				}),
			},
		],
		content: ["Updated", "."],
		chunkDelayMs: 10,
	});
	await send(page, "make it version two");
	await expect(panel).toContainText("Version two.", { timeout: 30_000 });

	// Turn 3: full rewrite.
	await mockOpenAI.setDefaultScenario({
		toolCalls: [
			{
				id: "call_rewrite",
				name: "artifact",
				arguments: JSON.stringify({
					command: "rewrite",
					identifier: "playground",
					content: "# Playground\n\nVersion three.\n",
				}),
			},
		],
		content: ["Rewrote", "."],
		chunkDelayMs: 10,
	});
	await send(page, "rewrite it as version three");
	await expect(panel).toContainText("Version three.", { timeout: 30_000 });

	// History navigation: v3 / 3, back to v1, forward again.
	await expect(panel.getByText("v3 / 3")).toBeVisible({ timeout: 30_000 });
	await panel.getByRole("button", { name: "Previous version" }).click();
	await expect(panel.getByText("v2 / 3")).toBeVisible();
	await expect(panel).toContainText("Version two.");
	await panel.getByRole("button", { name: "Previous version" }).click();
	await expect(panel.getByText("v1 / 3")).toBeVisible();
	await expect(panel).toContainText("Version one.");
	await panel.getByRole("button", { name: "Next version" }).click();
	await panel.getByRole("button", { name: "Next version" }).click();
	await expect(panel.getByText("v3 / 3")).toBeVisible();

	// The model saw short results, never echoed content: every follow-up tool
	// result names the version without the body.
	const requests = await mockOpenAI.requests();
	const bodies = requests
		.filter((r) => r.path === "/v1/chat/completions")
		.map((r) => JSON.stringify(r.body));
	expect(bodies.some((b) => b.includes("created playground v1"))).toBe(true);
	expect(bodies.some((b) => b.includes("updated playground → v2"))).toBe(true);
	expect(bodies.some((b) => b.includes("rewrote playground → v3"))).toBe(true);
});

test("a streamed-arguments draft is visible before the call completes", async ({
	page,
	mockOpenAI,
	db,
	session,
}) => {
	await useModel(db, session, TOOL_MODEL);
	const marker = "STREAMED_MARKER_ABCDEF";
	// Long enough that argument streaming lasts several seconds: the draft
	// must still be in flight when the assertions below run.
	const longContent = `# Big Doc\n\n${"Filler line.\n".repeat(200)}${marker}\n`;
	await mockOpenAI.setDefaultScenario({
		toolCalls: [
			{
				id: "call_big",
				name: "artifact",
				arguments: JSON.stringify({
					command: "create",
					identifier: "big-doc",
					type: "markdown",
					title: "Big Doc",
					content: longContent,
				}),
			},
		],
		content: ["Done", "."],
		chunkDelayMs: 120,
		toolCallArgChunkSize: 40,
	});

	await page.goto(`${E2E_APP_BASE}/`);
	await send(page, "write a big doc");
	await page.waitForURL(/\/conversation\/[a-f0-9]{24}/);

	const panel = page.getByLabel(PANEL_LABEL, { exact: true });
	// The draft preview arrives while arguments still stream: the panel shows
	// the title with a streaming indicator before the final text lands. The
	// draft previews live (markdown), so the panel header is matched at
	// level 2 — the content's own `# Big Doc` heading renders beside it.
	await expect(panel.getByRole("heading", { name: "Big Doc", level: 2 })).toBeVisible({
		timeout: 30_000,
	});
	await expect(panel.getByText("Streaming…")).toBeVisible({ timeout: 30_000 });
	// Still streaming: the call's final answer has not arrived yet.
	await expect(page.locator('[data-message-role="assistant"]').last()).not.toContainText("Done.", {
		timeout: 5_000,
	});
	// The call completes and the canonical block replaces the draft.
	await expect(panel).toContainText(marker, { timeout: 60_000 });
	await expect(page.locator('[data-message-role="assistant"]').last()).toContainText("Done.", {
		timeout: 30_000,
	});
});

test("a tags-mode model's inline artifact still renders", async ({
	page,
	mockOpenAI,
	db,
	session,
}) => {
	await useModel(db, session, TAGS_MODEL);
	await mockOpenAI.setDefaultScenario({
		content: [
			"Here",
			" it",
			" is",
			":\n\n",
			'<artifact identifier="notes" type="markdown" title="Notes">\n# Hi\n',
			"there\n</artifact>",
		],
		chunkDelayMs: 10,
	});

	await page.goto(`${E2E_APP_BASE}/`);
	await send(page, "take notes");
	await page.waitForURL(/\/conversation\/[a-f0-9]{24}/);

	const panel = page.getByLabel(PANEL_LABEL, { exact: true });
	await expect(panel).toBeVisible({ timeout: 30_000 });
	await expect(panel.getByRole("heading", { name: "Notes" })).toBeVisible({ timeout: 30_000 });
	await expect(page.locator('[aria-label="Open file: Notes"]')).toHaveCount(1, {
		timeout: 30_000,
	});
});

test("tags inside thinking are ignored", async ({ page, mockOpenAI, db, session }) => {
	await useModel(db, session, TAGS_MODEL);
	await mockOpenAI.setDefaultScenario({
		content: [
			"<think>",
			'Let me draft <artifact identifier="ghost" type="html" title="Ghost">boo</artifact> first.',
			"</think>",
			"\n\nNo artifacts here.",
		],
		chunkDelayMs: 10,
	});

	await page.goto(`${E2E_APP_BASE}/`);
	await send(page, "think out loud");
	await page.waitForURL(/\/conversation\/[a-f0-9]{24}/);

	await expect(page.locator('[data-message-role="assistant"]').last()).toContainText(
		"No artifacts here.",
		{ timeout: 30_000 }
	);
	// No card, no panel entry: the rehearsal inside reasoning never parsed.
	// (The header's "Open files panel" button always exists, so match card
	// labels only.)
	await expect(page.locator('[aria-label^="Open file: "]')).toHaveCount(0, {
		timeout: 30_000,
	});
});

test("a long artifact history sends stubs and one current copy, and read fetches v1", async ({
	page,
	mockOpenAI,
	db,
	session,
}) => {
	await useModel(db, session, TOOL_MODEL);
	const filler = "<p>FILLER_LINE_XYZ</p>\n".repeat(40);
	const deck = (marker: string) =>
		`<section><h1>${marker}</h1></section>\n<section>\n${filler}</section>\n`;
	const panel = page.getByLabel(PANEL_LABEL, { exact: true });
	const call = (id: string, args: Record<string, unknown>) => ({
		id,
		name: "artifact",
		arguments: JSON.stringify(args),
	});

	await mockOpenAI.setDefaultScenario({
		toolCalls: [
			call("call_c", {
				command: "create",
				identifier: "deck",
				type: "slides",
				title: "Team deck",
				content: deck("ALPHA_V1"),
			}),
		],
		content: ["Made", " it."],
		chunkDelayMs: 10,
	});
	await page.goto(`${E2E_APP_BASE}/`);
	await send(page, "make a deck");
	await page.waitForURL(/\/conversation\/[a-f0-9]{24}/);
	await expect(panel).toBeVisible({ timeout: 30_000 });

	const edit = async (n: number, from: string, to: string) => {
		await mockOpenAI.setDefaultScenario({
			toolCalls: [
				call(`call_u${n}`, { command: "update", identifier: "deck", old_str: from, new_str: to }),
			],
			content: ["Edited", "."],
			chunkDelayMs: 10,
		});
		await send(page, `edit ${n}`);
		await expect(panel.getByText(`v${n + 1} / ${n + 1}`)).toBeVisible({ timeout: 30_000 });
	};
	await edit(1, "ALPHA_V1", "BETA_V2");
	await edit(2, "BETA_V2", "GAMMA_V3");

	// Turn 4: a plain reply. What the model receives holds the deck once.
	await mockOpenAI.setDefaultScenario({ content: ["Fine", "."], chunkDelayMs: 10 });
	await send(page, "how does it look?");
	await expect(page.locator('[data-message-role="assistant"]').last()).toContainText("Fine.", {
		timeout: 30_000,
	});
	const chat = (await mockOpenAI.requests()).filter((r) => r.path === "/v1/chat/completions");
	const last = JSON.stringify(chat.at(-1)?.body);
	expect(last.split("FILLER_LINE_XYZ").length - 1).toBe(40);
	expect(last).toContain("GAMMA_V3");
	expect(last).not.toContain("ALPHA_V1");
	expect(last).not.toContain("BETA_V2");
	expect(last).toContain('[artifact \\"Team deck\\" (slides) → v1: created]');
	expect(last).toContain('[artifact \\"Team deck\\" (slides) → v3: updated, 1 edit]');
	expect(last).toContain("<current_artifacts>");

	// Turn 5: the model reads v1 and gets it back, marked as data.
	await mockOpenAI.setDefaultScenario({
		toolCalls: [call("call_r", { command: "read", identifier: "deck", version: 1 })],
		content: ["Read", " it."],
		chunkDelayMs: 10,
	});
	await send(page, "what did v1 say?");
	await expect(page.locator('[data-message-role="assistant"]').last()).toContainText("Read it.", {
		timeout: 30_000,
	});
	const after = (await mockOpenAI.requests()).filter((r) => r.path === "/v1/chat/completions");
	const followUp = JSON.stringify(after.at(-1)?.body);
	expect(followUp).toContain("ALPHA_V1");
	expect(followUp).toContain("v1 of 3");
});
