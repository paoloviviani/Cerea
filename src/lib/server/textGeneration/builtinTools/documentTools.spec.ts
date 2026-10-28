import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { ObjectId } from "mongodb";

vi.mock("$lib/server/logger", () => ({
	logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
const config: Record<string, string> = {};
vi.mock("$lib/server/config", () => ({ config }));
vi.mock("$lib/server/fetching", () => ({ configuredBackend: () => "direct" }));

const db = vi.hoisted(() => ({
	conversation: undefined as { messages: unknown[] } | undefined,
	outputs: [] as Array<{ name: string; sha256: string; createdAt: Date; conversationId?: unknown }>,
	userName: "Ada Lovelace" as string | undefined,
}));
vi.mock("$lib/server/database", () => ({
	collections: {
		conversations: { findOne: vi.fn(async () => db.conversation) },
		users: { findOne: vi.fn(async () => (db.userName ? { name: db.userName } : null)) },
		codeExecutionOutputs: {
			find: (query: { name: string; conversationId?: unknown }) => ({
				sort: () => ({
					limit: () => ({
						// Like the real query: a missing filter matches every conversation's rows.
						next: async () =>
							db.outputs.find(
								(row) =>
									row.name === query.name &&
									(query.conversationId === undefined ||
										row.conversationId === undefined ||
										String(row.conversationId) === String(query.conversationId))
							) ?? null,
					}),
				}),
			}),
			countDocuments: vi.fn(
				async (query: { name: string }) => db.outputs.filter((r) => r.name === query.name).length
			),
		},
	},
}));

const stored = vi.hoisted(() => ({
	/** "<conversation>:<sha>" -> bytes: a file is readable only in the conversation that owns it. */
	attachments: new Map<string, Buffer>(),
	outputs: new Map<string, Buffer>(),
	saved: [] as Array<{
		name: string;
		mime: string;
		bytes: Buffer;
		derivedFrom?: { sha256: string; name: string };
	}>,
	nextSha: "e".repeat(64),
}));
vi.mock("$lib/server/files/downloadFile", () => ({
	downloadFile: vi.fn(async (sha: string, conv: { toString(): string } | string) => {
		const bytes = stored.attachments.get(`${conv.toString()}:${sha}`);
		if (!bytes) throw new Error("403");
		return { type: "base64", name: sha, value: bytes.toString("base64"), mime: "x" };
	}),
}));
vi.mock("$lib/server/execution/deliverables", () => ({
	downloadDeliverable: vi.fn(async (_id: unknown, sha: string) => {
		const buffer = stored.outputs.get(sha);
		return buffer ? { buffer, name: "n", mime: "m" } : undefined;
	}),
	storeDeliverable: vi.fn(
		async (input: {
			name: string;
			mime: string;
			bytes: Buffer;
			derivedFrom?: { sha256: string; name: string };
		}) => {
			stored.saved.push(input);
			db.outputs.push({ name: input.name, sha256: stored.nextSha, createdAt: new Date() });
			return {
				ok: true,
				ref: { name: input.name, size: input.bytes.byteLength, sha256: stored.nextSha },
			};
		}
	),
}));

const { createDocumentBuiltins, describeOperation, DOC_EDIT_TOOL_NAME, DOC_OUTLINE_TOOL_NAME } =
	await import("./documentTools");
const { DOC_READ_TOOL_NAME, getEnabledBuiltinTools } = await import("./index");
const { getCapabilities, resetCapabilitiesCache } = await import("$lib/server/documents/client");
const { MessageCodeExecutionUpdateType, MessageUpdateType } =
	await import("$lib/types/MessageUpdate");

const SECRET = "s3cret";
const EDITED = Buffer.from("PK edited docx");

const CAPS = {
	engine: "cerea-documents/test",
	formats: {
		docx: {
			outline: true,
			read: true,
			operations: ["replace_text", "set_table_cell"],
			operation_schemas: {
				replace_text: {
					type: "object",
					properties: {
						op: { type: "string" },
						find: { type: "string", minLength: 1 },
						replace: { type: "string" },
						match_case: { type: "boolean" },
					},
					required: ["op", "find", "replace"],
				},
				set_table_cell: {
					type: "object",
					properties: {
						op: { type: "string" },
						table: { type: "string" },
						row: { type: "integer" },
						column: { type: "integer" },
						text: { type: "string" },
					},
					required: ["op", "table", "row", "column", "text"],
				},
			},
			track_changes: true,
		},
		xlsx: { outline: true, read: true, operations: ["set_cells"], track_changes: false },
		pdf: {
			outline: true,
			read: false,
			operations: ["fill_form"],
			operation_schemas: {
				fill_form: {
					type: "object",
					properties: {
						op: { type: "string" },
						values: { type: "object" },
						flatten: { type: "boolean" },
					},
					required: ["op", "values"],
				},
			},
			track_changes: false,
		},
	},
};

let server: http.Server;
let requests: Array<{
	method: string;
	path: string;
	headers: http.IncomingHttpHeaders;
	body: string;
}> = [];
let capabilities: unknown = CAPS;
let editStatus = 200;
let editBody: unknown;
/** Fields that replace parts of the service's edit answer (a PDF answer, for example). */
let editOverride: Record<string, unknown> | undefined;

beforeAll(async () => {
	server = http.createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (c) => chunks.push(c));
		req.on("end", () => {
			requests.push({
				method: req.method ?? "",
				path: req.url ?? "",
				headers: req.headers,
				body: Buffer.concat(chunks).toString("latin1"),
			});
			const json = (code: number, value: unknown) => {
				res.writeHead(code, { "Content-Type": "application/json" });
				res.end(JSON.stringify(value));
			};
			if (req.headers["x-cerea-documents-secret"] !== SECRET) {
				return json(401, { error: { code: "unauthorized", message: "no" } });
			}
			if (req.url === "/v1/capabilities") return json(200, capabilities);
			if (req.url === "/v1/outline") return json(200, { format: "docx", blocks: [{ id: "p1" }] });
			if (req.url === "/v1/read") return json(200, { p1: { text: "Dear Acme" } });
			if (req.url === "/v1/edit") {
				if (editStatus !== 200) return json(editStatus, editBody);
				return json(200, {
					...{
						format: "docx",
						engine: "cerea-documents/test",
						operations: [{ index: 0, op: "replace_text", result: { replaced: 1 } }],
						diff: ["word/document.xml:", "- Dear Acme", "+ Dear Beta"],
						verify: { ok: true, parts: 20, byte_identical: 19, changed: ["word/document.xml"] },
						passed_through: [],
						file_name: "report.docx",
						content_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
						file_bytes: EDITED.byteLength,
						file_base64: EDITED.toString("base64"),
					},
					...editOverride,
				});
			}
			json(404, {});
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const conversationId = new ObjectId();
const ctx = (extra: Record<string, unknown> = {}) => ({
	uuid: "u-1",
	toolCallId: "t-1",
	conversationId,
	userId: new ObjectId(),
	...extra,
});
const attachment = (name: string, value: string) => ({
	type: "hash" as const,
	name,
	value,
	mime: "application/octet-stream",
});

beforeEach(() => {
	requests = [];
	capabilities = CAPS;
	editStatus = 200;
	editBody = undefined;
	editOverride = undefined;
	stored.attachments.clear();
	stored.outputs.clear();
	stored.saved = [];
	stored.nextSha = "e".repeat(64);
	db.outputs = [];
	db.userName = "Ada Lovelace";
	db.conversation = { messages: [{ files: [attachment("report.docx", "sha-r")] }] };
	stored.attachments.set(`${conversationId}:sha-r`, Buffer.from("PK original docx"));
	config.CHAT_DOCUMENTS_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	config.CHAT_DOCUMENTS_SECRET = SECRET;
	resetCapabilitiesCache();
});
afterEach(() => {
	delete config.CHAT_DOCUMENTS_URL;
	delete config.CHAT_DOCUMENTS_SECRET;
});

const tools = async () => createDocumentBuiltins(await getCapabilities());
const named = async (name: string) => {
	const tool = (await tools()).find((t) => t.name === name);
	if (!tool) throw new Error(`${name} is not offered`);
	return tool;
};
const result = (r: unknown) => {
	if (!r || typeof r !== "object" || !("resultText" in r))
		throw new Error(`expected a result: ${JSON.stringify(r)}`);
	return r as { resultText: string; extraUpdates?: unknown[] };
};

describe("gating", () => {
	it("offers nothing when the service is not configured", async () => {
		delete config.CHAT_DOCUMENTS_URL;
		expect(await getCapabilities()).toBeNull();
		expect(createDocumentBuiltins(null)).toEqual([]);
		expect(requests).toHaveLength(0);
		const names = getEnabledBuiltinTools({ conv: { _id: conversationId } }).map((t) => t.name);
		expect(names.filter((n) => n.startsWith("doc_"))).toEqual([]);
	});

	it("offers nothing with a URL but no secret, or with a service that does not answer", async () => {
		delete config.CHAT_DOCUMENTS_SECRET;
		expect(await getCapabilities()).toBeNull();
		config.CHAT_DOCUMENTS_SECRET = SECRET;
		config.CHAT_DOCUMENTS_URL = "http://127.0.0.1:1";
		resetCapabilitiesCache();
		expect(await getCapabilities()).toBeNull();
	});

	it("offers the three tools through getEnabledBuiltinTools when the service answers", async () => {
		const names = getEnabledBuiltinTools({
			conv: { _id: conversationId },
			documentCapabilities: await getCapabilities(),
		}).map((t) => t.name);
		expect(names).toEqual(
			expect.arrayContaining([DOC_OUTLINE_TOOL_NAME, DOC_READ_TOOL_NAME, DOC_EDIT_TOOL_NAME])
		);
	});

	it("offers only the operations the service lists, described from its schemas", async () => {
		const edit = await named(DOC_EDIT_TOOL_NAME);
		const text = JSON.stringify(edit.definition);
		expect(text).toContain("replace_text{find: string, replace: string, match_case?: boolean}");
		expect(text).toContain("set_table_cell{table: string, row: integer");
		expect(text).toContain("set_cells");
		expect(text).not.toContain("add_table_row");
		expect(text).not.toContain("duplicate_slide");
		const ops = edit.definition.function.parameters as {
			properties: { operations: { items: { properties: { op: { enum: string[] } } } } };
		};
		expect(ops.properties.operations.items.properties.op.enum).toEqual([
			"replace_text",
			"set_table_cell",
			"set_cells",
			"fill_form",
		]);
	});

	it("drops doc_edit when the service lists no operation, and track_changes when no format has it", async () => {
		capabilities = {
			formats: { docx: { outline: true, read: true, operations: [] } },
		};
		resetCapabilitiesCache();
		const names = (await tools()).map((t) => t.name);
		expect(names).toEqual([DOC_OUTLINE_TOOL_NAME, DOC_READ_TOOL_NAME]);

		capabilities = { formats: { xlsx: { outline: true, read: true, operations: ["set_cells"] } } };
		resetCapabilitiesCache();
		const edit = await named(DOC_EDIT_TOOL_NAME);
		expect(JSON.stringify(edit.definition)).not.toContain("track_changes");
	});

	it("caches the capabilities for a short while", async () => {
		await getCapabilities();
		await getCapabilities();
		expect(requests.filter((r) => r.path === "/v1/capabilities")).toHaveLength(1);
	});

	it("describes an operation from its schema, with ? on optional properties", () => {
		expect(describeOperation("x", CAPS.formats.docx.operation_schemas.replace_text)).toBe(
			"x{find: string, replace: string, match_case?: boolean}"
		);
		expect(describeOperation("bare", undefined)).toBe("bare");
	});
});

describe("doc_outline and doc_read", () => {
	it("sends the attachment's bytes with the secret and returns the service's JSON", async () => {
		const out = result(
			await (await named(DOC_OUTLINE_TOOL_NAME)).execute({ file: "/mnt/data/report.docx" }, ctx())
		);
		expect(JSON.parse(out.resultText)).toEqual({ format: "docx", blocks: [{ id: "p1" }] });
		const call = requests.find((r) => r.path === "/v1/outline");
		expect(call?.headers["x-cerea-documents-secret"]).toBe(SECRET);
		expect(call?.body).toContain('filename="report.docx"');
		expect(call?.body).toContain("PK original docx");
	});

	it("reads targets", async () => {
		const out = result(
			await (
				await named(DOC_READ_TOOL_NAME)
			).execute({ file: "report.docx", targets: ["p1"] }, ctx())
		);
		expect(JSON.parse(out.resultText)).toEqual({ p1: { text: "Dear Acme" } });
		expect(requests.find((r) => r.path === "/v1/read")?.body).toContain('"targets":["p1"]');
		expect(
			await (await named(DOC_READ_TOOL_NAME)).execute({ file: "report.docx", targets: [] }, ctx())
		).toMatchObject({
			error: expect.stringContaining("targets"),
		});
	});
});

describe("file access", () => {
	it("refuses a file that is not in the conversation, without calling the service", async () => {
		const out = await (
			await named(DOC_EDIT_TOOL_NAME)
		).execute(
			{ file: "secret.docx", operations: [{ op: "replace_text", find: "a", replace: "b" }] },
			ctx()
		);
		expect(out).toMatchObject({ error: expect.stringContaining('No file named "secret.docx"') });
		expect(requests.filter((r) => r.path === "/v1/edit")).toHaveLength(0);
	});

	it("never hands over another conversation's file, even when its hash is named here", async () => {
		// The attachment is listed on this conversation but stored under somebody else's.
		stored.attachments.clear();
		stored.attachments.set(`${new ObjectId()}:sha-r`, Buffer.from("PK somebody else's"));
		const out = await (await named(DOC_OUTLINE_TOOL_NAME)).execute({ file: "report.docx" }, ctx());
		expect(out).toMatchObject({ error: expect.stringContaining("No file named") });
		expect(requests.filter((r) => r.path === "/v1/outline")).toHaveLength(0);
	});

	it("never finds a produced file of another conversation by its name", async () => {
		db.outputs = [
			{
				name: "theirs.docx",
				sha256: "s-theirs",
				createdAt: new Date(),
				conversationId: new ObjectId(),
			},
		];
		stored.outputs.set("s-theirs", Buffer.from("PK their produced file"));
		const out = await (await named(DOC_OUTLINE_TOOL_NAME)).execute({ file: "theirs.docx" }, ctx());
		expect(out).toMatchObject({ error: expect.stringContaining('No file named "theirs.docx"') });
		expect(requests.filter((r) => r.path === "/v1/outline")).toHaveLength(0);
	});

	it("refuses a call with no conversation", async () => {
		const out = await (
			await named(DOC_OUTLINE_TOOL_NAME)
		).execute({ file: "report.docx" }, ctx({ conversationId: undefined }));
		expect(out).toMatchObject({ error: expect.stringContaining("no conversation") });
	});
});

describe("doc_edit versioning", () => {
	const ops = [{ op: "replace_text", find: "Acme", replace: "Beta" }];

	it("stores the edit as a new file under the source's name, linked to it, and lists it for the person", async () => {
		const out = result(
			await (
				await named(DOC_EDIT_TOOL_NAME)
			).execute({ file: "report.docx", operations: ops }, ctx())
		);

		expect(stored.saved).toHaveLength(1);
		expect(stored.saved[0]).toMatchObject({
			name: "report.docx",
			mime: expect.stringContaining("wordprocessingml"),
			derivedFrom: { sha256: "sha-r", name: "report.docx" },
		});
		expect(stored.saved[0].bytes.equals(EDITED)).toBe(true);
		// The original attachment is untouched: only a deliverable was stored.
		expect(stored.attachments.get(`${conversationId}:sha-r`)?.toString()).toBe("PK original docx");

		const body = JSON.parse(out.resultText);
		expect(body).toMatchObject({
			saved: true,
			file: "report.docx",
			version: 1,
			diff: ["word/document.xml:", "- Dear Acme", "+ Dear Beta"],
			verify: { ok: true, parts: 20, byte_identical: 19, changed: ["word/document.xml"] },
		});
		expect(out.extraUpdates).toEqual([
			{
				type: MessageUpdateType.CodeExecution,
				subtype: MessageCodeExecutionUpdateType.Outputs,
				runKey: expect.stringMatching(/^doc_edit:/),
				files: [{ name: "report.docx", size: EDITED.byteLength, sha256: "e".repeat(64) }],
			},
		]);
	});

	it("remembers the slides a deck edit touched for look_doc, and forgets them when a later edit reports none", async () => {
		const turn = { touchedSlides: new Map<string, number[]>() };
		const edit = createDocumentBuiltins(CAPS as never, turn).find(
			(tool) => tool.name === DOC_EDIT_TOOL_NAME
		);
		if (!edit) throw new Error("doc_edit is not offered");
		editOverride = {
			format: "pptx",
			operations: [{ index: 0, op: "set_notes", result: { slide: 4 } }],
		};
		await edit.execute({ file: "report.docx", operations: ops }, ctx());
		expect(turn.touchedSlides.get("report.docx")).toEqual([4]);

		// a replace_text or reorder reports no slide: the old numbers may mean other slides now
		editOverride = {
			format: "pptx",
			operations: [{ index: 0, op: "replace_text", result: { replaced: 2 } }],
		};
		stored.nextSha = "c".repeat(64);
		await edit.execute({ file: "report.docx", operations: ops }, ctx());
		expect(turn.touchedSlides.has("report.docx")).toBe(false);
	});

	it("edits the newest produced version next, so edits chain", async () => {
		await (
			await named(DOC_EDIT_TOOL_NAME)
		).execute({ file: "report.docx", operations: ops }, ctx());
		stored.outputs.set("e".repeat(64), EDITED);
		stored.nextSha = "d".repeat(64);
		const out = result(
			await (
				await named(DOC_EDIT_TOOL_NAME)
			).execute({ file: "report.docx", operations: ops }, ctx())
		);
		const second = requests.filter((r) => r.path === "/v1/edit")[1];
		expect(second.body).toContain("PK edited docx");
		expect(stored.saved[1].derivedFrom).toMatchObject({ sha256: "e".repeat(64) });
		expect(JSON.parse(out.resultText)).toMatchObject({ version: 2 });
	});

	it("says so when the edit changed nothing", async () => {
		stored.nextSha = "sha-r";
		const out = result(
			await (
				await named(DOC_EDIT_TOOL_NAME)
			).execute({ file: "report.docx", operations: ops }, ctx())
		);
		expect(JSON.parse(out.resultText)).toMatchObject({ saved: false });
		expect(out.extraUpdates).toBeUndefined();
	});

	it("tracked changes default to the person's display name; an explicit author wins; off means none", async () => {
		const edit = await named(DOC_EDIT_TOOL_NAME);
		const sent = () =>
			JSON.parse(/name="body"\r\n\r\n(.*?)\r\n--/s.exec(requests.at(-1)?.body ?? "")?.[1] ?? "{}");
		await edit.execute({ file: "report.docx", operations: ops, track_changes: true }, ctx());
		expect(sent()).toMatchObject({ track_changes: true, author: "Ada Lovelace" });
		await edit.execute(
			{ file: "report.docx", operations: ops, track_changes: true, author: "Reviewer" },
			ctx()
		);
		expect(sent().author).toBe("Reviewer");
		await edit.execute({ file: "report.docx", operations: ops }, ctx());
		expect(sent()).not.toHaveProperty("track_changes");
	});

	it("sends images under the name the operation uses", async () => {
		db.conversation = {
			messages: [{ files: [attachment("report.docx", "sha-r"), attachment("logo.png", "sha-l")] }],
		};
		stored.attachments.set(`${conversationId}:sha-l`, Buffer.from("PNGDATA"));
		await (
			await named(DOC_EDIT_TOOL_NAME)
		).execute(
			{
				file: "report.docx",
				operations: [{ op: "replace_text", find: "a", replace: "b" }],
				images: ["/mnt/data/logo.png"],
			},
			ctx()
		);
		const body = requests.find((r) => r.path === "/v1/edit")?.body ?? "";
		expect(body).toContain('name="image"; filename="logo.png"');
		expect(body).toContain("PNGDATA");
	});

	it("rejects an operation outside the listed ones before any call", async () => {
		const out = await (
			await named(DOC_EDIT_TOOL_NAME)
		).execute({ file: "report.docx", operations: [{ op: "format_disk" }] }, ctx());
		expect(out).toMatchObject({
			error: expect.stringContaining("replace_text, set_table_cell, set_cells"),
		});
		expect(requests.filter((r) => r.path === "/v1/edit")).toHaveLength(0);
	});
});

describe("error mapping", () => {
	const ops = [{ op: "replace_text", find: "Acme", replace: "Beta" }];
	const fail = async (status: number, body: unknown) => {
		editStatus = status;
		editBody = body;
		const out = await (
			await named(DOC_EDIT_TOOL_NAME)
		).execute({ file: "report.docx", operations: ops }, ctx());
		expect(stored.saved).toHaveLength(0);
		if (!("error" in out)) throw new Error("expected an error");
		return out.error;
	};

	it("passes the actionable message of a 422 through and says nothing was changed", async () => {
		const error = await fail(422, {
			error: {
				code: "operation_failed",
				message: "operation 0 (replace_text): 'Acme' is not in the document; paragraphs: p1, p2",
			},
		});
		expect(error).toContain("'Acme' is not in the document; paragraphs: p1, p2");
		expect(error).toContain("Nothing was changed");
	});

	it("names the secret mismatch as an administrator problem on 401", async () => {
		config.CHAT_DOCUMENTS_SECRET = "wrong";
		resetCapabilitiesCache();
		capabilities = CAPS;
		const edit = createDocumentBuiltins(CAPS).find((t) => t.name === DOC_EDIT_TOOL_NAME);
		const out = await edit?.execute({ file: "report.docx", operations: ops }, ctx());
		expect(out).toMatchObject({ error: expect.stringContaining("administrator") });
	});

	it("explains 413 and 415", async () => {
		expect(await fail(413, { error: { code: "too_large", message: "limit 64 MiB" } })).toMatch(
			/too large.*limit 64 MiB/
		);
		expect(
			await fail(415, { error: { code: "unsupported_format", message: "this is a PDF" } })
		).toContain("cannot work on this file: this is a PDF");
	});

	it("tells the model plainly that a 504 timed out and nothing changed", async () => {
		const error = await fail(504, { error: { code: "time_limit", message: "killed" } });
		expect(error).toMatch(/took too long/);
		expect(error).toMatch(/nothing was changed/i);
	});

	it("reports an unreachable service", async () => {
		config.CHAT_DOCUMENTS_URL = "http://127.0.0.1:1";
		const edit = createDocumentBuiltins(CAPS).find((t) => t.name === DOC_EDIT_TOOL_NAME);
		const out = await edit?.execute({ file: "report.docx", operations: ops }, ctx());
		expect(out).toMatchObject({ error: expect.stringContaining("not reachable") });
	});
});

describe("loop protection", () => {
	it("stops a turn after its call budget", async () => {
		const outline = await named(DOC_OUTLINE_TOOL_NAME);
		let last: unknown;
		for (let i = 0; i < 31; i += 1) last = await outline.execute({ file: "report.docx" }, ctx());
		expect(last).toMatchObject({ error: expect.stringContaining("limit") });
	});
});

describe("PDF forms", () => {
	const pdfOps = [{ op: "fill_form", values: { full_name: "Ada", agree: true } }];
	const PDF = Buffer.from("%PDF-1.7 filled");

	beforeEach(() => {
		db.conversation = { messages: [{ files: [attachment("form.pdf", "sha-f")] }] };
		stored.attachments.set(`${conversationId}:sha-f`, Buffer.from("%PDF-1.7 original"));
	});

	it("describes fill_form from the service's schema and says a PDF has no other edit", async () => {
		const text = (await named(DOC_EDIT_TOOL_NAME)).definition.function.description ?? "";
		expect(text).toContain("PDF (.pdf): fill_form{values: object, flatten?: boolean}");
		expect(text).toMatch(/A PDF has one operation, fill_form, and no other edit/);
		expect(text).toMatch(/call doc_outline first for the field names and allowed values/);
		expect(text).toMatch(/A signed PDF \(filling would invalidate its signature\)/);
		expect(text).toMatch(/XFA\s+form cannot be filled|XFA form cannot be filled/);
		const outline = (await named(DOC_OUTLINE_TOOL_NAME)).definition.function.description ?? "";
		expect(outline).toMatch(/PDF's pages and, when it has a form, its fields/);
	});

	it("says nothing about PDF forms when the service lists no fill_form", async () => {
		capabilities = { formats: { docx: CAPS.formats.docx } };
		resetCapabilitiesCache();
		const text = (await named(DOC_EDIT_TOOL_NAME)).definition.function.description ?? "";
		expect(text).not.toMatch(/fill_form|A PDF has one operation/);
	});

	it("sends a PDF to the service under its name and saves the filled one as the next version", async () => {
		editOverride = {
			format: "pdf",
			operations: [
				{
					index: 0,
					op: "fill_form",
					result: { filled: [{ field: "full_name", value: "Ada" }], skipped: ["email"] },
				},
			],
			diff: ['full_name: "" -> "Ada"', 'agree: "Off" -> "Si"'],
			verify: {
				ok: false,
				pages: 3,
				fields_checked: 2,
				filled: 1,
				not_taken: [{ field: "agree", value: "Si", found: "Off" }],
				problems: ["field \"agree\": wanted 'Si', found 'Off'"],
				flattened: false,
				reopened_with: "pypdf",
			},
			file_name: "form.pdf",
			content_type: "application/pdf",
			file_base64: PDF.toString("base64"),
		};
		const out = result(
			await (
				await named(DOC_EDIT_TOOL_NAME)
			).execute({ file: "form.pdf", operations: pdfOps }, ctx())
		);
		const sent = requests.find((r) => r.path === "/v1/edit");
		expect(sent?.body).toContain('filename="form.pdf"');
		expect(sent?.body).toContain('"op":"fill_form"');
		expect(stored.saved[0]).toMatchObject({
			name: "form.pdf",
			mime: "application/pdf",
			derivedFrom: { sha256: "sha-f", name: "form.pdf" },
		});
		expect(stored.saved[0].bytes.equals(PDF)).toBe(true);
		const body = JSON.parse(out.resultText);
		expect(body).toMatchObject({ saved: true, file: "form.pdf", version: 1 });
		// a value that did not take reaches the model, which must not claim it was filled
		expect(body.verify).toMatchObject({
			ok: false,
			fields_checked: 2,
			filled: 1,
			not_taken: [{ field: "agree", found: "Off" }],
			flattened: false,
		});
		expect(body.diff).toEqual(['full_name: "" -> "Ada"', 'agree: "Off" -> "Si"']);
	});

	it("a refused value comes back as the service's message, naming the field and what it takes", async () => {
		editStatus = 422;
		editBody = {
			error: {
				code: "operation_failed",
				message:
					'operation 0 (fill_form): 1 value was not acceptable and nothing was written: field "colour" takes one of "red", "green", "blue", not "pink"',
				details: { nothing_written: true },
			},
		};
		const out = await (
			await named(DOC_EDIT_TOOL_NAME)
		).execute({ file: "form.pdf", operations: pdfOps }, ctx());
		expect(out).toMatchObject({
			error: expect.stringContaining('field "colour" takes one of "red", "green", "blue"'),
		});
		expect(stored.saved).toHaveLength(0);
	});

	it("outlines a PDF through the service", async () => {
		await (await named(DOC_OUTLINE_TOOL_NAME)).execute({ file: "/mnt/data/form.pdf" }, ctx());
		expect(requests.find((r) => r.path === "/v1/outline")?.body).toContain('filename="form.pdf"');
	});

	it("doc_read does not apply to a PDF and says what to use", async () => {
		const out = await (
			await named(DOC_READ_TOOL_NAME)
		).execute({ file: "form.pdf", targets: ["p1"] }, ctx());
		expect(out).toMatchObject({ error: expect.stringContaining("doc_outline lists its pages") });
		expect(requests.filter((r) => r.path === "/v1/read")).toHaveLength(0);
	});
});
