/**
 * File artifacts (chat side): persisted `execute_code` deliverables appear
 * as versioned artifacts with previews, survive a reload, and are listed in
 * the export.
 *
 * The bytes are seeded straight into the server-side output store (GridFS
 * `codeOutputs` + `codeExecutionOutputs` rows) with resolved
 * code-execution updates on the messages — exactly what a settled Pyodide
 * run leaves behind once the browser uploads its output files.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { GridFSBucket, ObjectId, type Db } from "mongodb";
import { zipSync } from "fflate";
import type { Page } from "playwright/test";
import { test, expect, E2E_APP_BASE, type SeedConversationInput } from "./fixtures.ts";

/** Minimal one-page PDF with correct xref offsets, so the native viewer accepts it. */
function makePdf(text: string): Buffer {
	const escaped = text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
	const stream = `BT /F1 24 Tf 100 700 Td (${escaped}) Tj ET`;
	const objects = [
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
		`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
	];
	let out = "%PDF-1.4\n";
	const offsets: number[] = [];
	objects.forEach((body, i) => {
		offsets.push(out.length);
		out += `${i + 1} 0 obj\n${body}\nendobj\n`;
	});
	const xrefAt = out.length;
	out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
	for (const offset of offsets) out += `${String(offset).padStart(10, "0")} 00000 n \n`;
	out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF`;
	return Buffer.from(out, "latin1");
}

/** Minimal .docx (uncompressed zip): enough for docx-preview to render the paragraph. */
function makeDocx(paragraph: string): Buffer {
	const files: Record<string, Uint8Array> = {
		"[Content_Types].xml": new TextEncoder().encode(
			`<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`
		),
		"_rels/.rels": new TextEncoder().encode(
			`<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`
		),
		"word/document.xml": new TextEncoder().encode(
			`<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${paragraph}</w:t></w:r></w:p><w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>`
		),
	};
	return Buffer.from(zipSync(files, { level: 0 }));
}

async function seedDeliverable(
	db: Db,
	conversationId: ObjectId,
	name: string,
	mime: string,
	bytes: Buffer
): Promise<{ name: string; size: number; sha256: string }> {
	const sha256 = createHash("sha256").update(bytes).digest("hex");
	const bucket = new GridFSBucket(db, { bucketName: "codeOutputs" });
	const gridFsId = new ObjectId();
	await new Promise<void>((resolve, reject) => {
		const stream = bucket.openUploadStreamWithId(
			gridFsId,
			`${conversationId.toString()}-${sha256}`
		);
		stream.once("finish", () => resolve());
		stream.once("error", reject);
		stream.end(bytes);
	});
	await db.collection("codeExecutionOutputs").insertOne({
		_id: new ObjectId(),
		conversationId,
		sha256,
		name,
		mime,
		size: bytes.byteLength,
		gridFsId,
		createdAt: new Date(),
	});
	return { name, size: bytes.byteLength, sha256 };
}

const resolvedUpdate = (executionId: string, files: unknown) => ({
	type: "codeExecution",
	subtype: "resolved",
	executionId,
	outcome: { ok: true, stdout: "", stderr: "" },
	files,
});

// A settled turn ends with a final answer — without it the page treats the
// conversation as still generating (and disables the export).
const finalAnswer = (text: string) => ({ type: "finalAnswer", text, interrupted: false });

test("Pyodide outputs appear as file artifacts with previews, versions and export", async ({
	page,
	db,
	seedConversation,
}) => {
	// The shared `db` fixture does not wipe the deliverable store between tests.
	await db.collection("codeExecutionOutputs").deleteMany({});
	await db.collection("codeOutputs.files").deleteMany({});
	await db.collection("codeOutputs.chunks").deleteMany({});

	// Seed first so the conversation id exists for the GridFS filenames, then
	// hang the resolved updates onto the two assistant messages by index
	// (0 system, 1 user, 2 + 3 assistant) — rootMessageId stays intact.
	const conversationId = await seedConversation({
		title: "Files",
		messages: [
			{ from: "system", content: "" },
			{ from: "user", content: "make me a pdf and a docx" },
			{ from: "assistant", content: "Here is your PDF." },
			{ from: "assistant", content: "Updated the PDF and made the DOCX." },
		],
	});

	const pdfV1 = await seedDeliverable(
		db,
		conversationId,
		"hello.pdf",
		"application/pdf",
		makePdf("Hello PDF v1")
	);
	const pdfV2 = await seedDeliverable(
		db,
		conversationId,
		"hello.pdf",
		"application/pdf",
		makePdf("Hello PDF v2")
	);
	const docx = await seedDeliverable(
		db,
		conversationId,
		"hello.docx",
		"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
		makeDocx("Hello DOCX")
	);

	// A re-run that rewrote hello.pdf (v2) plus a docx from another run.
	await db.collection("conversations").updateOne(
		{ _id: conversationId },
		{
			$set: {
				"messages.2.updates": [
					resolvedUpdate("e-pdf-1", [pdfV1]),
					finalAnswer("Here is your PDF."),
				],
				"messages.3.updates": [
					resolvedUpdate("e-pdf-2", [pdfV2]),
					resolvedUpdate("e-docx-1", [docx]),
					finalAnswer("Updated the PDF and made the DOCX."),
				],
			},
		}
	);

	await page.goto(`${E2E_APP_BASE}/conversation/${conversationId.toString()}`);

	// The library lists both persisted files.
	await page.getByRole("button", { name: "Open artifacts panel" }).click();
	const library = page.getByLabel("Artifacts panel", { exact: true });
	await expect(library.getByText("hello.pdf")).toBeVisible({ timeout: 30_000 });
	await expect(library.getByText("hello.docx")).toBeVisible();

	// The PDF opens as a file artifact at v2 with an unsandboxed native preview.
	await library.getByRole("button", { name: "Open hello.pdf in panel" }).click();
	const panel = page.getByLabel("Artifact panel", { exact: true });
	await expect(panel.getByRole("heading", { name: "hello.pdf" })).toBeVisible({
		timeout: 30_000,
	});
	await expect(panel.getByText("v2 / 2")).toBeVisible({ timeout: 30_000 });
	const pdfView = panel.getByTestId("file-artifact-view");
	await expect(pdfView).toHaveAttribute("data-kind", "pdf");
	const pdfFrame = pdfView.locator('iframe[title="Preview of hello.pdf"]');
	await expect(pdfFrame).toHaveAttribute("src", /^data:application\/pdf/, { timeout: 30_000 });
	// Deliberately unsandboxed: the native viewer refuses sandboxed frames.
	await expect(pdfFrame).not.toHaveAttribute("sandbox");

	await panel.screenshot({ path: "reports/artifact-file-pdf.png" });

	// Version history: v1 is one step back.
	await panel.getByRole("button", { name: "Previous version" }).click();
	await expect(panel.getByText("v1 / 2")).toBeVisible();
	await panel.getByRole("button", { name: "Next version" }).click();
	await expect(panel.getByText("v2 / 2")).toBeVisible();

	// The DOCX renders its paragraph through the sanitised preview.
	await page.getByRole("button", { name: "Open artifacts panel" }).click();
	await library.getByRole("button", { name: "Open hello.docx in panel" }).click();
	await expect(panel.getByRole("heading", { name: "hello.docx" })).toBeVisible({
		timeout: 30_000,
	});
	const docxFrame = panel
		.getByTestId("file-artifact-view")
		.locator('iframe[title="Preview of hello.docx"]');
	await expect(docxFrame.contentFrame().getByText("Hello DOCX")).toBeVisible({
		timeout: 30_000,
	});

	// The pages fit the pane's width, never clip, and never enlarge past their
	// real size: at the default pane (a third of a 1280 window, ~420px against
	// the document's ~800px A4 pages) the rendering is scaled down and the
	// frame has no horizontal overflow; once the window is wide enough the
	// scale returns to 1.
	const docxInside = docxFrame.contentFrame();
	await expect(docxInside.locator(".docx-wrapper")).toBeVisible({ timeout: 30_000 });
	const measureDocx = () =>
		docxInside.locator("html").evaluate(() => {
			const wrapper = document.querySelector<HTMLElement>(".docx-wrapper");
			const sections = [...document.querySelectorAll<HTMLElement>("section.docx")];
			const root = document.documentElement;
			return {
				scale: sections[0]?.style.zoom ?? "",
				width: wrapper?.getBoundingClientRect().width ?? 0,
				pageWidth: Math.max(0, ...sections.map((s) => s.getBoundingClientRect().width)),
				frameWidth: root.clientWidth,
				scrollWidth: root.scrollWidth,
			};
		});
	const narrow = await measureDocx();
	expect(narrow.scale).not.toBe("1");
	expect(narrow.pageWidth).toBeLessThanOrEqual(narrow.frameWidth);
	expect(narrow.scrollWidth).toBeLessThanOrEqual(narrow.frameWidth);

	await page.setViewportSize({ width: 4200, height: 1000 });
	await expect.poll(async () => (await measureDocx()).scale).toBe("1");
	const wide = await measureDocx();
	expect(wide.pageWidth).toBeLessThanOrEqual(wide.frameWidth);
	await page.setViewportSize({ width: 1280, height: 720 });

	// The export lists both generated files.
	await page.getByRole("button", { name: "Open artifacts panel" }).click();
	const exportPromise = page.waitForEvent("download");
	await library.getByRole("button", { name: "Export conversation as Markdown" }).click();
	const exportDownload = await exportPromise;
	const exportPath = await exportDownload.path();
	const markdown = await readFile(exportPath as string, "utf-8");
	expect(markdown).toContain("- Generated file: hello.pdf");
	expect(markdown).toContain("- Generated file: hello.docx");

	// Everything survives a reload: rows, registry entries and bytes.
	await page.reload();
	await page.getByRole("button", { name: "Open artifacts panel" }).click();
	await expect(library.getByText("hello.pdf")).toBeVisible({ timeout: 30_000 });
	await library.getByRole("button", { name: "Open hello.pdf in panel" }).click();
	await expect(panel.getByRole("heading", { name: "hello.pdf" })).toBeVisible({
		timeout: 30_000,
	});
	await expect(
		panel.getByTestId("file-artifact-view").locator('iframe[title="Preview of hello.pdf"]')
	).toHaveAttribute("src", /^data:application\/pdf/, { timeout: 30_000 });
});

/**
 * Seeds the same "hello world docx" conversation the reload test uses (a
 * settled assistant message with a stored `codeRunFiles` record), for the
 * narrow-column layout tests below. Returns the conversation id.
 */
async function seedHelloWorldDocxConversation(
	db: Db,
	seedConversation: (input?: SeedConversationInput) => Promise<ObjectId>
): Promise<ObjectId> {
	await db.collection("codeExecutionOutputs").deleteMany({});
	await db.collection("codeRunFiles").deleteMany({});
	await db.collection("codeOutputs.files").deleteMany({});
	await db.collection("codeOutputs.chunks").deleteMany({});

	const code =
		'from docx import Document\nd = Document()\nd.add_paragraph("Hello world")\nd.save("hello_world.docx")';
	const answer = `Here's a small script that creates the file:\n\n\`\`\`python\n${code}\n\`\`\`\n`;
	const conversationId = await seedConversation({
		title: "Hello world docx",
		messages: [
			{ from: "system", content: "" },
			{ from: "user", content: "Can you create a hello world docx?" },
			{ from: "assistant", content: answer },
		],
	});
	const docx = await seedDeliverable(
		db,
		conversationId,
		"hello_world.docx",
		"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
		makeDocx("Hello world")
	);
	const conv = await db.collection("conversations").findOne({ _id: conversationId });
	const assistantId = (conv?.messages as Array<{ id: string; from: string }>).find(
		(m) => m.from === "assistant"
	)?.id;
	await db
		.collection("conversations")
		.updateOne({ _id: conversationId }, { $set: { "messages.2.updates": [finalAnswer(answer)] } });
	await db.collection("codeRunFiles").insertOne({
		_id: new ObjectId(),
		conversationId,
		messageId: assistantId,
		runKey: chatRunKey(code),
		files: [docx],
		fingerprint: docx.sha256,
		createdAt: new Date(),
	});
	return conversationId;
}

/** The same key CodeBlock uses (`chatRunKey` in src/lib/utils/execution/keys.ts). */
function chatRunKey(code: string): string {
	let hash = 5381;
	for (let i = 0; i < code.length; i++) hash = ((hash << 5) + hash + code.charCodeAt(i)) | 0;
	return `chat:${(hash >>> 0).toString(36)}`;
}

test("a code block's file is a file artifact too, and comes back after a reload", async ({
	page,
	db,
	seedConversation,
}) => {
	// The case the user hit: "create a hello world docx" answered with an
	// auto-running code block (not the execute_code tool). Its file used to be
	// session-only — never an artifact, gone on reload. What the browser now
	// leaves behind once that block's run settles is a stored deliverable plus
	// a `codeRunFiles` record naming the message; that is what is seeded here.
	const conversationId = await seedHelloWorldDocxConversation(db, seedConversation);

	for (const pass of ["first load", "after a reload"]) {
		if (pass === "after a reload") await page.reload();
		else await page.goto(`${E2E_APP_BASE}/conversation/${conversationId.toString()}`);

		// Under the block, the stored file stands in for the sandbox's (dead) one.
		await expect(page.getByText("hello_world.docx").first(), pass).toBeVisible({
			timeout: 30_000,
		});

		// And it is a file artifact like any other: listed, and opens in the panel.
		await page.getByRole("button", { name: "Open artifacts panel" }).click();
		const library = page.getByLabel("Artifacts panel", { exact: true });
		await library.getByRole("button", { name: "Open hello_world.docx in panel" }).click();
		const panel = page.getByLabel("Artifact panel", { exact: true });
		await expect(panel.getByRole("heading", { name: "hello_world.docx" }), pass).toBeVisible({
			timeout: 30_000,
		});
		const frame = panel
			.getByTestId("file-artifact-view")
			.locator('iframe[title="Preview of hello_world.docx"]');
		await expect(frame.contentFrame().getByText("Hello world"), pass).toBeVisible({
			timeout: 30_000,
		});
	}
});

/**
 * Asserts the inline FileCard's own name span (never the artifact panel's,
 * which carries the same title) is actually on screen with its text: not
 * squeezed to zero width by the size badge and buttons, and not showing the
 * bare size with a blank name. Also checks the card's `<li>` carries no
 * browser default list marker (a bare `<li>` outside a `list-none` `<ul>`).
 */
async function expectFileCardNameVisible(page: Page, name: string): Promise<void> {
	const nameSpan = page.locator('[data-message-role="assistant"]').locator(`span[title="${name}"]`);
	await expect(nameSpan).toBeVisible();
	await expect(nameSpan).toHaveText(name);
	const box = await nameSpan.boundingBox();
	expect(box?.width ?? 0).toBeGreaterThan(0);

	const listStyle = await nameSpan.evaluate(
		(el) => getComputedStyle(el.closest("li") as HTMLLIElement).listStyleType
	);
	expect(listStyle).toBe("none");
}

test("the inline file card keeps its filename visible when the chat column is narrow (artifact panel open)", async ({
	page,
	db,
	seedConversation,
}) => {
	// The live report: the artifact panel open beside the chat squeezes the
	// column enough that the file card's name span (flex-1 + min-w-0, no
	// floor) collapsed to zero width — showing the icon, size and buttons
	// with no filename at all, plus a stray list marker.
	const conversationId = await seedHelloWorldDocxConversation(db, seedConversation);
	await page.goto(`${E2E_APP_BASE}/conversation/${conversationId.toString()}`);

	await page.getByRole("button", { name: "Open artifacts panel" }).click();
	const library = page.getByLabel("Artifacts panel", { exact: true });
	await library.getByRole("button", { name: "Open hello_world.docx in panel" }).click();
	await expect(page.getByLabel("Artifact panel", { exact: true })).toBeVisible();

	await expectFileCardNameVisible(page, "hello_world.docx");
});

test("the inline file card keeps its filename visible on a narrow (390x844) viewport", async ({
	page,
	db,
	seedConversation,
}) => {
	await page.setViewportSize({ width: 390, height: 844 });
	const conversationId = await seedHelloWorldDocxConversation(db, seedConversation);
	await page.goto(`${E2E_APP_BASE}/conversation/${conversationId.toString()}`);

	await expectFileCardNameVisible(page, "hello_world.docx");
});
