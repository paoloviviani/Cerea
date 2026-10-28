/**
 * `doc_create` and `doc_create_from_template` (ADR 0103 step 3): gating by the
 * service's capability flags, the tool text generated from its schemas, files
 * stored as new deliverables with a file card, and the service's errors turned
 * into messages a model can act on. The service is a fake HTTP server.
 */
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
}));
vi.mock("$lib/server/database", () => ({
	collections: {
		conversations: { findOne: vi.fn(async () => db.conversation) },
		users: { findOne: vi.fn(async () => null) },
		codeExecutionOutputs: {
			updateOne: vi.fn(async () => ({})),
			find: (query: { name: string }) => ({
				sort: () => ({
					limit: () => ({
						next: async () => db.outputs.find((row) => row.name === query.name) ?? null,
					}),
					toArray: async () => db.outputs.filter((row) => row.name === query.name),
				}),
			}),
			countDocuments: vi.fn(
				async (query: { name: string }) => db.outputs.filter((r) => r.name === query.name).length
			),
		},
	},
}));

const stored = vi.hoisted(() => ({
	attachments: new Map<string, Buffer>(),
	outputs: new Map<string, Buffer>(),
	saved: [] as Array<{
		name: string;
		mime: string;
		bytes: Buffer;
		derivedFrom?: { sha256: string; name: string };
	}>,
	fail: undefined as string | undefined,
}));
vi.mock("$lib/server/files/downloadFile", () => ({
	downloadFile: vi.fn(async (sha: string, conv: { toString(): string } | string) => {
		const bytes = stored.attachments.get(`${conv.toString()}:${sha}`);
		if (!bytes) throw new Error("403");
		return { type: "base64", name: sha, value: bytes.toString("base64"), mime: "x" };
	}),
}));
vi.mock("$lib/server/execution/deliverables", () => ({
	markCurrentVersion: vi.fn(async () => undefined),
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
			if (stored.fail) return { ok: false, status: 413, error: stored.fail };
			stored.saved.push(input);
			db.outputs.push({ name: input.name, sha256: "c".repeat(64), createdAt: new Date() });
			return {
				ok: true,
				ref: { name: input.name, size: input.bytes.byteLength, sha256: "c".repeat(64) },
			};
		}
	),
}));

const {
	createDocumentBuiltins,
	createdName,
	DOC_CREATE_TOOL_NAME,
	DOC_CREATE_FROM_TEMPLATE_TOOL_NAME,
} = await import("./documentTools");
const { DOC_EDIT_TOOL_NAME, getEnabledBuiltinTools } = await import("./index");
const { getCapabilities, resetCapabilitiesCache } = await import("$lib/server/documents/client");
const { MessageCodeExecutionUpdateType, MessageUpdateType } =
	await import("$lib/types/MessageUpdate");
import fixture from "$lib/server/documents/capabilities.fixture.json";

const SECRET = "s3cret";
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const MADE = Buffer.from("PK a created docx");

let server: http.Server;
let requests: Array<{ path: string; headers: http.IncomingHttpHeaders; body: string }> = [];
let capabilities: unknown = fixture;
let reply: { status: number; body: unknown } | undefined;

const created = (extra: Record<string, unknown> = {}) => ({
	format: "docx",
	engine: "cerea-documents/test",
	outline: { blocks: [{ id: "p1", type: "heading", level: 1, text: "Report" }], images: 1 },
	verify: { ok: true, parts: 14, reopened_with: "python-docx" },
	charts: [{ type: "column", title: "Sales", series: 2, requested: "native", render: "native" }],
	styled_from: "built-in",
	file_name: "report.docx",
	content_type: DOCX_MIME,
	file_bytes: MADE.byteLength,
	file_base64: MADE.toString("base64"),
	...extra,
});

beforeAll(async () => {
	server = http.createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (c) => chunks.push(c));
		req.on("end", () => {
			requests.push({
				path: req.url ?? "",
				headers: req.headers,
				body: Buffer.concat(chunks).toString("latin1"),
			});
			const json = (code: number, value: unknown) => {
				res.writeHead(code, { "Content-Type": "application/json" });
				res.end(JSON.stringify(value));
			};
			if (req.headers["x-cerea-documents-secret"] !== SECRET) return json(401, { error: {} });
			if (req.url === "/v1/capabilities") return json(200, capabilities);
			if (req.url === "/v1/create" || req.url === "/v1/create_from_template") {
				if (reply) return json(reply.status, reply.body);
				return json(
					200,
					req.url === "/v1/create"
						? created()
						: created({
								filled: ["client"],
								unfilled: ["spare"],
								diff: ["word/document.xml:", "- Dear {{client}}", "+ Dear Beta"],
								styled_from: "template",
							})
				);
			}
			json(404, {});
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const conversationId = new ObjectId();
const ctx = () => ({ uuid: "u-1", toolCallId: "t-1", conversationId, userId: new ObjectId() });
const attachment = (name: string, value: string) => ({
	type: "hash" as const,
	name,
	value,
	mime: "application/octet-stream",
});

beforeEach(() => {
	requests = [];
	capabilities = fixture;
	reply = undefined;
	stored.attachments.clear();
	stored.outputs.clear();
	stored.saved = [];
	stored.fail = undefined;
	db.outputs = [];
	db.conversation = {
		messages: [
			{
				files: [
					attachment("logo.png", "sha-logo"),
					attachment("brand.docx", "sha-brand"),
					attachment("invoice.docx", "sha-invoice"),
				],
			},
		],
	};
	stored.attachments.set(`${conversationId}:sha-logo`, Buffer.from("PNG logo bytes"));
	stored.attachments.set(`${conversationId}:sha-brand`, Buffer.from("PK brand template"));
	stored.attachments.set(`${conversationId}:sha-invoice`, Buffer.from("PK invoice template"));
	config.CHAT_DOCUMENTS_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	config.CHAT_DOCUMENTS_SECRET = SECRET;
	resetCapabilitiesCache();
});
afterEach(() => {
	delete config.CHAT_DOCUMENTS_URL;
	delete config.CHAT_DOCUMENTS_SECRET;
});

const named = async (name: string) => {
	const tool = createDocumentBuiltins(await getCapabilities()).find((t) => t.name === name);
	if (!tool) throw new Error(`${name} is not offered`);
	return tool;
};
const ok = (r: unknown) => {
	if (!r || typeof r !== "object" || !("resultText" in r))
		throw new Error(`expected a result: ${JSON.stringify(r)}`);
	return r as { resultText: string; extraUpdates?: Array<Record<string, unknown>> };
};
const failed = (r: unknown) => {
	if (!r || typeof r !== "object" || !("error" in r))
		throw new Error(`expected an error: ${JSON.stringify(r)}`);
	return (r as { error: string }).error;
};
const SPEC = { title: "Q3 report", blocks: [{ type: "heading", level: 1, text: "Report" }] };

describe("gating by the service's capability flags", () => {
	it("offers neither tool when the service does not say it can create", async () => {
		const old = {
			...(fixture as Record<string, unknown>),
			create: false,
			create_from_template: false,
		};
		capabilities = old;
		const names = createDocumentBuiltins(await getCapabilities()).map((t) => t.name);
		expect(names).not.toContain(DOC_CREATE_TOOL_NAME);
		expect(names).not.toContain(DOC_CREATE_FROM_TEMPLATE_TOOL_NAME);
		expect(names).toContain(DOC_EDIT_TOOL_NAME);
	});

	it("offers each tool on its own flag", async () => {
		capabilities = { ...(fixture as object), create_from_template: false };
		expect(createDocumentBuiltins(await getCapabilities()).map((t) => t.name)).toEqual(
			expect.arrayContaining([DOC_CREATE_TOOL_NAME])
		);
		expect(createDocumentBuiltins(await getCapabilities()).map((t) => t.name)).not.toContain(
			DOC_CREATE_FROM_TEMPLATE_TOOL_NAME
		);
		resetCapabilitiesCache();
		capabilities = { ...(fixture as object), create: false };
		const names = createDocumentBuiltins(await getCapabilities()).map((t) => t.name);
		expect(names).toContain(DOC_CREATE_FROM_TEMPLATE_TOOL_NAME);
		expect(names).not.toContain(DOC_CREATE_TOOL_NAME);
	});

	it("offers neither without the service, and both through getEnabledBuiltinTools with it", async () => {
		delete config.CHAT_DOCUMENTS_URL;
		expect(createDocumentBuiltins(await getCapabilities())).toEqual([]);
		config.CHAT_DOCUMENTS_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
		resetCapabilitiesCache();
		const names = getEnabledBuiltinTools({
			conv: { _id: conversationId },
			documentCapabilities: await getCapabilities(),
		}).map((t) => t.name);
		expect(names).toEqual(
			expect.arrayContaining([DOC_CREATE_TOOL_NAME, DOC_CREATE_FROM_TEMPLATE_TOOL_NAME])
		);
	});

	it("offers only the formats the service lists", async () => {
		capabilities = { ...(fixture as object), create_formats: ["docx", "pdf"] };
		const tool = await named(DOC_CREATE_TOOL_NAME);
		const props = tool.definition.function.parameters as {
			properties: { format: { enum: string[] } };
		};
		expect(props.properties.format.enum).toEqual(["docx", "pdf"]);
		expect(tool.definition.function.description).toContain("PDF (.pdf): the same spec");
		expect(tool.definition.function.description).not.toContain("Excel (.xlsx) spec");
	});

	it("gives the shared guidance once, not once per tool", async () => {
		const tools = createDocumentBuiltins(await getCapabilities());
		const withText = tools.filter((t) => t.preprompt?.includes("doc_create"));
		expect(withText).toHaveLength(1);
		expect(withText[0].name).toBe(DOC_CREATE_TOOL_NAME);
	});
});

describe("the tool text comes from the service's schemas", () => {
	it("names the blocks, the theme and the chart choices", async () => {
		const text = (await named(DOC_CREATE_TOOL_NAME)).definition.function.description ?? "";
		expect(text).toContain("heading{level: integer");
		expect(text).toContain("table{");
		expect(text).toContain('render?: "native"|"image"');
		expect(text).toContain(
			'chart_type: "bar"|"column"|"stacked"|"line"|"area"|"pie"|"doughnut"|"scatter"'
		);
		expect(text).toContain("Theme = {");
		expect(text).toContain('"Calibri"');
		expect(text).toContain("template?: string");
		expect(text).toContain("A sheet: {");
		expect(text).toContain("A slide: {");
		expect(text).toContain("item = string | {");
		expect(text).toContain("Run = {");
		expect(text).toContain("Hex = ");
		expect(text).toContain("Background = {color: Hex} | {");
		expect(text).toMatch(
			/PptxTheme = Theme plus \{[^}]*slide_background\?: Background[^}]*slide_numbers\?: boolean/
		);
		expect(text).toContain("heading_bold?: boolean");
		expect(text).toContain("h1 is also the PowerPoint title size");
		expect(text).toContain("background?: Background");
		expect(text).toMatch(
			/shapes\?: \{[^]*kind: "rect"\|"rounded_rect"[^]*layer\?: "back"\|"front"/
		);
		// the deck-only theme setting is written once, in the PptxTheme legend line
		expect(text.split("slide_background")).toHaveLength(2);
		expect(text).toContain("Cell = ");
		// the same pieces are written once, not per block and format
		expect(text.split("Run = {")).toHaveLength(2);
		expect(text).toContain("PDF (.pdf): the same spec and blocks as Word (.docx)");
		expect(text.length).toBeLessThan(9_500);
		expect(text).not.toMatch(/deployment template|admin/i);
	});

	it("follows the service: a new block appears without a code change", async () => {
		const modified = JSON.parse(JSON.stringify(fixture));
		modified.create_schemas.docx.blocks.callout = {
			type: "object",
			properties: {
				type: { const: "callout" },
				text: { type: "string" },
				tone: { enum: ["info", "warn"] },
			},
			required: ["type", "text"],
		};
		capabilities = modified;
		const text = (await named(DOC_CREATE_TOOL_NAME)).definition.function.description ?? "";
		expect(text).toContain('callout{text: string, tone?: "info"|"warn"}');
	});
});

describe("doc_create", () => {
	it("sends the spec and saves the file as a new deliverable with a file card", async () => {
		const out = ok(
			await (
				await named(DOC_CREATE_TOOL_NAME)
			).execute({ format: "docx", spec: SPEC, file_name: "q3 report" }, ctx())
		);
		const call = requests.find((r) => r.path === "/v1/create");
		expect(call?.headers["x-cerea-documents-secret"]).toBe(SECRET);
		expect(call?.headers.accept).toBe("application/json");
		expect(call?.body).toContain('"format":"docx"');
		expect(call?.body).toContain('"Q3 report"');

		expect(stored.saved).toHaveLength(1);
		expect(stored.saved[0]).toMatchObject({ name: "q3 report.docx", mime: DOCX_MIME });
		expect(stored.saved[0].bytes.equals(MADE)).toBe(true);
		expect(stored.saved[0].derivedFrom).toBeUndefined();

		const body = JSON.parse(out.resultText);
		expect(body).toMatchObject({
			saved: true,
			file: "q3 report.docx",
			version: 1,
			format: "docx",
			styled_from: "built-in",
			verify: { ok: true, reopened_with: "python-docx" },
		});
		expect(body.outline.blocks[0].text).toBe("Report");
		expect(body.charts[0]).toMatchObject({ requested: "native", render: "native" });
		expect(body.note).toContain("doc_edit");
		expect(out.extraUpdates).toEqual([
			expect.objectContaining({
				type: MessageUpdateType.CodeExecution,
				subtype: MessageCodeExecutionUpdateType.Outputs,
				files: [expect.objectContaining({ name: "q3 report.docx" })],
			}),
		]);
	});

	it("names the file from the title when no name is given, with the right extension", async () => {
		await (await named(DOC_CREATE_TOOL_NAME)).execute({ format: "docx", spec: SPEC }, ctx());
		expect(stored.saved[0].name).toBe("Q3 report.docx");
		expect(createdName("../../etc/passwd.exe", "t", "docx")).toBe("passwd.docx");
		expect(createdName("a/b\\c:d.pdf", "t", "pdf")).toBe("c-d.pdf");
		expect(createdName("", "", "xlsx")).toBe("document.xlsx");
		expect(createdName("  ", undefined, "pptx")).toBe("document.pptx");
		expect(createdName("x\u0000y.docx", "", "docx")).toBe("xy.docx");
		expect(createdName("/mnt/output/plan.xlsx", "", "xlsx")).toBe("plan.xlsx");
	});

	it("passes images by name and sends their bytes", async () => {
		await (
			await named(DOC_CREATE_TOOL_NAME)
		).execute({ format: "docx", spec: SPEC, images: ["/mnt/data/logo.png"] }, ctx());
		const call = requests.find((r) => r.path === "/v1/create");
		expect(call?.body).toContain('filename="logo.png"');
		expect(call?.body).toContain("PNG logo bytes");
	});

	it("takes the styles of an uploaded template and records where the file came from", async () => {
		const spec = { ...SPEC, theme: { template: "/mnt/data/brand.docx", accent: "00AA55" } };
		await (await named(DOC_CREATE_TOOL_NAME)).execute({ format: "docx", spec }, ctx());
		const call = requests.find((r) => r.path === "/v1/create");
		expect(call?.body).toContain('name="file"; filename="brand.docx"');
		expect(call?.body).toContain("PK brand template");
		expect(call?.body).toContain('"template":"brand.docx"'); // the name, not the sandbox path
		expect(stored.saved[0].derivedFrom).toEqual({ sha256: "sha-brand", name: "brand.docx" });
	});

	it("saves a second file under the same name as the next version", async () => {
		const tool = await named(DOC_CREATE_TOOL_NAME);
		db.outputs.push({ name: "Q3 report.docx", sha256: "d".repeat(64), createdAt: new Date() });
		const out = ok(await tool.execute({ format: "docx", spec: SPEC }, ctx()));
		expect(JSON.parse(out.resultText).version).toBe(2);
	});

	it("says what each chart became, and any fallback, in the result", async () => {
		reply = {
			status: 200,
			body: created({
				charts: [
					{
						type: "pie",
						requested: "native",
						render: "image",
						note: "native chart could not be written (X); embedded as an image instead",
					},
				],
				notes: ["style 'Quote' is not in the template; direct formatting was used"],
			}),
		};
		const body = JSON.parse(
			ok(await (await named(DOC_CREATE_TOOL_NAME)).execute({ format: "docx", spec: SPEC }, ctx()))
				.resultText
		);
		expect(body.charts[0].note).toContain("embedded as an image");
		expect(body.notes[0]).toContain("template");
	});

	it("refuses bad arguments before calling the service", async () => {
		const tool = await named(DOC_CREATE_TOOL_NAME);
		expect(failed(await tool.execute({ format: "rtf", spec: SPEC }, ctx()))).toContain(
			"one of: docx, xlsx, pptx, pdf"
		);
		expect(failed(await tool.execute({ format: "docx", spec: "text" }, ctx()))).toContain(
			"Give `spec`"
		);
		expect(failed(await tool.execute({ format: "docx", spec: [] }, ctx()))).toContain(
			"Give `spec`"
		);
		expect(
			failed(await tool.execute({ format: "docx", spec: SPEC, images: ["nope.png"] }, ctx()))
		).toContain("nope.png");
		expect(
			failed(
				await tool.execute(
					{ format: "docx", spec: { ...SPEC, theme: { template: "nope.docx" } } },
					ctx()
				)
			)
		).toContain("theme.template");
		expect(
			failed(
				await tool.execute({ format: "docx", spec: SPEC }, { ...ctx(), conversationId: undefined })
			)
		).toContain("no conversation");
		expect(requests.filter((r) => r.path === "/v1/create")).toHaveLength(0);
		expect(stored.saved).toHaveLength(0);
	});
});

describe("the service's errors become messages a model can act on", () => {
	const run = async () =>
		failed(
			await (
				await named(DOC_CREATE_TOOL_NAME)
			).execute({ format: "docx", spec: SPEC, images: [] }, ctx())
		);

	it("passes a 422's actionable message and details through and says no file was made", async () => {
		reply = {
			status: 422,
			body: {
				error: {
					code: "invalid_request",
					message: "blocks[1]: unknown block type 'banner'; available here: ['chart', 'code']",
					details: { available: ["chart", "code"] },
				},
			},
		};
		const error = await run();
		expect(error).toContain("unknown block type 'banner'");
		expect(error).toContain('"available":["chart","code"]');
		expect(error).toContain("No file was made.");
		expect(error).not.toContain("Nothing was changed");
		expect(stored.saved).toHaveLength(0);
	});

	it("hands the model a range error with the field, the value and the allowed range", async () => {
		reply = {
			status: 422,
			body: {
				error: {
					code: "invalid_request",
					reason: "schema",
					message:
						"slides[0].shapes.1.y_cm: -60 is less than the minimum (-50); allowed range -50 to 100",
				},
			},
		};
		const error = await run();
		expect(error).toContain("shapes.1.y_cm: -60");
		expect(error).toContain("allowed range -50 to 100");
		expect(error).toContain("No file was made.");
		expect(error).not.toContain("Details:");
	});

	it("maps too large, unsupported, timeout and a failing service", async () => {
		reply = { status: 413, body: { error: { message: "the request is larger than 64 MiB" } } };
		expect(await run()).toMatch(/too large/);
		reply = {
			status: 415,
			body: { error: { message: "the template is a pptx file but a docx was asked for" } },
		};
		expect(await run()).toContain("the template is a pptx file");
		reply = { status: 504, body: { error: { code: "time_limit" } } };
		const timeout = await run();
		expect(timeout).toMatch(/took too long/);
		expect(timeout).toContain("No file was made.");
		expect(timeout).toMatch(/fewer charts/);
		reply = { status: 500, body: { error: { code: "internal_error", message: "boom" } } };
		expect(await run()).toContain("HTTP 500");
		reply = { status: 401, body: { error: {} } };
		expect(await run()).toMatch(/shared secret/);
	});

	it("reports an unreachable service", async () => {
		const tool = await named(DOC_CREATE_TOOL_NAME);
		config.CHAT_DOCUMENTS_URL = "http://127.0.0.1:1";
		expect(failed(await tool.execute({ format: "docx", spec: SPEC }, ctx()))).toMatch(
			/not reachable/
		);
	});

	it("passes a full conversation store's refusal on", async () => {
		stored.fail = "This conversation has reached its stored deliverable size limit.";
		expect(await run()).toContain("size limit");
	});
});

describe("doc_create_from_template", () => {
	const VALUES = { client: "Beta plc", logo: { image: "logo.png" } };

	it("fills the uploaded template and saves a new file next to it", async () => {
		const out = ok(
			await (
				await named(DOC_CREATE_FROM_TEMPLATE_TOOL_NAME)
			).execute({ template: "/mnt/data/invoice.docx", values: VALUES, images: ["logo.png"] }, ctx())
		);
		const call = requests.find((r) => r.path === "/v1/create_from_template");
		expect(call?.body).toContain('name="file"; filename="invoice.docx"');
		expect(call?.body).toContain("PK invoice template");
		expect(call?.body).toContain('"client":"Beta plc"');
		expect(call?.body).toContain("PNG logo bytes");
		expect(stored.saved[0].name).toBe("invoice-filled.docx");
		expect(stored.saved[0].derivedFrom).toEqual({ sha256: "sha-invoice", name: "invoice.docx" });
		const body = JSON.parse(out.resultText);
		expect(body).toMatchObject({
			saved: true,
			file: "invoice-filled.docx",
			filled: ["client"],
			unfilled: ["spare"],
		});
		expect(body.unfilled_note).toContain("remain in the file");
		expect(body.diff).toContain("+ Dear Beta");
		expect(out.extraUpdates?.[0]).toMatchObject({ files: [{ name: "invoice-filled.docx" }] });
	});

	it("takes a chosen file name", async () => {
		await (
			await named(DOC_CREATE_FROM_TEMPLATE_TOOL_NAME)
		).execute(
			{ template: "invoice.docx", values: { client: "x" }, file_name: "invoice 17" },
			ctx()
		);
		expect(stored.saved[0].name).toBe("invoice 17.docx");
	});

	it("refuses missing arguments and unknown files without calling the service", async () => {
		const tool = await named(DOC_CREATE_FROM_TEMPLATE_TOOL_NAME);
		expect(failed(await tool.execute({ template: "invoice.docx" }, ctx()))).toContain(
			"Give `values`"
		);
		expect(failed(await tool.execute({ template: "invoice.docx", values: {} }, ctx()))).toContain(
			"empty"
		);
		expect(
			failed(await tool.execute({ template: "nope.docx", values: { a: 1 } }, ctx()))
		).toContain("nope.docx");
		expect(failed(await tool.execute({ values: { a: 1 } }, ctx()))).toContain("Give `file`");
		expect(requests.filter((r) => r.path === "/v1/create_from_template")).toHaveLength(0);
	});

	it("passes an unknown-placeholder refusal through", async () => {
		reply = {
			status: 422,
			body: {
				error: {
					message:
						"the template has no placeholder named ['nope']; it has: ['client']. Use exactly those names",
					details: { available: ["client"] },
				},
			},
		};
		const error = failed(
			await (
				await named(DOC_CREATE_FROM_TEMPLATE_TOOL_NAME)
			).execute({ template: "invoice.docx", values: { nope: 1 } }, ctx())
		);
		expect(error).toContain("no placeholder named ['nope']");
		expect(error).toContain("No file was made.");
		expect(stored.saved).toHaveLength(0);
	});
});
