/**
 * Against a real Gotenberg, which no mock can stand in for: LibreOffice and
 * Chromium actually converting the fixtures. Runs only when a throwaway
 * container is named:
 *
 *   docker network create --internal c17-net
 *   docker run -d --name c17-gotenberg --network c17-net gotenberg/gotenberg:8.38.1 \
 *     gotenberg --chromium-disable-javascript --chromium-deny-private-ips ...   (the kit's flags)
 *   TEST_GOTENBERG_URL=http://<container ip>:3000 npx vitest run --project=server <this file>
 *
 * (An `internal` network publishes no port; the container's address on it is
 * reachable from the host.) The fixtures were written with python-docx and
 * python-pptx, the generators the sandbox's own skills use.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

const url = process.env.TEST_GOTENBERG_URL;

vi.mock("$lib/server/logger", () => ({
	logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("$lib/server/config", () => ({
	config: { CHAT_GOTENBERG_URL: process.env.TEST_GOTENBERG_URL },
}));

const { convertHtmlToPdf, convertOfficeToPdf, gotenbergUrl, markdownToHtml } =
	await import("./gotenberg");

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url));

/** The page count, from the page tree's own `/Count`. */
function pageCount(pdf: Buffer): number {
	const counts = [...pdf.toString("latin1").matchAll(/\/Count (\d+)/g)].map((m) => Number(m[1]));
	return Math.max(0, ...counts);
}

describe.skipIf(!url)("Gotenberg, for real", () => {
	it("is the version the kit pins", async () => {
		const res = await fetch(`${gotenbergUrl()}/version`);
		expect(await res.text()).toMatch(/^8\.38\./);
	});

	it("converts a Word document", async () => {
		const pdf = await convertOfficeToPdf(fixture("hello.docx"), "hello.docx");
		expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
		expect(pageCount(pdf)).toBe(1);
		expect(pdf.byteLength).toBeGreaterThan(2000);
	});

	it("converts a PowerPoint deck", async () => {
		const pdf = await convertOfficeToPdf(fixture("hello.pptx"), "hello.pptx");
		expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
		expect(pageCount(pdf)).toBe(1);
	});

	it('answers a format it has no importer for with a 4xx, which the client maps to "could not read"', async () => {
		const form = new FormData();
		form.append("files", new Blob(["x"]), "document.unknownext");
		const res = await fetch(`${gotenbergUrl()}/forms/libreoffice/convert`, {
			method: "POST",
			body: form,
		});
		expect(res.status).toBeGreaterThanOrEqual(400);
		expect(res.status).toBeLessThan(500);
	});

	it("renders Markdown through Chromium", async () => {
		const pdf = await convertHtmlToPdf(
			markdownToHtml("# Title\n\n| a | b |\n|---|---|\n| 1 | 2 |\n"),
			{
				title: "T",
			}
		);
		expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
		expect(pageCount(pdf)).toBe(1);
	});

	it("does not run JavaScript in the browser, whatever the page says", async () => {
		// Straight to the container: our own wrapper strips scripts, so this checks
		// that the container's flag holds on its own. A script that adds four
		// hundred headings would make many pages if it ran.
		const page =
			"<html><body><p>one line</p><script>for (let i = 0; i < 400; i++) {" +
			"document.body.appendChild(document.createElement('h1')).textContent = 'JS ' + i}</script></body></html>";
		const form = new FormData();
		form.append("files", new Blob([page], { type: "text/html" }), "index.html");
		const res = await fetch(`${gotenbergUrl()}/forms/chromium/convert/html`, {
			method: "POST",
			body: form,
		});
		expect(res.status).toBe(200);
		expect(pageCount(Buffer.from(await res.arrayBuffer()))).toBe(1);
	});

	it("will not fetch a URL it is given to download (downloadFrom is off)", async () => {
		const form = new FormData();
		form.append(
			"downloadFrom",
			JSON.stringify([{ url: "http://169.254.169.254/latest/meta-data/" }])
		);
		const res = await fetch(`${gotenbergUrl()}/forms/libreoffice/convert`, {
			method: "POST",
			body: form,
		});
		expect(res.status).toBeGreaterThanOrEqual(400);
	});
});
