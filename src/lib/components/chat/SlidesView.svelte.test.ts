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

	it("puts the organisation logo into the deck", async () => {
		const logo = "data:image/png;base64,iVBORw0KGgo=";
		const { iframe } = await mount({ org: { logo } });
		expect(iframe.srcdoc).toContain(`class="cerea-logo"`);
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
});
