/**
 * `doc_create` end to end (ADR 0103 step 3): the person attaches a logo, the
 * model (a mock) calls doc_create for a Word report with a table, the image and
 * a native chart, and a new file card appears. The document service is a mock
 * that records what it was sent: the spec, the image's bytes and the secret.
 */
import { test, expect, E2E_APP_BASE, E2E_APP_URL, waitForHydration } from "./fixtures.ts";
import { MOCK_CREATED_DOCX, MOCK_DOCUMENTS_PORT } from "./mock-documents.ts";

const LOGO = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
	"base64"
);

const CREATE = {
	format: "docx",
	file_name: "sales",
	images: ["logo.png"],
	spec: {
		title: "Sales",
		blocks: [
			{ type: "heading", level: 1, text: "Sales" },
			{
				type: "table",
				header: ["Region", "Units"],
				rows: [
					["North", 3],
					["South", 5],
				],
			},
			{ type: "image", image: "logo.png", width_cm: 4 },
			{
				type: "chart",
				chart_type: "column",
				title: "Units",
				categories: ["North", "South"],
				series: [{ name: "2026", values: [3, 5] }],
				render: "native",
			},
		],
	},
};

test("the model creates a Word report with a table, an image and a native chart", async ({
	page,
	request,
	mockOpenAI,
}) => {
	await request.post(`http://127.0.0.1:${MOCK_DOCUMENTS_PORT}/__control/reset`, { data: {} });
	await mockOpenAI.setDefaultScenario({
		toolCalls: [{ id: "call_create", name: "doc_create", arguments: JSON.stringify(CREATE) }],
		content: ["The", " report", " is ready", "."],
		chunkDelayMs: 10,
		finishReason: "stop",
	});

	await page.goto(`${E2E_APP_BASE}/`);
	await waitForHydration(page);
	await page.getByLabel("Upload file").setInputFiles({
		name: "logo.png",
		mimeType: "application/octet-stream", // shown as a file chip, like the docx of the edit spec
		buffer: LOGO,
	});
	await expect(page.getByText("logo.png")).toBeVisible();
	await page.getByPlaceholder("Ask anything").fill("make a sales report with our logo and a chart");
	await page.getByRole("button", { name: "Send message" }).click();
	await page.waitForURL(/\/conversation\/[a-f0-9]{24}/);
	const conversationId = page.url().split("/").pop() ?? "";

	const assistant = page.locator('[data-message-role="assistant"]').last();
	await expect(assistant).toContainText("The report is ready.", { timeout: 60_000 });

	// A file card, with open and download.
	const card = assistant.getByTestId("file-artifact-card");
	await expect(card).toHaveCount(1, { timeout: 30_000 });
	await expect(card).toContainText("sales.docx");
	await expect(assistant.getByRole("button", { name: "Open sales.docx in panel" })).toBeVisible();
	await expect(assistant.getByRole("button", { name: /Download sales\.docx/ })).toBeVisible();

	// The service was sent the spec (table, image block, native chart), the logo's bytes and the secret.
	const calls = (await (
		await request.get(`http://127.0.0.1:${MOCK_DOCUMENTS_PORT}/__control/calls`)
	).json()) as Array<{ path: string; secret: string; body: string }>;
	const made = calls.find((call) => call.path === "/v1/create");
	expect(made?.secret).toBe("e2e-documents-secret");
	expect(made?.body).toContain('"type":"table"');
	expect(made?.body).toContain('"type":"image"');
	expect(made?.body).toContain('"render":"native"');
	expect(made?.body).toContain('filename="logo.png"');
	expect(made?.body).toContain("PNG");

	// The stored file is what the service made (read with the page's own session).
	const stored = await page.request.get(
		`${E2E_APP_URL}/conversation/${conversationId}/code-execution/output`
	);
	expect(stored.ok()).toBe(true);
	const rows = (await stored.json()) as { files?: Array<{ name: string; sha256: string }> };
	const row = (rows.files ?? []).find((file) => file.name === "sales.docx");
	expect(row).toBeTruthy();
	const bytes = await page.request.get(
		`${E2E_APP_URL}/conversation/${conversationId}/code-execution/output/${row?.sha256}`
	);
	expect(Buffer.from(await bytes.body()).equals(MOCK_CREATED_DOCX)).toBe(true);

	// The model's next round saw the outline and what the chart became.
	const requests = await mockOpenAI.requests();
	expect(
		requests.some(
			(r) =>
				r.path === "/v1/chat/completions" &&
				JSON.stringify(r.body).includes("reopened_with") &&
				JSON.stringify(r.body).includes('\\"render\\":\\"native\\"')
		)
	).toBe(true);

	// Reload: the card comes back from what the turn stored.
	await page.reload();
	await expect(
		page.locator('[data-message-role="assistant"]').last().getByTestId("file-artifact-card")
	).toHaveCount(1, { timeout: 30_000 });
});
