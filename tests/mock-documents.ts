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
