/**
 * Math in markdown artifacts (chat side): inline and display LaTeX render
 * through the same KaTeX pipeline as chat messages, and survive a reload.
 */
import { test, expect, E2E_APP_BASE } from "./fixtures.ts";
import type { Db } from "mongodb";
import type { Page } from "playwright/test";

const TOOL_MODEL = "test-org/artifact-tool";
const PANEL_LABEL = "Artifact panel";

async function useModel(db: Db, session: { sessionId: string }, model: string) {
	await db
		.collection("settings")
		.updateOne({ sessionId: session.sessionId }, { $set: { activeModel: model } });
}

async function send(page: Page, text: string) {
	await page.getByPlaceholder("Ask anything").fill(text);
	await page.getByRole("button", { name: "Send message" }).click();
}

const MATH_CONTENT =
	"# Math Notes\n\nEinstein said $E = mc^2$ once.\n\n$$\n\\int_0^1 x\\,dx = 1\n$$\n";

test("a markdown artifact renders inline and display math", async ({
	page,
	mockOpenAI,
	db,
	session,
}) => {
	await useModel(db, session, TOOL_MODEL);
	await mockOpenAI.setDefaultScenario({
		toolCalls: [
			{
				id: "call_math",
				name: "artifact",
				arguments: JSON.stringify({
					command: "create",
					identifier: "math-notes",
					type: "markdown",
					title: "Math Notes",
					content: MATH_CONTENT,
				}),
			},
		],
		content: ["Here", " are", " your", " notes", "."],
		chunkDelayMs: 10,
	});

	await page.goto(`${E2E_APP_BASE}/`);
	await send(page, "write math notes");
	await page.waitForURL(/\/conversation\/[a-f0-9]{24}/);

	const panel = page.getByLabel(PANEL_LABEL, { exact: true });
	await expect(panel).toBeVisible({ timeout: 30_000 });
	await expect(panel.getByRole("heading", { name: "Math Notes" })).toBeVisible({
		timeout: 30_000,
	});

	// Inline math renders (no raw dollars left), display math renders in display mode.
	await expect(panel.locator(".katex").first()).toBeVisible({ timeout: 30_000 });
	await expect(panel.locator(".katex-display")).toBeVisible({ timeout: 30_000 });
	await expect(panel).not.toContainText("$E = mc^2$");

	await panel.screenshot({ path: "reports/artifact-math.png" });

	// The rendering survives a reload.
	await page.reload();
	const panelAfter = page.getByLabel(PANEL_LABEL, { exact: true });
	await expect(panelAfter.locator(".katex-display")).toBeVisible({ timeout: 30_000 });
});
