import { describe, it, expect } from "vitest";
import { POST, PRINT_HEADERS } from "./+server";

function formRequest(fields: Record<string, string>): Request {
	const form = new FormData();
	for (const [k, v] of Object.entries(fields)) form.set(k, v);
	return new Request("http://app/api/v2/slides/print?print-pdf", { method: "POST", body: form });
}

const call = (fields: Record<string, string>, locals: object = { sessionId: "s1" }) =>
	POST({ locals, request: formRequest(fields) } as never);

describe("POST /api/v2/slides/print", () => {
	it("needs a signed-in user or a session", async () => {
		await expect(call({ content: "<section>a</section>" }, {})).rejects.toMatchObject({
			status: 401,
		});
	});

	it("asks for a deck, and refuses one that is too large", async () => {
		await expect(call({})).rejects.toMatchObject({ status: 400 });
		await expect(call({ content: "   " })).rejects.toMatchObject({ status: 400 });
		await expect(call({ content: "x".repeat(2_000_001) })).rejects.toMatchObject({ status: 413 });
	});

	it("answers with a page that is an opaque origin: sandbox, no network, no same-origin", async () => {
		const res = await call({ content: "<section>One</section><section>Two</section>" });
		expect(res.status).toBe(200);
		const csp = res.headers.get("content-security-policy") ?? "";
		expect(csp.startsWith("sandbox allow-scripts allow-modals;")).toBe(true);
		expect(csp).not.toContain("allow-same-origin");
		expect(csp).not.toContain("allow-popups");
		expect(csp).not.toContain("allow-forms");
		expect(csp).toContain("default-src 'none'");
		expect(csp).toContain("connect-src 'none'");
		expect(csp).toContain("form-action 'none'");
		expect(csp).toContain("frame-src 'none'");
		expect(res.headers.get("content-type")).toContain("text/html");
		expect(res.headers.get("cache-control")).toBe("no-store");
		expect(res.headers.get("x-content-type-options")).toBe("nosniff");
		expect(res.headers.get("referrer-policy")).toBe("no-referrer");
		expect(PRINT_HEADERS["Content-Security-Policy"]).toBe(csp);
	});

	it("renders the deck in print mode, with the notes choice and an escaped label", async () => {
		const res = await call({
			content: "<section>One<aside class='notes'>n</aside></section>",
			notes: "1",
			labelPrint: "Print <b>now</b>",
			labelHint: "Turn on background graphics",
		});
		const html = await res.text();
		expect(html).toContain("<section>One");
		expect(html).toContain('"notes":true');
		expect(html).toContain('"auto":true');
		expect(html).toContain("Print &lt;b&gt;now&lt;/b&gt;");
		expect(html).not.toContain("Print <b>now</b>");
		expect(html).toContain('http-equiv="Content-Security-Policy"');
	});

	it("tidies a deck's script before it is printed", async () => {
		const res = await call({
			content: '<section onclick="x()"><script>steal()</script>ok</section>',
		});
		const html = await res.text();
		const body = html.slice(html.indexOf('<div class="reveal">'));
		const markup = body.slice(0, body.indexOf("<script>"));
		expect(markup).toContain("ok");
		expect(markup).not.toContain("steal()");
		expect(markup).not.toContain("onclick");
	});

	it("serves the content of the request and nothing else: nothing is looked up by id", async () => {
		const a = await (
			await call({ content: "<section>Alpha</section>" }, { sessionId: "a" })
		).text();
		const b = await (await call({ content: "<section>Beta</section>" }, { sessionId: "b" })).text();
		expect(a).toContain("Alpha");
		expect(a).not.toContain("Beta");
		expect(b).toContain("Beta");
		expect(b).not.toContain("Alpha");
	});
});
