/**
 * The blob store, end to end: a file attached in chat is stored, served back
 * byte for byte after a reload, and removed when its conversation is deleted.
 *
 * The suite runs on GridFS, the default. CI runs this spec a second time with
 * `CHAT_BLOB_STORE=s3` against a real S3-compatible server (RustFS), where the
 * same flow goes through the bucket and the `blobs` index; the assertions on
 * the index name the backend that must have been used, so a run that silently
 * fell back to GridFS fails.
 *
 * @smoke @blob-store
 */
import { test, expect, E2E_APP_URL, E2E_APP_BASE, waitForHydration } from "./fixtures";

const S3 = process.env.CHAT_BLOB_STORE === "s3";
/** Where the index row of a stored file lives for the backend under test. */
const INDEX = S3 ? "blobs" : "files.files";
const BODY = `stored and served back intact: ${"x".repeat(2048)}`;

test("an attachment is stored, served after a reload, and deleted with its conversation @smoke @blob-store", async ({
	page,
	db,
	mockOpenAI,
}) => {
	await mockOpenAI.setDefaultScenario("plainText");
	await page.goto(`${E2E_APP_BASE}/`);
	await waitForHydration(page);

	await page.getByLabel("Upload file").setInputFiles({
		name: "blob-store.txt",
		mimeType: "text/plain",
		buffer: Buffer.from(BODY),
	});
	await expect(page.getByText("blob-store.txt")).toBeVisible();
	await page.getByPlaceholder("Ask anything").fill("keep this file");
	await page.getByRole("button", { name: "Send message" }).click();
	await page.waitForURL(/\/conversation\/[a-f0-9]{24}/);
	const conversationId = page.url().split("/").pop() ?? "";
	await expect(page.locator('[data-message-role="assistant"]').last()).toContainText(
		"Hello from the mock server."
	);

	// Stored through the backend under test, indexed where that backend keeps its index.
	const stored = () =>
		db.collection(INDEX).countDocuments({ "metadata.conversation": conversationId });
	await expect.poll(stored).toBeGreaterThan(0);
	if (S3) {
		expect(
			await db.collection("files.files").countDocuments({ "metadata.conversation": conversationId })
		).toBe(0);
	}

	// Served back byte for byte after a reload, as a download.
	await page.reload();
	await waitForHydration(page);
	const served = page.waitForResponse((res) =>
		res.url().includes(`/conversation/${conversationId}/output/`)
	);
	await page.getByText("blob-store.txt").first().click();
	const response = await served;
	expect(response.status()).toBe(200);
	expect(response.headers()["content-disposition"]).toMatch(/^attachment;/);
	expect((await response.body()).toString()).toBe(BODY);

	// Deleting the conversation takes the bytes and the index row with it.
	const deleted = await page.request.delete(
		`${E2E_APP_URL}/api/v2/conversations/${conversationId}`,
		{ headers: { origin: E2E_APP_URL } }
	);
	expect(deleted.ok()).toBe(true);
	await expect.poll(stored).toBe(0);
});
