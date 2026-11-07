import SlidesView from "./SlidesView.svelte";
import { render } from "vitest-browser-svelte";
import { describe, expect, it, vi } from "vitest";

const DECK = "---\ntheme: cerea\n---\n# One\n\n---\n\n# Two\n\nNote: hi\n";

async function mount(props: Record<string, unknown> = {}) {
	const screen = render(SlidesView, { content: DECK, ...props } as never);
	await vi.waitFor(() => expect(document.querySelector("iframe")).toBeTruthy());
	const iframe = document.querySelector("iframe") as HTMLIFrameElement;
	return { screen, iframe };
}

describe("SlidesView", () => {
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
		await screen.getByRole("button", { name: "Download PDF" }).click();
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
		await screen.getByRole("button", { name: "Download PDF" }).click();
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
			await screen.getByRole("button", { name: "Download PDF" }).click();
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
			await screen.getByRole("button", { name: "Download PDF" }).click();
			await screen.getByRole("button", { name: "Cancel PDF" }).click();
			await expect.element(screen.getByRole("button", { name: "Download PDF" })).toBeEnabled();
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
			await screen.getByRole("button", { name: "Download PDF" }).click();
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
});
