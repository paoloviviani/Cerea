import { describe, it, expect, vi } from "vitest";
import { PdfBusyError, PdfTimeoutError, PdfTooLargeError, renderDeckPdf } from "./renderPdf";

type RouteHandler = (route: {
	request: () => { url: () => string };
	fulfill: (o: Record<string, unknown>) => Promise<void>;
	abort: (reason?: string) => Promise<void>;
}) => Promise<void>;

/** A browser that records what it was asked, standing in for the stack's renderer. */
function fakeBrowser(opts: { pdf?: Buffer; hang?: boolean; waitFails?: boolean } = {}) {
	const calls = {
		contextOptions: undefined as Record<string, unknown> | undefined,
		gotoUrl: "",
		fulfilled: [] as Record<string, unknown>[],
		aborted: [] as string[],
		closed: false,
		pdfOptions: undefined as Record<string, unknown> | undefined,
	};
	let handler: RouteHandler | undefined;
	const page = {
		goto: vi.fn(async (url: string) => {
			calls.gotoUrl = url;
			if (opts.hang) return new Promise(() => {});
			// The page asks for its own address, then for things it should not reach
			const ask = (u: string) =>
				handler?.({
					request: () => ({ url: () => u }),
					fulfill: async (o) => void calls.fulfilled.push(o),
					abort: async () => void calls.aborted.push(u),
				});
			await ask(url);
			await ask("https://example.com/steal");
			await ask("https://cerea.example/api/v2/user");
		}),
		waitForSelector: vi.fn(async () => {
			if (opts.waitFails) throw new Error("timeout");
		}),
		evaluate: vi.fn(async () => {}),
		pdf: vi.fn(async (o: Record<string, unknown>) => {
			calls.pdfOptions = o;
			return opts.pdf ?? Buffer.from("%PDF-1.7 fake");
		}),
	};
	const context = {
		route: vi.fn(async (_pattern: string, h: RouteHandler) => void (handler = h)),
		newPage: vi.fn(async () => page),
		close: vi.fn(async () => {}),
	};
	const browser = {
		newContext: vi.fn(async (o: Record<string, unknown>) => {
			calls.contextOptions = o;
			return context;
		}),
		close: vi.fn(async () => void (calls.closed = true)),
	};
	return { browser, calls, page, context };
}

const render = (html: string, fake: ReturnType<typeof fakeBrowser>, o = {}) =>
	renderDeckPdf(html, { connect: async () => fake.browser as never, ...o });

describe("renderDeckPdf", () => {
	it("hands the deck over with route.fulfill and aborts every other request", async () => {
		const fake = fakeBrowser();
		const pdf = await render("<html>deck</html>", fake);
		expect(pdf.toString()).toBe("%PDF-1.7 fake");
		expect(fake.calls.gotoUrl).toBe("https://deck.invalid/?print-pdf");
		expect(fake.calls.fulfilled).toHaveLength(1);
		expect(fake.calls.fulfilled[0]).toMatchObject({ status: 200, body: "<html>deck</html>" });
		expect(fake.calls.aborted).toEqual([
			"https://example.com/steal",
			"https://cerea.example/api/v2/user",
		]);
	});

	it("uses a fresh context with no storage to carry, JavaScript on, nothing downloaded", async () => {
		const fake = fakeBrowser();
		await render("<html></html>", fake);
		expect(fake.calls.contextOptions).toMatchObject({
			javaScriptEnabled: true,
			acceptDownloads: false,
			serviceWorkers: "block",
		});
		expect(fake.calls.contextOptions).not.toHaveProperty("storageState");
		expect(fake.calls.contextOptions).not.toHaveProperty("extraHTTPHeaders");
	});

	it("waits for the print layout and prints 1280x720 pages with backgrounds", async () => {
		const fake = fakeBrowser();
		await render("<html></html>", fake);
		expect(fake.page.waitForSelector).toHaveBeenCalledWith(
			"html[data-print-ready]",
			expect.objectContaining({ state: "attached" })
		);
		expect(fake.calls.pdfOptions).toMatchObject({
			width: "1280px",
			height: "720px",
			printBackground: true,
			preferCSSPageSize: true,
		});
	});

	it("always closes the browser, on success and on failure", async () => {
		const ok = fakeBrowser();
		await render("<html></html>", ok);
		expect(ok.calls.closed).toBe(true);
		const bad = fakeBrowser({ waitFails: true });
		await expect(render("<html></html>", bad)).rejects.toThrow("timeout");
		expect(bad.calls.closed).toBe(true);
	});

	it("refuses a PDF over the size limit", async () => {
		const fake = fakeBrowser({ pdf: Buffer.alloc(1000) });
		await expect(render("<html></html>", fake, { maxBytes: 999 })).rejects.toBeInstanceOf(
			PdfTooLargeError
		);
		expect(fake.calls.closed).toBe(true);
	});

	it("gives up after the time limit and still closes the browser", async () => {
		const fake = fakeBrowser({ hang: true });
		await expect(render("<html></html>", fake, { timeoutMs: 50 })).rejects.toBeInstanceOf(
			PdfTimeoutError
		);
		expect(fake.calls.closed).toBe(true);
	});

	it("caps how many renders run at once", async () => {
		const slow = [fakeBrowser({ hang: true }), fakeBrowser({ hang: true })];
		const running = slow.map((f) => render("<html></html>", f, { timeoutMs: 200 }).catch((e) => e));
		await new Promise((r) => setTimeout(r, 20));
		const third = fakeBrowser();
		await expect(render("<html></html>", third)).rejects.toBeInstanceOf(PdfBusyError);
		expect(third.browser.newContext).not.toHaveBeenCalled();
		await Promise.all(running);
		// Once they finish there is room again
		await expect(render("<html></html>", fakeBrowser())).resolves.toBeInstanceOf(Buffer);
	});
});
