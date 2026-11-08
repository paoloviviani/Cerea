import SlidesView from "./SlidesView.svelte";
import { render } from "vitest-browser-svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const DECK = "---\ntheme: cerea\n---\n# One\n\n---\n\n# Two\n\nNote: hi\n";

async function mount(props: Record<string, unknown> = {}) {
	const screen = render(SlidesView, { content: DECK, ...props } as never);
	// The frame is built after a lazy import of the deck code, which can take seconds on a loaded runner
	await vi.waitFor(() => expect(document.querySelector("iframe")).toBeTruthy(), {
		timeout: 15_000,
	});
	const iframe = document.querySelector("iframe") as HTMLIFrameElement;
	return { screen, iframe };
}

/** The picture PDF is the last option in the PDF menu (the default button prints or asks the server). */
async function startImagePdf(screen: {
	getByRole: (role: string, options: Record<string, unknown>) => { click(): Promise<void> | void };
}) {
	await screen.getByRole("button", { name: "More ways to make a PDF" }).click();
	await screen.getByRole("menuitem", { name: /as pictures/ }).click();
}

// The picture PDF loads its renderer on first use; on a cold dev server that alone can pass the 15 s default.
describe("SlidesView", { timeout: 60_000 }, () => {
	// The component asks the server whether it can make the PDF; without a stub that request reaches the
	// test dev server, which has no app behind it (and logs a hooks error on teardown).
	const pageFetch = globalThis.fetch;
	beforeEach(() => {
		vi.stubGlobal("fetch", async (url: RequestInfo | URL, init?: RequestInit) =>
			String(url).endsWith("/api/v2/slides/pdf") && !init?.method
				? new Response(JSON.stringify({ available: false }), { status: 200 })
				: pageFetch(url, init)
		);
	});
	afterEach(() => vi.stubGlobal("fetch", pageFetch));

	it("renders the deck in a sandbox without same-origin access", async () => {
		const { iframe } = await mount();
		const sandbox = iframe.getAttribute("sandbox") ?? "";
		expect(sandbox).toContain("allow-scripts");
		expect(sandbox).not.toContain("allow-same-origin");
		expect(sandbox).not.toContain("allow-modals");
		expect(iframe.srcdoc).toContain("Content-Security-Policy");
	});

	it("steps through the real deck: next, previous, and speaker notes on the second slide", async () => {
		const { screen } = await mount();
		const counter = screen.getByTestId("slides-counter");
		// The deck runs for real in the sandbox and reports its own state
		await expect.element(counter).toHaveTextContent("1 / 2");
		const notes = screen.getByRole("button", { name: "Speaker notes (N)" });
		await expect.element(notes).toBeDisabled();
		await screen.getByRole("button", { name: "Next slide" }).click();
		await expect.element(counter).toHaveTextContent("2 / 2");
		await expect.element(notes).toBeEnabled();
		await screen.getByRole("button", { name: "Previous slide" }).click();
		await expect.element(counter).toHaveTextContent("1 / 2");
	});

	it("ignores state that does not come from the deck's window", async () => {
		const { screen } = await mount();
		await expect.element(screen.getByTestId("slides-counter")).toHaveTextContent("1 / 2");
		window.dispatchEvent(
			new MessageEvent("message", {
				data: { type: "chatui.slides.state", channel: "x", detail: { index: 2, total: 9 } },
				source: window,
			})
		);
		await expect.element(screen.getByTestId("slides-counter")).toHaveTextContent("1 / 2");
	});

	it("loads the organisation logo lazily, and only when the data says there is one", async () => {
		const logo = "data:image/png;base64,iVBORw0KGgo=";
		const loadOrgLogo = vi.fn(async () => logo);
		const { iframe } = await mount({ org: { hasLogo: true, accent: "#112233" }, loadOrgLogo });
		expect(loadOrgLogo).toHaveBeenCalledTimes(1);
		expect(iframe.srcdoc).toContain(`class="cerea-logo"`);
		expect(iframe.srcdoc).toContain("--brand-accent:#112233");
		loadOrgLogo.mockClear();
		await mount({ org: { accent: "#112233" }, loadOrgLogo });
		expect(loadOrgLogo).not.toHaveBeenCalled();
	});

	it("resolves a logo named in the front matter through resolveLogo", async () => {
		const resolveLogo = vi.fn(async () => "data:image/png;base64,iVBORw0KGgo=");
		const { iframe } = await mount({
			content: "---\nlogo: logo.png\n---\n# x\n",
			resolveLogo,
		});
		expect(resolveLogo).toHaveBeenCalledWith("logo.png");
		expect(iframe.srcdoc).toContain(`class="cerea-logo"`);
	});

	it("runs without reporting a script error from the sandbox", async () => {
		const errors: unknown[] = [];
		const onMessage = (e: MessageEvent) => {
			if ((e.data as { type?: string })?.type === "chatui.preview.error") errors.push(e.data);
		};
		window.addEventListener("message", onMessage);
		const { screen } = await mount();
		await expect.element(screen.getByTestId("slides-counter")).toHaveTextContent("1 / 2");
		await screen.getByRole("button", { name: "Next slide" }).click();
		await expect.element(screen.getByTestId("slides-counter")).toHaveTextContent("2 / 2");
		window.removeEventListener("message", onMessage);
		expect(errors).toEqual([]);
	});

	it("downloads a PDF with one page per slide", async () => {
		const blobs: Blob[] = [];
		const create = vi.spyOn(URL, "createObjectURL").mockImplementation((b) => {
			blobs.push(b as Blob);
			return "blob:test";
		});
		const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
		const { screen } = await mount();
		await expect.element(screen.getByTestId("slides-counter")).toHaveTextContent("1 / 2");
		await startImagePdf(screen);
		await vi.waitFor(() => expect(blobs.length).toBe(1), { timeout: 30_000 });
		const text = new TextDecoder("latin1").decode(await blobs[0].arrayBuffer());
		expect(blobs[0].type).toBe("application/pdf");
		expect(text.startsWith("%PDF-1.4")).toBe(true);
		expect(text).toContain("/Count 2");
		expect(text).toContain("/Title (One)");
		create.mockRestore();
		click.mockRestore();
	});

	it("renders a designed HTML deck, shows its notes, and exports one PDF page per slide", async () => {
		const { default: talk } = await import("$lib/utils/slides/fixtures/talk-deck.html?raw");
		const blobs: Blob[] = [];
		const create = vi.spyOn(URL, "createObjectURL").mockImplementation((b) => {
			blobs.push(b as Blob);
			return "blob:test";
		});
		const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
		const { screen, iframe } = await mount({ content: talk, org: { accent: "#0a7e8c" } });
		const counter = screen.getByTestId("slides-counter");
		await expect.element(counter).toHaveTextContent("1 / 5");
		expect(iframe.srcdoc).toContain("--brand-accent:#0a7e8c");
		// The first slide has speaker notes, taken from <aside class="notes">
		await expect.element(screen.getByRole("button", { name: "Speaker notes (N)" })).toBeEnabled();
		await screen.getByRole("button", { name: "Next slide" }).click();
		await expect.element(counter).toHaveTextContent("2 / 5");
		await startImagePdf(screen);
		await vi.waitFor(() => expect(blobs.length).toBe(1), { timeout: 60_000 });
		const text = new TextDecoder("latin1").decode(await blobs[0].arrayBuffer());
		expect(text).toContain("/Count 5");
		expect(text).toContain("/Title (Fewer escalations");
		create.mockRestore();
		click.mockRestore();
	}, 90_000);

	describe("vertical stacks and long exports", () => {
		const STACK =
			'<section data-background-color="#ff0000">a</section>' +
			'<section><section data-background-color="#00ff00">b1</section><section data-background-color="#0000ff">b2</section></section>' +
			'<section data-background-color="#ffff00">c</section>';

		/** The JPEG pictures of a PDF, in page order. */
		function pagesOf(bytes: Uint8Array): Uint8Array[] {
			const out: Uint8Array[] = [];
			for (let i = 0; i + 3 < bytes.length; i++) {
				if (bytes[i] === 0xff && bytes[i + 1] === 0xd8 && bytes[i + 2] === 0xff) {
					let j = i + 2;
					while (j + 1 < bytes.length && !(bytes[j] === 0xff && bytes[j + 1] === 0xd9)) j++;
					out.push(bytes.slice(i, j + 2));
					i = j;
				}
			}
			return out;
		}

		async function centre(jpeg: Uint8Array): Promise<[number, number, number]> {
			const bitmap = await createImageBitmap(new Blob([jpeg as BlobPart], { type: "image/jpeg" }));
			const canvas = document.createElement("canvas");
			canvas.width = bitmap.width;
			canvas.height = bitmap.height;
			const ctx = canvas.getContext("2d");
			if (!ctx) throw new Error("no 2d context");
			ctx.drawImage(bitmap, 0, 0);
			const px = ctx.getImageData(
				Math.round(bitmap.width / 2),
				Math.round(bitmap.height * 0.9),
				1,
				1
			).data;
			return [px[0], px[1], px[2]];
		}

		it("counts every slide of a vertical stack, in reading order", async () => {
			const { screen } = await mount({ content: STACK });
			const counter = screen.getByTestId("slides-counter");
			await expect.element(counter).toHaveTextContent("1 / 4");
			const next = screen.getByRole("button", { name: "Next slide" });
			for (const n of [2, 3, 4]) {
				await next.click();
				await expect.element(counter).toHaveTextContent(`${n} / 4`);
			}
			await screen.getByRole("button", { name: "Previous slide" }).click();
			await expect.element(counter).toHaveTextContent("3 / 4");
		});

		it("exports one PDF page per slide, stack slides included, in order", async () => {
			const blobs: Blob[] = [];
			const create = vi.spyOn(URL, "createObjectURL").mockImplementation((b) => {
				blobs.push(b as Blob);
				return "blob:test";
			});
			const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
			const { screen } = await mount({ content: STACK });
			await expect.element(screen.getByTestId("slides-counter")).toHaveTextContent("1 / 4");
			await startImagePdf(screen);
			await vi.waitFor(() => expect(blobs.length).toBe(1), { timeout: 60_000 });
			const bytes = new Uint8Array(await blobs[0].arrayBuffer());
			expect(new TextDecoder("latin1").decode(bytes)).toContain("/Count 4");
			const pages = pagesOf(bytes);
			expect(pages.length).toBe(4);
			const [red, green, blue, yellow] = await Promise.all(pages.map(centre));
			expect(red[0]).toBeGreaterThan(200);
			expect(red[1]).toBeLessThan(60);
			expect(green[1]).toBeGreaterThan(200);
			expect(green[0]).toBeLessThan(60);
			expect(blue[2]).toBeGreaterThan(200);
			expect(blue[0]).toBeLessThan(60);
			expect(yellow[0]).toBeGreaterThan(200);
			expect(yellow[1]).toBeGreaterThan(200);
			expect(yellow[2]).toBeLessThan(80);
			create.mockRestore();
			click.mockRestore();
		}, 90_000);

		const LONG = Array.from({ length: 30 }, (_, i) => `<section>slide ${i + 1}</section>`).join("");
		const hiddenFrames = () => document.querySelectorAll("iframe[aria-hidden='true']").length;

		it("cancels a running export from the Cancel control and leaves nothing behind", async () => {
			const create = vi.spyOn(URL, "createObjectURL");
			const { screen } = await mount({ content: LONG });
			await expect.element(screen.getByTestId("slides-counter")).toHaveTextContent("1 / 30");
			await startImagePdf(screen);
			await screen.getByRole("button", { name: "Cancel PDF" }).click();
			await expect.element(screen.getByRole("button", { name: "PDF", exact: true })).toBeEnabled();
			await vi.waitFor(() => expect(hiddenFrames()).toBe(0));
			expect(create).not.toHaveBeenCalled();
			// No error is shown for a cancel
			expect(screen.baseElement.querySelector("[role=alert]")).toBeNull();
			create.mockRestore();
		}, 60_000);

		it("stops the export when the panel goes away", async () => {
			const create = vi.spyOn(URL, "createObjectURL");
			const { screen } = await mount({ content: LONG });
			await expect.element(screen.getByTestId("slides-counter")).toHaveTextContent("1 / 30");
			await startImagePdf(screen);
			await vi.waitFor(() => expect(hiddenFrames()).toBe(1));
			screen.unmount();
			await vi.waitFor(() => expect(hiddenFrames()).toBe(0));
			await new Promise((r) => setTimeout(r, 500));
			expect(create).not.toHaveBeenCalled();
			create.mockRestore();
		}, 60_000);
	});

	it("waits for a changing deck to settle before rebuilding the frame", async () => {
		const { screen, iframe } = await mount({ content: "# One\n\n---\n\n# Two\n" });
		const first = iframe.srcdoc;
		await screen.rerender({ content: "# One\n\n---\n\n# Two\n\n---\n\n# Three\n" });
		await screen.rerender({
			content: "# One\n\n---\n\n# Two\n\n---\n\n# Three\n\n---\n\n# Four\n",
		});
		expect(document.querySelector("iframe")?.srcdoc).toBe(first);
		await vi.waitFor(() => expect(document.querySelector("iframe")?.srcdoc).not.toBe(first), {
			timeout: 5000,
		});
		expect(document.querySelector("iframe")?.srcdoc).toContain("Four");
	});

	describe("math", () => {
		const MATH = "<section>Energy: $E=mc^2$ costs $5 and $10 \\[x^2\\]</section>";

		it("renders formulas before the frame is built, with the fonts inline", async () => {
			const { iframe } = await mount({ content: MATH });
			const markup = iframe.srcdoc.slice(iframe.srcdoc.indexOf('<div class="reveal">'));
			expect(markup).toContain('<span class="katex">');
			expect(markup).toContain("katex-display");
			expect(markup).toContain("costs $5 and $10");
			expect(iframe.srcdoc).toContain("data:font/woff2;base64,");
			expect(iframe.srcdoc).not.toMatch(/url\(fonts\//);
		});

		it("builds a deck that is still half written (an open formula stays text)", async () => {
			const { iframe, screen } = await mount({ content: "<section>so $$x^2 + \\frac{1</section>" });
			expect(iframe.srcdoc).toContain("so $$x^2");
			await expect.element(screen.getByTestId("slides-counter")).toHaveTextContent("1 / 1");
		});

		it("draws the formula into the picture PDF", async () => {
			const blobs: Blob[] = [];
			const create = vi.spyOn(URL, "createObjectURL").mockImplementation((b) => {
				blobs.push(b as Blob);
				return "blob:test";
			});
			const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
			const { screen } = await mount({
				content: '<section style="font-size:120px;padding:80px">$$\\int_0^1 x\\,dx$$</section>',
			});
			await expect.element(screen.getByTestId("slides-counter")).toHaveTextContent("1 / 1");
			await startImagePdf(screen);
			await vi.waitFor(() => expect(blobs.length).toBe(1), { timeout: 60_000 });
			const bytes = new Uint8Array(await blobs[0].arrayBuffer());
			const start = bytes.findIndex(
				(b, i) => b === 0xff && bytes[i + 1] === 0xd8 && bytes[i + 2] === 0xff
			);
			const bitmap = await createImageBitmap(
				new Blob([bytes.slice(start)], { type: "image/jpeg" })
			);
			const canvas = document.createElement("canvas");
			canvas.width = bitmap.width;
			canvas.height = bitmap.height;
			const ctx = canvas.getContext("2d");
			if (!ctx) throw new Error("no 2d context");
			ctx.drawImage(bitmap, 0, 0);
			const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
			let dark = 0;
			for (let i = 0; i < data.length; i += 4) if (data[i] < 90 && data[i + 1] < 90) dark++;
			expect(dark).toBeGreaterThan(500);
			create.mockRestore();
			click.mockRestore();
		}, 90_000);
	});

	describe("the PDF control", () => {
		const realFetch = globalThis.fetch;
		afterEach(() => {
			vi.stubGlobal("fetch", realFetch);
			vi.restoreAllMocks();
		});

		function stubServer(available: boolean, pdf?: (body: Record<string, unknown>) => Response) {
			const calls: { url: string; init?: RequestInit }[] = [];
			vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
				calls.push({ url: String(url), init });
				if (String(url).endsWith("/api/v2/slides/pdf") && !init?.method) {
					return new Response(JSON.stringify({ available }), { status: 200 });
				}
				if (String(url).endsWith("/api/v2/slides/pdf") && init?.method === "POST") {
					return pdf?.(JSON.parse(String(init.body))) ?? new Response("nope", { status: 500 });
				}
				return realFetch(url, init);
			});
			return calls;
		}

		function captureForm() {
			const sent: {
				action: string;
				target: string;
				enctype: string;
				fields: Record<string, string>;
			}[] = [];
			vi.spyOn(HTMLFormElement.prototype, "submit").mockImplementation(function (
				this: HTMLFormElement
			) {
				const fields: Record<string, string> = {};
				for (const el of Array.from(this.elements)) {
					const input = el as HTMLInputElement;
					fields[input.name] = input.value;
				}
				sent.push({
					action: this.getAttribute("action") ?? "",
					target: this.target,
					enctype: this.enctype,
					fields,
				});
			});
			return sent;
		}

		it("opens the print tab by default where the server cannot make the PDF", async () => {
			stubServer(false);
			const sent = captureForm();
			const { screen } = await mount({ content: "<section>One</section><section>Two</section>" });
			await expect.element(screen.getByTestId("slides-counter")).toHaveTextContent("1 / 2");
			await screen.getByRole("button", { name: "PDF", exact: true }).click();
			await vi.waitFor(() => expect(sent.length).toBe(1));
			expect(sent[0].action).toContain("/api/v2/slides/print?print-pdf");
			expect(sent[0].target).toBe("_blank");
			expect(sent[0].enctype).toBe("multipart/form-data");
			expect(sent[0].fields.content).toContain("<section>One</section>");
			expect(sent[0].fields.notes).toBe("0");
			expect(sent[0].fields.labelPrint).toBe("Print or save as PDF");
			expect(sent[0].fields.labelHint).toContain("background graphics");
		});

		it("prints with notes from the menu, and lists only what this deployment can do", async () => {
			stubServer(false);
			const sent = captureForm();
			const { screen } = await mount({ content: "<section>One</section>" });
			await expect.element(screen.getByTestId("slides-counter")).toHaveTextContent("1 / 1");
			await screen.getByRole("button", { name: "More ways to make a PDF" }).click();
			const items = Array.from(screen.baseElement.querySelectorAll("[role=menuitem]")).map((e) =>
				(e.textContent ?? "").replace(/\s+/g, " ").trim()
			);
			expect(items).toEqual([
				"Print or save as PDF",
				"Print with speaker notes",
				"Download PDF as pictures Text in it cannot be selected",
			]);
			await screen.getByRole("menuitem", { name: "Print with speaker notes" }).click();
			await vi.waitFor(() => expect(sent.length).toBe(1));
			expect(sent[0].fields.notes).toBe("1");
		});

		it("makes the PDF on the server by default where it can, and offers it first in the menu", async () => {
			const blobs: Blob[] = [];
			vi.spyOn(URL, "createObjectURL").mockImplementation((b) => {
				blobs.push(b as Blob);
				return "blob:test";
			});
			vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
			const calls = stubServer(true, (body) => {
				expect(body.content).toContain("<h1>Quarterly review</h1>");
				return new Response("%PDF-1.7 vector", { status: 200 });
			});
			const sent = captureForm();
			const { screen } = await mount({ content: "<section><h1>Quarterly review</h1></section>" });
			await expect.element(screen.getByTestId("slides-counter")).toHaveTextContent("1 / 1");
			await vi.waitFor(() => expect(calls.some((c) => !c.init?.method)).toBe(true));
			await screen.getByRole("button", { name: "More ways to make a PDF" }).click();
			const first = screen.baseElement.querySelector("[role=menuitem]");
			expect(first?.textContent?.trim()).toBe("Download PDF");
			await screen.getByRole("button", { name: "More ways to make a PDF" }).click();
			await screen.getByRole("button", { name: "PDF", exact: true }).click();
			await vi.waitFor(() => expect(blobs.length).toBe(1));
			expect(await blobs[0].text()).toBe("%PDF-1.7 vector");
			expect(sent.length).toBe(0);
		});

		it("waits for the server's answer before the PDF button can be used, so an early click never opens the print tab", async () => {
			let answer: (r: Response) => void = () => {};
			const posts: string[] = [];
			vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
				if (!String(url).endsWith("/api/v2/slides/pdf")) return realFetch(url, init);
				if (init?.method === "POST") {
					posts.push(String(url));
					return new Response("%PDF-1.7 vector", { status: 200 });
				}
				return new Promise<Response>((resolve) => (answer = resolve));
			});
			vi.spyOn(URL, "createObjectURL").mockImplementation(() => "blob:test");
			vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
			const sent = captureForm();
			const { screen } = await mount({ content: "<section>One</section>" });
			await expect.element(screen.getByTestId("slides-counter")).toHaveTextContent("1 / 1");
			// The probe is still out: the button is not there to click yet
			await expect.element(screen.getByRole("button", { name: "PDF", exact: true })).toBeDisabled();
			expect(sent.length).toBe(0);
			answer(new Response(JSON.stringify({ available: true }), { status: 200 }));
			await expect.element(screen.getByRole("button", { name: "PDF", exact: true })).toBeEnabled();
			await screen.getByRole("button", { name: "PDF", exact: true }).click();
			await vi.waitFor(() => expect(posts.length).toBe(1));
			expect(sent.length).toBe(0);
		});

		it("lets the print tab take over when the server's answer never comes", async () => {
			vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
				if (String(url).endsWith("/api/v2/slides/pdf") && !init?.method) {
					throw new TypeError("network down");
				}
				return realFetch(url, init);
			});
			const sent = captureForm();
			const { screen } = await mount({ content: "<section>One</section>" });
			await expect.element(screen.getByTestId("slides-counter")).toHaveTextContent("1 / 1");
			await expect.element(screen.getByRole("button", { name: "PDF", exact: true })).toBeEnabled();
			await screen.getByRole("button", { name: "PDF", exact: true }).click();
			await vi.waitFor(() => expect(sent.length).toBe(1));
		});

		it("says so when the server cannot make it, and the print tab is still there", async () => {
			stubServer(true);
			const { screen } = await mount({ content: "<section>One</section>" });
			await expect.element(screen.getByTestId("slides-counter")).toHaveTextContent("1 / 1");
			await vi.waitFor(async () => {
				await screen.getByRole("button", { name: "PDF", exact: true }).click();
				expect(screen.baseElement.querySelector("[role=alert]")).toBeTruthy();
			});
			expect(screen.baseElement.querySelector("[role=alert]")?.textContent).toContain(
				"Try Print or save as PDF"
			);
			await expect.element(screen.getByRole("button", { name: "PDF", exact: true })).toBeEnabled();
		});

		it("can cancel the server's PDF", async () => {
			let release: (r: Response) => void = () => {};
			vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
				if (String(url).endsWith("/api/v2/slides/pdf") && !init?.method) {
					return new Response(JSON.stringify({ available: true }), { status: 200 });
				}
				if (!String(url).endsWith("/api/v2/slides/pdf")) return realFetch(url, init);
				return new Promise<Response>((resolve, reject) => {
					release = resolve;
					init?.signal?.addEventListener("abort", () =>
						reject(new DOMException("aborted", "AbortError"))
					);
				});
			});
			const { screen } = await mount({ content: "<section>One</section>" });
			await expect.element(screen.getByTestId("slides-counter")).toHaveTextContent("1 / 1");
			await vi.waitFor(async () => {
				await screen.getByRole("button", { name: "PDF", exact: true }).click();
				await expect.element(screen.getByRole("button", { name: "Cancel PDF" })).toBeVisible();
			});
			await screen.getByRole("button", { name: "Cancel PDF" }).click();
			await expect.element(screen.getByRole("button", { name: "PDF", exact: true })).toBeEnabled();
			expect(screen.baseElement.querySelector("[role=alert]")).toBeNull();
			release(new Response(""));
		});
	});
});
