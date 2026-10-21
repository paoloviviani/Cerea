import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";

vi.mock("$lib/server/logger", () => ({
	logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
const config: Record<string, string> = {};
vi.mock("$lib/server/config", () => ({ config }));

const {
	CONVERTER_VERSION,
	ConversionError,
	MAX_SOURCE_BYTES,
	convertHtmlToPdf,
	convertOfficeToPdf,
	conversionsInFlight,
	gotenbergUrl,
	htmlPage,
	isGotenbergEnabled,
	markdownToHtml,
	officeFileName,
} = await import("./gotenberg");

const PDF = Buffer.from("%PDF-1.7\nfake");

interface Seen {
	path: string;
	fields: Record<string, string>;
	fileName?: string;
	fileBody?: string;
}

let server: http.Server;
let seen: Seen[] = [];
let respond: (req: http.IncomingMessage, res: http.ServerResponse, seen: Seen) => void;

function parseMultipart(body: Buffer, contentType: string): Omit<Seen, "path"> {
	const boundary = /boundary=(.+)$/.exec(contentType)?.[1] ?? "";
	const out: Omit<Seen, "path"> = { fields: {} };
	for (const part of body.toString("latin1").split(`--${boundary}`)) {
		const header = /Content-Disposition: form-data; name="([^"]+)"(?:; filename="([^"]*)")?/i.exec(
			part
		);
		if (!header) continue;
		const value = part.slice(part.indexOf("\r\n\r\n") + 4).replace(/\r\n$/, "");
		if (header[2] !== undefined) {
			out.fileName = header[2];
			out.fileBody = value;
		} else out.fields[header[1]] = value;
	}
	return out;
}

beforeAll(async () => {
	server = http.createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (c) => chunks.push(c));
		req.on("end", () => {
			const entry: Seen = {
				path: req.url ?? "",
				...parseMultipart(Buffer.concat(chunks), req.headers["content-type"] ?? ""),
			};
			seen.push(entry);
			respond(req, res, entry);
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

beforeEach(() => {
	seen = [];
	config.CHAT_GOTENBERG_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	respond = (_req, res) => {
		res.writeHead(200, { "Content-Type": "application/pdf" });
		res.end(PDF);
	};
});
afterEach(() => {
	delete config.CHAT_GOTENBERG_URL;
});

describe("configuration", () => {
	it("is off when CHAT_GOTENBERG_URL is unset, empty or not an http(s) URL", () => {
		delete config.CHAT_GOTENBERG_URL;
		expect(isGotenbergEnabled()).toBe(false);
		for (const bad of ["", "   ", "gotenberg:3000", "ftp://gotenberg", "not a url"]) {
			config.CHAT_GOTENBERG_URL = bad;
			expect(gotenbergUrl()).toBe("");
			expect(isGotenbergEnabled()).toBe(false);
		}
	});

	it("takes the address without a trailing slash", () => {
		config.CHAT_GOTENBERG_URL = "http://gotenberg:3000/";
		expect(gotenbergUrl()).toBe("http://gotenberg:3000");
		expect(isGotenbergEnabled()).toBe(true);
	});

	it("names the converter in the version that keys cached previews", () => {
		expect(CONVERTER_VERSION).toMatch(/^gotenberg\d/);
	});
});

describe("convertOfficeToPdf", () => {
	it("posts the file to the LibreOffice route under a name made here, and returns the PDF", async () => {
		const pdf = await convertOfficeToPdf(
			Buffer.from("zip bytes"),
			"Q3 ../../etc/passwd report.DOCX"
		);
		expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
		expect(seen).toHaveLength(1);
		expect(seen[0].path).toBe("/forms/libreoffice/convert");
		expect(seen[0].fileName).toBe("document.docx");
		expect(seen[0].fileBody).toBe("zip bytes");
	});

	it("refuses what is not an Office document, and files over the limit, without calling out", async () => {
		await expect(convertOfficeToPdf(Buffer.from("x"), "photo.png")).rejects.toMatchObject({
			kind: "unsupported",
		});
		await expect(
			convertOfficeToPdf(new Uint8Array(MAX_SOURCE_BYTES + 1), "big.pptx")
		).rejects.toMatchObject({ kind: "too_large" });
		expect(seen).toHaveLength(0);
	});

	it.each([
		[503, "busy"],
		[504, "timeout"],
		[400, "rejected"],
		[500, "failed"],
	])(
		"maps a %i answer to %s, with a message that leaks nothing of Gotenberg's",
		async (status, kind) => {
			respond = (_req, res) => {
				res.writeHead(status, { "Content-Type": "text/plain" });
				res.end("internal detail: /tmp/abc/document.docx exploded");
			};
			const err = await convertOfficeToPdf(Buffer.from("x"), "a.docx").catch((e) => e);
			expect(err).toBeInstanceOf(ConversionError);
			expect(err.kind).toBe(kind);
			expect(err.message).not.toContain("/tmp");
		}
	);

	it("rejects an answer that is not a PDF", async () => {
		respond = (_req, res) => {
			res.writeHead(200, { "Content-Type": "application/pdf" });
			res.end("<html>nope</html>");
		};
		await expect(convertOfficeToPdf(Buffer.from("x"), "a.docx")).rejects.toMatchObject({
			kind: "failed",
		});
	});

	it("says unavailable when nothing answers, and when it is not configured", async () => {
		config.CHAT_GOTENBERG_URL = "http://127.0.0.1:1";
		await expect(convertOfficeToPdf(Buffer.from("x"), "a.docx")).rejects.toMatchObject({
			kind: "unavailable",
		});
		delete config.CHAT_GOTENBERG_URL;
		await expect(convertOfficeToPdf(Buffer.from("x"), "a.docx")).rejects.toMatchObject({
			kind: "unavailable",
		});
	});

	it("stops when the caller cancels", async () => {
		respond = () => {
			// never answers
		};
		const controller = new AbortController();
		const pending = convertOfficeToPdf(Buffer.from("x"), "a.docx", { signal: controller.signal });
		setTimeout(() => controller.abort(), 50);
		await expect(pending).rejects.toMatchObject({ kind: "timeout" });
	});

	it("keeps at most three conversions in flight and finishes the rest in turn", async () => {
		let active = 0;
		let peak = 0;
		respond = (_req, res) => {
			active += 1;
			peak = Math.max(peak, active);
			setTimeout(() => {
				active -= 1;
				res.writeHead(200, { "Content-Type": "application/pdf" });
				res.end(PDF);
			}, 40);
		};
		const results = await Promise.all(
			Array.from({ length: 7 }, () => convertOfficeToPdf(Buffer.from("x"), "a.docx"))
		);
		expect(results).toHaveLength(7);
		expect(peak).toBeLessThanOrEqual(3);
		expect(conversionsInFlight()).toBe(0);
	});
});

describe("convertHtmlToPdf", () => {
	it("posts one index.html to the Chromium route and tells it not to wait for the network", async () => {
		await convertHtmlToPdf("<h1>Hi</h1>", { title: "T" });
		expect(seen[0].path).toBe("/forms/chromium/convert/html");
		expect(seen[0].fileName).toBe("index.html");
		expect(seen[0].fileBody).toContain("<h1>Hi</h1>");
		expect(seen[0].fields.skipNetworkIdleEvent).toBe("true");
		expect(seen[0].fields.failOnResourceLoadingFailed).toBe("false");
	});

	it("wraps the content in a page that allows no network and no script", () => {
		const page = htmlPage(
			'<p>ok</p><script>fetch("http://evil")</script><img src="https://evil/x.png"><iframe src="https://evil"></iframe>' +
				'<link rel="stylesheet" href="https://evil/s.css"><base href="https://evil/"><object data="x"></object>',
			'Ti"tle'
		);
		expect(page).toContain("default-src 'none'");
		expect(page).toContain("img-src data:");
		expect(page).toContain("<p>ok</p>");
		for (const forbidden of ["<script", "<iframe", "<link", "<base", "<object", "fetch("]) {
			expect(page).not.toContain(forbidden);
		}
		expect(page).toContain("<title>Ti&#34;tle</title>");
	});

	it("refuses an oversized document without calling out", async () => {
		await expect(convertHtmlToPdf("x".repeat(2 * 1024 * 1024 + 1))).rejects.toMatchObject({
			kind: "too_large",
		});
		expect(seen).toHaveLength(0);
	});

	it("renders Markdown to HTML first", () => {
		expect(markdownToHtml("# Title\n\n- a\n- b")).toContain("<h1");
		expect(markdownToHtml("| a | b |\n|---|---|\n| 1 | 2 |")).toContain("<table>");
	});
});

describe("officeFileName", () => {
	it("prefers the stored type, then the name's extension", () => {
		expect(
			officeFileName(
				"application/vnd.openxmlformats-officedocument.presentationml.presentation",
				"whatever.bin"
			)
		).toBe("document.pptx");
		expect(officeFileName("application/octet-stream", "Budget.XLSX")).toBe("document.xlsx");
		expect(officeFileName("application/pdf", "a.pdf")).toBeUndefined();
		expect(officeFileName(undefined, undefined)).toBeUndefined();
	});
});
