/**
 * The sandbox keeps the conversation's files across doc-tool turns: an
 * attachment is mounted for a code run even when the turns in between ran a
 * document tool (`doc_outline`, `doc_edit`), and a produced version is what
 * the next run reads at /mnt/data/<name> (the current version of the name).
 *
 * The owner's report (2026-10-29): attach a PDF, one `doc_outline` turn, then
 * ask for /mnt/data — the listing came back empty, and after a `doc_edit`
 * fill_form neither the attachment nor the produced version was there, on a
 * fresh page load and on a reopened conversation alike. Same mount path as
 * chat-attachment-mount.spec.ts (the RunsStore), so the fence here stands for
 * the `execute_code` card; the doc-tool turns between attach and run are the
 * part the older spec does not cover.
 */
import { test, expect, E2E_APP_BASE, waitForHydration } from "./fixtures.ts";
import { MOCK_DOCUMENTS_PORT } from "./mock-documents.ts";
import type { Db } from "mongodb";

const PDF = Buffer.from(
	"%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n",
	"latin1"
);
const DOCX = Buffer.from("PK\u0003\u0004 the original contract, Dear Acme");

const LIST_CODE = "import os\nprint('MOUNTLIST:' + repr(sorted(os.listdir('/mnt/data'))))";
const READ_PRODUCED_CODE =
	LIST_CODE +
	"\nb = open('/mnt/data/contract.docx', 'rb').read()\n" +
	"print('HASPRODUCED:' + str(b'edited by the mock document service' in b).upper())";

test.beforeEach(({ page }) => {
	page.on("console", (message) => {
		if (message.text().includes("[attachments]")) {
			process.stdout.write(`[browser console] ${message.text()}\n`);
		}
	});
});

/** A signed-in user with a gateway token, so a PDF upload extracts (scanned-pdf.spec.ts). */
async function seedReader(db: Db, sessionId: string): Promise<void> {
	await db.collection("knowledgeConfig").deleteMany({});
	const now = new Date();
	const { insertedId } = await db.collection("users").insertOne({
		name: "E2E Reader",
		username: "e2e-reader",
		hfUserId: "e2e-reader-sub",
		avatarUrl: undefined,
		createdAt: now,
		updatedAt: now,
	});
	await db.collection("sessions").insertOne({
		sessionId,
		userId: insertedId,
		expiresAt: new Date(now.getTime() + 24 * 3600 * 1000),
		createdAt: now,
		updatedAt: now,
		authTime: now,
		oauth: {
			token: { value: "e2e-reader-token", expiresAt: new Date(now.getTime() + 3600 * 1000) },
		},
	});
	await db
		.collection("settings")
		.updateOne({ sessionId }, { $set: { userId: insertedId, activeModel: "test-org/test-model" } });
}

test("an attachment survives a doc_outline turn and is listed by a later run, before and after a reload", async ({
	page,
	db,
	session,
	mockOpenAI,
}) => {
	test.setTimeout(180_000);
	await seedReader(db, session.sessionId);
	await mockOpenAI.setDefaultScenario({
		routes: [
			{
				// The later turns that ask for the listing run it as a code fence.
				contains: "XYZLIST",
				scenario: {
					content: ["Listing:\n\n```python\n" + LIST_CODE + "\n```\n"],
					chunkDelayMs: 10,
					finishReason: "stop",
				},
			},
		],
		content: ["It is a form."],
		toolCalls: [{ id: "call_outline", name: "doc_outline", arguments: '{"file":"form.pdf"}' }],
		chunkDelayMs: 10,
		finishReason: "stop",
	});

	await page.goto(`${E2E_APP_BASE}/`);
	await waitForHydration(page);
	await page.getByLabel("Upload file").setInputFiles({
		name: "form.pdf",
		mimeType: "application/pdf",
		buffer: PDF,
	});
	await expect(page.getByText("form.pdf")).toBeVisible();
	await page.getByPlaceholder("Ask anything").fill("please outline the form");
	await page.getByRole("button", { name: "Send message" }).click();
	await page.waitForURL(/\/conversation\/[a-f0-9]{24}/);

	const first = page.locator('[data-message-role="assistant"]').last();
	await expect(first).toContainText("It is a form.", { timeout: 90_000 });

	// The next turn's run sees the attachment.
	await page.getByPlaceholder("Ask anything").fill("can you list /mnt/data? XYZLIST");
	await page.getByRole("button", { name: "Send message" }).click();
	const second = page.locator('[data-message-role="assistant"]').last();
	await expect(second).toContainText("Finished", { timeout: 90_000 });
	await expect(second).toContainText("MOUNTLIST:['form.pdf'");

	// A fresh page load and a fresh sandbox: the stored copy is mounted again.
	await page.reload();
	await page.getByPlaceholder("Ask anything").fill("can you list /mnt/data once more? XYZLIST");
	await page.getByRole("button", { name: "Send message" }).click();
	const third = page.locator('[data-message-role="assistant"]').last();
	await expect(third).toContainText("Finished", { timeout: 90_000 });
	await expect(third).toContainText("MOUNTLIST:['form.pdf'");
});

test("an attachment edited through doc_edit is listed by a later run as the current version, before and after a reload", async ({
	page,
	request,
	mockOpenAI,
}) => {
	test.setTimeout(180_000);
	await request.post(`http://127.0.0.1:${MOCK_DOCUMENTS_PORT}/__control/reset`, { data: {} });
	await mockOpenAI.setDefaultScenario({
		routes: [
			{
				contains: "XYZLIST",
				scenario: {
					content: ["Listing:\n\n```python\n" + READ_PRODUCED_CODE + "\n```\n"],
					chunkDelayMs: 10,
					finishReason: "stop",
				},
			},
		],
		content: ["Done: Acme is now Beta."],
		toolCalls: [
			{
				id: "call_edit",
				name: "doc_edit",
				arguments:
					'{"file":"contract.docx","operations":[{"op":"replace_text","find":"Acme","replace":"Beta"}]}',
			},
		],
		chunkDelayMs: 10,
		finishReason: "stop",
	});

	await page.goto(`${E2E_APP_BASE}/`);
	await waitForHydration(page);
	await page.getByLabel("Upload file").setInputFiles({
		name: "contract.docx",
		mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
		buffer: DOCX,
	});
	await expect(page.getByText("contract.docx")).toBeVisible();
	await page.getByPlaceholder("Ask anything").fill("please change Acme to Beta");
	await page.getByRole("button", { name: "Send message" }).click();
	await page.waitForURL(/\/conversation\/[a-f0-9]{24}/);

	const first = page.locator('[data-message-role="assistant"]').last();
	await expect(first).toContainText("Acme is now Beta.", { timeout: 90_000 });
	await expect(first.getByTestId("file-artifact-card")).toHaveCount(1, { timeout: 30_000 });

	// The next turn's run sees the name, and the bytes are the produced version.
	await page.getByPlaceholder("Ask anything").fill("can you list /mnt/data? XYZLIST");
	await page.getByRole("button", { name: "Send message" }).click();
	const second = page.locator('[data-message-role="assistant"]').last();
	await expect(second).toContainText("Finished", { timeout: 90_000 });
	await expect(second).toContainText("MOUNTLIST:['contract.docx'");
	await expect(second).toContainText("HASPRODUCED:TRUE");

	// Reopened later: same listing from a fresh sandbox.
	await page.reload();
	await page.getByPlaceholder("Ask anything").fill("can you list /mnt/data once more? XYZLIST");
	await page.getByRole("button", { name: "Send message" }).click();
	const third = page.locator('[data-message-role="assistant"]').last();
	await expect(third).toContainText("Finished", { timeout: 90_000 });
	await expect(third).toContainText("MOUNTLIST:['contract.docx'");
	await expect(third).toContainText("HASPRODUCED:TRUE");
});

test("an execute_code tool call after a doc_outline turn lists the attachment, before and after a reload", async ({
	page,
	mockOpenAI,
}) => {
	test.setTimeout(180_000);
	await mockOpenAI.setDefaultScenario({
		routes: [
			{
				contains: "XYZLIST",
				scenario: {
					content: ["Listed."],
					toolCalls: [
						{
							id: "call_code",
							name: "execute_code",
							arguments: JSON.stringify({ code: LIST_CODE }),
						},
					],
					chunkDelayMs: 10,
					finishReason: "stop",
				},
			},
		],
		content: ["It is a form."],
		toolCalls: [{ id: "call_outline", name: "doc_outline", arguments: '{"file":"form.pdf"}' }],
		chunkDelayMs: 10,
		finishReason: "stop",
	});

	await page.goto(`${E2E_APP_BASE}/`);
	await waitForHydration(page);
	await page.getByLabel("Upload file").setInputFiles({
		name: "form.pdf",
		mimeType: "application/pdf",
		buffer: PDF,
	});
	await expect(page.getByText("form.pdf")).toBeVisible();
	await page.getByPlaceholder("Ask anything").fill("please outline the form");
	await page.getByRole("button", { name: "Send message" }).click();
	await page.waitForURL(/\/conversation\/[a-f0-9]{24}/);

	const first = page.locator('[data-message-role="assistant"]').last();
	await expect(first).toContainText("It is a form.", { timeout: 90_000 });

	// The next turn's execute_code tool call runs in the browser sandbox.
	await page.getByPlaceholder("Ask anything").fill("can you list /mnt/data? XYZLIST");
	await page.getByRole("button", { name: "Send message" }).click();
	const second = page.locator('[data-message-role="assistant"]').last();
	await expect(second).toContainText("Listed.", { timeout: 90_000 });
	await second.getByRole("button", { name: "Expand code output" }).click();
	await expect(second).toContainText("MOUNTLIST:['form.pdf'");

	// A fresh page load and a fresh sandbox: the stored copy is mounted again.
	await page.reload();
	await page.getByPlaceholder("Ask anything").fill("can you list /mnt/data once more? XYZLIST");
	await page.getByRole("button", { name: "Send message" }).click();
	const third = page.locator('[data-message-role="assistant"]').last();
	await expect(third).toContainText("Listed.", { timeout: 90_000 });
	await third.getByRole("button", { name: "Expand code output" }).click();
	await expect(third).toContainText("MOUNTLIST:['form.pdf'");
});
