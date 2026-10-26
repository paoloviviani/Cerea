/**
 * `doc_edit` end to end (ADR 0103 step 2): the person attaches a Word file, the
 * model edits it through the tool (the document service is a mock), and a new
 * file card appears in the chat: the edit is saved as a stored file the person
 * can open and download, and the model's next round sees the diff.
 */
import { test, expect, E2E_APP_BASE, E2E_APP_URL, waitForHydration } from "./fixtures.ts";
import { MOCK_DOCUMENTS_PORT, MOCK_EDITED_DOCX } from "./mock-documents.ts";

const EDIT = {
	file: "contract.docx",
	operations: [{ op: "replace_text", find: "Acme", replace: "Beta" }],
};

test("the model edits an attached Word file and a new file card appears", async ({
	page,
	request,
	mockOpenAI,
}) => {
	await request.post(`http://127.0.0.1:${MOCK_DOCUMENTS_PORT}/__control/reset`, { data: {} });
	await mockOpenAI.setDefaultScenario({
		toolCalls: [{ id: "call_edit", name: "doc_edit", arguments: JSON.stringify(EDIT) }],
		content: ["Done", ": Acme", " is now", " Beta", "."],
		chunkDelayMs: 10,
		finishReason: "stop",
	});

	await page.goto(`${E2E_APP_BASE}/`);
	await waitForHydration(page);
	await page.getByLabel("Upload file").setInputFiles({
		name: "contract.docx",
		mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
		buffer: Buffer.from("PK\u0003\u0004 the original contract, Dear Acme"),
	});
	await expect(page.getByText("contract.docx")).toBeVisible();
	await page.getByPlaceholder("Ask anything").fill("change Acme to Beta in the contract");
	await page.getByRole("button", { name: "Send message" }).click();
	await page.waitForURL(/\/conversation\/[a-f0-9]{24}/);
	const conversationId = page.url().split("/").pop() ?? "";

	const assistant = page.locator('[data-message-role="assistant"]').last();
	await expect(assistant).toContainText("Acme is now Beta.", { timeout: 60_000 });

	// The new version is an ordinary file card, with download.
	const card = assistant.getByTestId("file-artifact-card");
	await expect(card).toHaveCount(1, { timeout: 30_000 });
	await expect(card).toContainText("contract.docx");
	await expect(
		assistant.getByRole("button", { name: "Open contract.docx in panel" })
	).toBeVisible();
	await expect(assistant.getByRole("button", { name: /Download contract\.docx/ })).toBeVisible();

	// The service was sent the attachment's bytes, with the secret.
	const calls = (await (
		await request.get(`http://127.0.0.1:${MOCK_DOCUMENTS_PORT}/__control/calls`)
	).json()) as Array<{ path: string; secret: string; body: string }>;
	const edit = calls.find((call) => call.path === "/v1/edit");
	expect(edit?.body).toContain("the original contract, Dear Acme");
	expect(edit?.body).toContain('"replace_text"');

	// The stored file is the edited one (read with the page's own session) (the original attachment is untouched).
	const stored = await page.request.get(
		`${E2E_APP_URL}/conversation/${conversationId}/code-execution/output`
	);
	expect(stored.ok()).toBe(true);
	const rows = (await stored.json()) as { files?: Array<{ name: string; sha256: string }> };
	const row = (rows.files ?? []).find((file) => file.name === "contract.docx");
	expect(row).toBeTruthy();
	const bytes = await page.request.get(
		`${E2E_APP_URL}/conversation/${conversationId}/code-execution/output/${row?.sha256}`
	);
	expect(Buffer.from(await bytes.body()).equals(MOCK_EDITED_DOCX)).toBe(true);

	// The model's next round read the diff and the verification in the tool result.
	const requests = await mockOpenAI.requests();
	expect(
		requests.some(
			(r) =>
				r.path === "/v1/chat/completions" &&
				JSON.stringify(r.body).includes("+ Dear Beta") &&
				JSON.stringify(r.body).includes("byte_identical")
		)
	).toBe(true);

	// Reload: the card comes back from what the turn stored.
	await page.reload();
	await expect(
		page.locator('[data-message-role="assistant"]').last().getByTestId("file-artifact-card")
	).toHaveCount(1, { timeout: 30_000 });
});
