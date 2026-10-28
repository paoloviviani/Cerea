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
	outputs: [] as Array<{ name: string; sha256: string; createdAt: Date }>,
}));
vi.mock("$lib/server/database", () => ({
	collections: {
		conversations: { findOne: vi.fn(async () => db.conversation), updateOne: vi.fn() },
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
		},
	},
}));

const stored = vi.hoisted(() => ({
	attachments: new Map<string, Buffer>(),
	outputs: new Map<string, Buffer>(),
	saved: [] as Array<{ name: string; mime: string; bytes: Buffer }>,
	refuse: false,
}));
vi.mock("$lib/server/files/downloadFile", () => ({
	downloadFile: vi.fn(async (sha: string) => {
		const bytes = stored.attachments.get(sha);
		if (!bytes) throw new Error("404");
		return { type: "base64", name: sha, value: bytes.toString("base64"), mime: "x" };
	}),
}));
vi.mock("$lib/server/execution/deliverables", () => ({
	markCurrentVersion: vi.fn(async () => undefined),
	downloadDeliverable: vi.fn(async (_id: unknown, sha: string) => {
		const buffer = stored.outputs.get(sha);
		return buffer ? { buffer, name: "n", mime: "m" } : undefined;
	}),
	storeDeliverable: vi.fn(async (input: { name: string; mime: string; bytes: Buffer }) => {
		if (stored.refuse)
			return { ok: false, status: 413, error: "This conversation has reached its limit." };
		stored.saved.push(input);
		return {
			ok: true,
			ref: { name: input.name, size: input.bytes.byteLength, sha256: "f".repeat(64) },
		};
	}),
}));

const {
	createConvertDocumentBuiltin,
	CONVERT_DOCUMENT_TOOL_NAME,
	MAX_CONVERSIONS_PER_TURN,
	outputNameFor,
} = await import("./convertDocumentTool");
const { getEnabledBuiltinTools } = await import("./index");
const { MessageCodeExecutionUpdateType, MessageUpdateType } =
	await import("$lib/types/MessageUpdate");

const PDF = Buffer.from("%PDF-1.7\nconverted");
let server: http.Server;
let requests: Array<{ path: string; body: string }> = [];
let status = 200;

beforeAll(async () => {
	server = http.createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (c) => chunks.push(c));
		req.on("end", () => {
			requests.push({ path: req.url ?? "", body: Buffer.concat(chunks).toString("latin1") });
			res.writeHead(status, { "Content-Type": status === 200 ? "application/pdf" : "text/plain" });
			res.end(status === 200 ? PDF : "boom");
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
	status = 200;
	stored.attachments.clear();
	stored.outputs.clear();
	stored.saved = [];
	stored.refuse = false;
	db.outputs = [];
	db.conversation = { messages: [] };
	config.CHAT_GOTENBERG_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(() => {
	delete config.CHAT_GOTENBERG_URL;
});

const tool = () => createConvertDocumentBuiltin()[0];

describe("gating", () => {
	it("is absent without CHAT_GOTENBERG_URL, wherever the tools are collected", () => {
		delete config.CHAT_GOTENBERG_URL;
		expect(createConvertDocumentBuiltin()).toEqual([]);
		const names = getEnabledBuiltinTools({ conv: { _id: conversationId } }).map((t) => t.name);
		expect(names).not.toContain(CONVERT_DOCUMENT_TOOL_NAME);
	});

	it("is offered to ordinary conversations when Gotenberg is configured", () => {
		const names = getEnabledBuiltinTools({ conv: { _id: conversationId } }).map((t) => t.name);
		expect(names).toContain(CONVERT_DOCUMENT_TOOL_NAME);
		const definition = tool().definition.function;
		expect(definition.description).toMatch(/PDF/);
		expect(JSON.stringify(definition.parameters)).toContain("markdown");
	});

	it("refuses a call made after the configuration went away", async () => {
		const t = tool();
		delete config.CHAT_GOTENBERG_URL;
		expect(await t.execute({ markdown: "# a" }, ctx())).toEqual({
			error: "Document conversion is not available on this deployment.",
		});
	});
});

describe("converting a file of the conversation", () => {
	it("converts an attachment by the name the model knows, saves the PDF and lists it", async () => {
		db.conversation = { messages: [{ files: [attachment("Q3 report.docx", "sha-docx")] }] };
		stored.attachments.set("sha-docx", Buffer.from("PK docx bytes"));

		const result = await tool().execute({ file: "/mnt/data/Q3 report.docx" }, ctx());

		expect(requests).toHaveLength(1);
		expect(requests[0].path).toBe("/forms/libreoffice/convert");
		expect(requests[0].body).toContain('filename="document.docx"');
		expect(requests[0].body).toContain("PK docx bytes");
		expect(stored.saved).toHaveLength(1);
		expect(stored.saved[0]).toMatchObject({ name: "Q3 report.pdf", mime: "application/pdf" });
		expect(stored.saved[0].bytes.equals(PDF)).toBe(true);
		if (!("resultText" in result)) throw new Error("expected a result");
		expect(result.resultText).toContain("Q3 report.pdf");
		expect(result.extraUpdates).toEqual([
			{
				type: MessageUpdateType.CodeExecution,
				subtype: MessageCodeExecutionUpdateType.Outputs,
				runKey: expect.stringMatching(/^convert_document:/),
				files: [{ name: "Q3 report.pdf", size: PDF.byteLength, sha256: "f".repeat(64) }],
			},
		]);
	});

	it("converts the latest version by default, a produced one over the attachment of that name", async () => {
		db.conversation = { messages: [{ files: [attachment("deck.docx", "sha-docx")] }] };
		stored.attachments.set("sha-docx", Buffer.from("PK original"));
		db.outputs = [{ name: "deck.docx", sha256: "s1", createdAt: new Date() }];
		stored.outputs.set("s1", Buffer.from("PK edited"));

		await tool().execute({ file: "deck.docx" }, ctx());
		expect(requests[0].body).toContain("PK edited");
		expect(requests[0].body).not.toContain("PK original");

		await tool().execute({ file: "deck.docx", version: 1 }, ctx());
		expect(requests[1].body).toContain("PK original");
	});

	it("converts an earlier version of a file when asked for one, and refuses a bad version", async () => {
		db.outputs = [{ name: "deck.pptx", sha256: "s1", createdAt: new Date() }];
		stored.outputs.set("s1", Buffer.from("deck bytes"));
		await tool().execute({ file: "deck.pptx", version: 1 }, ctx());
		expect(requests[0].body).toContain("deck bytes");
		expect(await tool().execute({ file: "deck.pptx", version: 4 }, ctx())).toMatchObject({
			error: expect.stringContaining('"deck.pptx" has no version 4'),
		});
		expect(requests).toHaveLength(1);
	});

	it("converts a file a run produced, and Markdown or HTML files through Chromium", async () => {
		db.outputs = [{ name: "deck.pptx", sha256: "s1", createdAt: new Date() }];
		stored.outputs.set("s1", Buffer.from("deck bytes"));
		await tool().execute({ file: "deck.pptx", name: "handout" }, ctx());
		expect(stored.saved[0].name).toBe("handout.pdf");
		expect(requests[0].path).toBe("/forms/libreoffice/convert");

		db.conversation = { messages: [{ files: [attachment("notes.md", "sha-md")] }] };
		stored.attachments.set("sha-md", Buffer.from("# Notes\n\nhello"));
		await tool().execute({ file: "notes.md" }, ctx());
		expect(requests[1].path).toBe("/forms/chromium/convert/html");
		expect(requests[1].body).toContain("<h1");
		expect(stored.saved[1].name).toBe("notes.pdf");
	});

	it("says which names exist when the file is not there, and refuses what cannot be converted", async () => {
		const missing = await tool().execute({ file: "nothing.docx" }, ctx());
		expect(missing).toMatchObject({
			error: expect.stringContaining('No file named "nothing.docx"'),
		});

		db.conversation = {
			messages: [
				{
					files: [
						attachment("a.pdf", "p"),
						attachment("b.zip", "z"),
						attachment("big.docx", "big"),
					],
				},
			],
		};
		stored.attachments.set("p", Buffer.from("%PDF"));
		stored.attachments.set("z", Buffer.from("zip"));
		stored.attachments.set("big", Buffer.alloc(20 * 1024 * 1024 + 1));
		expect(await tool().execute({ file: "a.pdf" }, ctx())).toMatchObject({
			error: expect.stringContaining("already a PDF"),
		});
		expect(await tool().execute({ file: "b.zip" }, ctx())).toMatchObject({
			error: expect.stringContaining("cannot be converted"),
		});
		expect(await tool().execute({ file: "big.docx" }, ctx())).toMatchObject({
			error: expect.stringContaining("larger than"),
		});
		expect(requests).toHaveLength(0);
	});
});

describe("rendering content", () => {
	it("renders Markdown and HTML through the browser route, as a document with no network", async () => {
		await tool().execute({ markdown: "# Title\n\ntext", name: "summary.pdf" }, ctx());
		await tool().execute({ html: "<p>hi</p><script>x()</script>" }, ctx());
		expect(requests.map((r) => r.path)).toEqual([
			"/forms/chromium/convert/html",
			"/forms/chromium/convert/html",
		]);
		expect(requests[0].body).toContain("<h1");
		expect(requests[0].body).toContain("default-src 'none'");
		expect(requests[1].body).not.toContain("<script");
		expect(stored.saved.map((s) => s.name)).toEqual(["summary.pdf", "document.pdf"]);
	});

	it("wants exactly one input", async () => {
		const none = await tool().execute({}, ctx());
		const two = await tool().execute({ markdown: "a", html: "b" }, ctx());
		expect(none).toMatchObject({ error: expect.stringContaining("exactly one") });
		expect(two).toMatchObject({ error: expect.stringContaining("exactly one") });
		expect(requests).toHaveLength(0);
	});
});

describe("errors the model can read", () => {
	it.each([
		[503, /busy/],
		[400, /could not read this file/],
		[500, /failed/],
	])("reports a %i from the converter as an error, not a crash", async (code, message) => {
		status = code;
		const result = await tool().execute({ markdown: "# a" }, ctx());
		expect(result).toMatchObject({ error: expect.stringMatching(message) });
		expect(stored.saved).toHaveLength(0);
	});

	it("reports an unreachable converter and a full conversation", async () => {
		config.CHAT_GOTENBERG_URL = "http://127.0.0.1:1";
		expect(await tool().execute({ markdown: "# a" }, ctx())).toMatchObject({
			error: expect.stringContaining("not reachable"),
		});
		config.CHAT_GOTENBERG_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
		stored.refuse = true;
		expect(await tool().execute({ markdown: "# a" }, ctx())).toEqual({
			error: "This conversation has reached its limit.",
		});
	});

	it("limits the calls in one turn, and needs a conversation", async () => {
		const t = tool();
		for (let i = 0; i < MAX_CONVERSIONS_PER_TURN; i += 1) {
			await t.execute({ markdown: `# ${i}` }, ctx());
		}
		expect(await t.execute({ markdown: "# more" }, ctx())).toMatchObject({
			error: expect.stringContaining("limit"),
		});
		expect(
			await tool().execute({ markdown: "# a" }, ctx({ conversationId: undefined }))
		).toMatchObject({
			error: expect.stringContaining("no conversation"),
		});
	});
});

describe("outputNameFor", () => {
	it("makes a safe .pdf name", () => {
		expect(outputNameFor("../../etc/x.pdf", "d")).toBe("x.pdf");
		expect(outputNameFor("  ", "report")).toBe("report.pdf");
		expect(outputNameFor(".hidden", "d")).toBe("hidden.pdf");
		expect(outputNameFor("a\u0000b.PDF", "d")).toBe("ab.pdf");
		expect(outputNameFor(undefined, "")).toBe("document.pdf");
	});
});
