/**
 * A code fence that imports a package with no `micropip.install` first must
 * still work: the worker installs a run's own imports before it runs (see
 * src/lib/utils/execution/autoInstallImports.ts). Live twice, the model wrote
 * `from docx import Document` with no install and the block failed with
 * ModuleNotFoundError.
 *
 * Real Pyodide in the browser, same pattern as
 * chat-autorun-final-answer.spec.ts: the model's whole answer (fence
 * included) arrives in one chunk and the block auto-runs with no Run click.
 */
import { test, expect, E2E_APP_BASE } from "./fixtures.ts";

const RUN = { name: "Run code" };

test("a code fence that imports a vendored package with no install still works", async ({
	page,
	mockOpenAI,
}) => {
	test.setTimeout(90_000);

	await mockOpenAI.setDefaultScenario({
		content: [
			"Here you go:\n\n```python\n" +
				"from docx import Document\n" +
				'd = Document()\nd.add_paragraph("Hello world")\nd.save("hello_world.docx")\n' +
				"```\n",
		],
		chunkDelayMs: 10,
		finishReason: "stop",
	});

	await page.goto(`${E2E_APP_BASE}/`);
	await page.getByPlaceholder("Ask anything").fill("create a hello world docx");
	await page.getByRole("button", { name: "Send message" }).click();
	await page.waitForURL(/\/conversation\/[a-f0-9]{24}/);

	const runButton = page.getByRole("button", RUN);
	await expect(runButton).toBeVisible({ timeout: 30_000 });

	const assistantMessage = page.locator('[data-message-role="assistant"]').last();
	// No install step was written into the code, and it still finishes clean —
	// the auto-install ran before the interpreter ever saw `from docx import
	// Document`.
	await expect(assistantMessage).toContainText("Finished", { timeout: 60_000 });
	await expect(assistantMessage).not.toContainText("ModuleNotFoundError");
	// The file card's name span holds exactly the bare filename (see
	// FileCard.svelte); the code fence's own syntax-highlighted string literal
	// reads the same name but quoted, and the download button's title reads
	// "Download hello_world.docx" — an exact match on the bare name is unique
	// to the card.
	await expect(assistantMessage.getByText("hello_world.docx", { exact: true })).toBeVisible({
		timeout: 10_000,
	});
});

test("a code fence importing an unknown module still fails normally, with no hang", async ({
	page,
	mockOpenAI,
}) => {
	test.setTimeout(90_000);

	await mockOpenAI.setDefaultScenario({
		content: ["Here you go:\n\n```python\nimport not_a_real_module_xyz\n```\n"],
		chunkDelayMs: 10,
		finishReason: "stop",
	});

	await page.goto(`${E2E_APP_BASE}/`);
	await page.getByPlaceholder("Ask anything").fill("import something that doesn't exist");
	await page.getByRole("button", { name: "Send message" }).click();
	await page.waitForURL(/\/conversation\/[a-f0-9]{24}/);

	const runButton = page.getByRole("button", RUN);
	await expect(runButton).toBeVisible({ timeout: 30_000 });

	const assistantMessage = page.locator('[data-message-role="assistant"]').last();
	// The auto-install pass is best-effort and gives up quietly on a name it
	// doesn't recognize: the run still completes (no hang) and reports the
	// interpreter's own, honest error (no crash, no swallowed traceback).
	await expect(assistantMessage).toContainText("Finished with errors", { timeout: 60_000 });
	await expect(assistantMessage).toContainText("ModuleNotFoundError");
	await expect(assistantMessage).toContainText("not_a_real_module_xyz");
});
