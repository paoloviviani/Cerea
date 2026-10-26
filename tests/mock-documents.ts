/**
 * Mock of the document service (`documents/`, ADR 0103): `/v1/capabilities` and
 * `/v1/edit` with the shapes the real one answers, so a spec can drive the
 * chat's `doc_edit` tool end to end with no Python. It records what it was
 * sent (document name, bytes, body) for assertions, and refuses a call without
 * the shared secret like the real one.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { pathToFileURL } from "node:url";

export const MOCK_DOCUMENTS_PORT = Number(process.env.MOCK_DOCUMENTS_PORT ?? 8797);
export const MOCK_DOCUMENTS_SECRET = "e2e-documents-secret";

/** What the mock returns as the edited file; a spec asserts the card's download holds it. */
export const MOCK_EDITED_DOCX = Buffer.from("PK\u0003\u0004 edited by the mock document service");
/** What the mock returns as a created file (`/v1/create`). */
export const MOCK_CREATED_DOCX = Buffer.from("PK\u0003\u0004 created by the mock document service");

const BLOCK = (type: string, properties: Record<string, unknown>, required: string[] = []) => ({
	type: "object",
	properties: { type: { const: type }, ...properties },
	required: ["type", ...required],
});
const TEXT = { text: { type: "string" } };

export interface RecordedDocumentsCall {
	path: string;
	secret: string | undefined;
	/** The multipart body as latin1 text: enough to find the file name, bytes and JSON body. */
	body: string;
}

export function createMockDocuments(): { server: Server; calls: RecordedDocumentsCall[] } {
	const calls: RecordedDocumentsCall[] = [];
	const server = createServer((req, res) => {
		const send = (status: number, value: unknown) => {
			res.writeHead(status, { "Content-Type": "application/json" });
			res.end(JSON.stringify(value));
		};
		if (req.url === "/__control/health") return send(200, { ok: true });
		if (req.url === "/__control/calls") return send(200, calls);
		if (req.url === "/__control/reset") {
			calls.length = 0;
			return send(200, {});
		}
		const chunks: Buffer[] = [];
		req.on("data", (chunk) => chunks.push(chunk));
		req.on("end", () => {
			const secret = req.headers["x-cerea-documents-secret"] as string | undefined;
			if (secret !== MOCK_DOCUMENTS_SECRET) {
				return send(401, { error: { code: "unauthorized", message: "wrong secret" } });
			}
			if (req.url === "/v1/capabilities") {
				return send(200, {
					engine: "mock-documents/1",
					formats: {
						docx: {
							outline: true,
							read: true,
							operations: ["replace_text"],
							operation_schemas: {
								replace_text: {
									type: "object",
									properties: {
										op: { type: "string" },
										find: { type: "string" },
										replace: { type: "string" },
									},
									required: ["op", "find", "replace"],
								},
							},
							track_changes: true,
						},
					},
					create: true,
					create_from_template: true,
					create_formats: ["docx"],
					create_schemas: {
						docx: {
							document: {
								type: "object",
								properties: { title: { type: "string" }, blocks: { type: "array" } },
							},
							blocks: {
								heading: BLOCK("heading", { level: { type: "integer" }, ...TEXT }, ["level"]),
								table: BLOCK("table", { header: { type: "array" }, rows: { type: "array" } }, [
									"rows",
								]),
								image: BLOCK("image", { image: { type: "string" } }, ["image"]),
								chart: BLOCK(
									"chart",
									{
										chart_type: { enum: ["column", "pie"] },
										render: { enum: ["native", "image"] },
										series: { type: "array" },
									},
									["chart_type", "series"]
								),
							},
						},
					},
				});
			}
			calls.push({ path: req.url ?? "", secret, body: Buffer.concat(chunks).toString("latin1") });
			if (req.url === "/v1/edit") {
				return send(200, {
					format: "docx",
					engine: "mock-documents/1",
					operations: [{ index: 0, op: "replace_text", result: { replaced: 1 } }],
					diff: ["word/document.xml:", "- Dear Acme", "+ Dear Beta"],
					verify: { ok: true, parts: 12, byte_identical: 11, changed: ["word/document.xml"] },
					passed_through: [],
					file_name: "contract.docx",
					content_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
					file_bytes: MOCK_EDITED_DOCX.byteLength,
					file_base64: MOCK_EDITED_DOCX.toString("base64"),
				});
			}
			if (req.url === "/v1/create") {
				return send(200, {
					format: "docx",
					engine: "mock-documents/1",
					outline: {
						blocks: [
							{ id: "p1", type: "heading", level: 1, text: "Sales" },
							{ id: "t1", type: "table", rows: 3, cols: 2 },
						],
						images: 1,
					},
					verify: { ok: true, parts: 18, reopened_with: "python-docx" },
					charts: [
						{ type: "column", title: "Units", series: 1, requested: "native", render: "native" },
					],
					notes: [],
					styled_from: "built-in",
					file_name: "sales.docx",
					content_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
					file_bytes: MOCK_CREATED_DOCX.byteLength,
					file_base64: MOCK_CREATED_DOCX.toString("base64"),
				});
			}
			send(404, { error: { code: "not_found", message: req.url } });
		});
	});
	return { server, calls };
}

// Run directly by the Playwright `webServer` entry.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	const { server } = createMockDocuments();
	server.listen(MOCK_DOCUMENTS_PORT, "127.0.0.1", () => {
		const { port } = server.address() as AddressInfo;
		console.log(`mock documents listening on ${port}`);
	});
}
