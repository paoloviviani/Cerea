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
import { test, expect, E2E_APP_BASE } from "./fixtures.ts";

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
			`<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${paragraph}</w:t></w:r></w:p></w:body></w:document>`
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
				"messages.2.updates": [resolvedUpdate("e-pdf-1", [pdfV1])],
				"messages.3.updates": [
					resolvedUpdate("e-pdf-2", [pdfV2]),
					resolvedUpdate("e-docx-1", [docx]),
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
