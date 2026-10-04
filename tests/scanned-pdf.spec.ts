/**
 * A scanned PDF, end to end: the local reader hands back page images for a
 * model that reads images, and a model that does not is told it is a scan.
 *
 * The extractor is the mock gateway's `/v1/ocr`, which follows the frozen
 * contract (Pystino answers 200 with `page_images` only when asked). A signed-in
 * session is seeded in Mongo with a gateway token, as `knowledge-screen.spec`
 * does, because a session-only visitor has no credential to read a document
 * with.
 */
import { test, expect, E2E_APP_BASE, type MockOpenAIControl } from "./fixtures.ts";
import type { Db } from "mongodb";
import type { Page } from "playwright/test";

async function signIn(db: Db, sessionId: string, activeModel: string): Promise<void> {
	// The deployment default: no stored reader choice, so the local reader reads PDFs
	// (another spec's saved choice would otherwise leak in through the shared database).
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
		.updateOne({ sessionId }, { $set: { userId: insertedId, activeModel } });
}

async function sendScan(page: Page) {
	await page.goto(`${E2E_APP_BASE}/`);
	await page.getByLabel("Upload file").setInputFiles({
		name: "scan.pdf",
		mimeType: "application/pdf",
		buffer: Buffer.from("%PDF-1.4\n% pretend this is an image-only scan\n"),
	});
	await expect(page.getByText("scan.pdf")).toBeVisible();
	await page.getByPlaceholder("Ask anything").fill("what does the scan say?");
	await page.getByRole("button", { name: "Send message" }).click();
	await page.waitForURL(/\/conversation\/[a-f0-9]{24}/);
	await expect(page.locator('[data-message-role="assistant"]').last()).toContainText(
		"Hello from the mock server."
	);
}

type Recorded = Awaited<ReturnType<MockOpenAIControl["requests"]>>[number];

function lastChat(requests: Recorded[]) {
	const chats = requests.filter((r) => r.path === "/v1/chat/completions");
	return chats[chats.length - 1];
}

function userContent(request: Recorded): unknown {
	const messages = (request.body as { messages: { role: string; content: unknown }[] }).messages;
	return messages.filter((m) => m.role === "user").at(-1)?.content;
}

test("a PDF's scanned pages reach a model that reads images, as images, in a page-ordered document", async ({
	page,
	db,
	session,
	mockOpenAI,
}) => {
	await signIn(db, session.sessionId, "test-org/test-model");
	await mockOpenAI.setDefaultScenario("plainText");

	await sendScan(page).catch(async (e) => {
		console.log(
			"DBG",
			JSON.stringify(
				(await mockOpenAI.requests()).map((r) => [r.path, JSON.stringify(r.body).slice(0, 300)])
			)
		);
		throw e;
	});

	const requests = await mockOpenAI.requests();
	const ocr = requests.filter((r) => r.path === "/v1/ocr");
	expect(ocr).toHaveLength(1);
	expect(ocr[0].body).toMatchObject({
		model: "markitdown",
		page_images: { max_pages: 20, long_side: 1280 },
	});

	const content = userContent(lastChat(requests)) as { type: string; text?: string }[];
	expect(content.filter((part) => part.type === "image_url")).toHaveLength(2);
	const text = content.find((part) => part.type === "text")?.text ?? "";
	expect(text).toContain("PDF scan.pdf: pages 2–3 are scans, attached as images");
	expect(text).toContain("Page one of the mock PDF has real text on it");
	expect(text).toContain("Page 2 is a scan, attached as an image.");
	expect(text.indexOf("Page one of the mock")).toBeLessThan(text.indexOf("Page 2 is a scan"));

	// The pages are stored as attachments of the conversation, so they go with it.
	const conversationId = page.url().split("/").pop() ?? "";
	const stored = await db
		.collection("files.files")
		.countDocuments({ "metadata.conversation": conversationId, "metadata.mime": "image/jpeg" });
	expect(stored).toBe(1); // the mock's two pages have identical bytes: one entry, sent twice
});

test("a model that cannot read images gets the text and a sentence for each scanned page, no images", async ({
	page,
	db,
	session,
	mockOpenAI,
}) => {
	await signIn(db, session.sessionId, "test-org/text-only");
	await mockOpenAI.setDefaultScenario("plainText");

	await sendScan(page);

	const requests = await mockOpenAI.requests();
	// The pages are rendered and stored at upload whatever the model: the person
	// can switch to one that reads images on the next turn.
	const ocr = requests.filter((r) => r.path === "/v1/ocr");
	expect(ocr).toHaveLength(1);
	expect(ocr[0].body).toMatchObject({ page_images: { max_pages: 20 } });

	const content = userContent(lastChat(requests));
	const text = typeof content === "string" ? content : JSON.stringify(content);
	expect(text).not.toContain("image_url");
	expect(text).toContain("Page one of the mock PDF has real text on it");
	expect(text).toContain("the current model cannot read images");
	expect(text).toContain("model that reads images or an OCR reader");
	expect(text).not.toContain("attached as an image");
});
