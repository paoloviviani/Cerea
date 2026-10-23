import FileArtifactView from "./FileArtifactView.svelte";
import UploadedFile from "./UploadedFile.svelte";
import { render } from "vitest-browser-svelte";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { tick } from "svelte";
import { sidePane } from "$lib/stores/sidePane.svelte";
import { minimalPdf } from "$lib/utils/minimalPdf";
import deckUrl from "../../server/office/fixtures/hello.pptx?url";
const carlitoUrl = "/fonts/office/Carlito-Regular.ttf";

const state = vi.hoisted(() => ({
	data: { officePreviewEnabled: false } as Record<string, unknown>,
}));
vi.mock("$app/state", () => ({
	page: {
		get data() {
			return state.data;
		},
		url: new URL("http://localhost/conversation/c1"),
		params: { id: "c1" },
	},
}));

const PDF = minimalPdf(1);
let calls: string[] = [];
let previewStatus = 200;

beforeEach(() => {
	sidePane.reset();
	calls = [];
	previewStatus = 200;
	state.data = { officePreviewEnabled: false };
	const real = globalThis.fetch;
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			calls.push(url);
			if (url.includes("/preview")) {
				return previewStatus === 200
					? new Response(PDF as unknown as BodyInit, {
							headers: { "Content-Type": "application/pdf" },
						})
					: new Response(JSON.stringify({ message: "The converter is busy; try again shortly." }), {
							status: previewStatus,
						});
			}
			if (url.includes("/fonts/office/")) return real(carlitoUrl);
			return real(deckUrl);
		})
	);
});
afterEach(() => vi.unstubAllGlobals());

const version = (name: string) => ({ name, size: 100, sha256: "abc", version: 1, messageId: "m" });
const open = (name: string) =>
	render(FileArtifactView, { version: version(name), conversationId: "c1" });

describe("file artifact view", () => {
	it("shows an Office file as the PDF the server made, when the deployment converts", async () => {
		state.data = { officePreviewEnabled: true };
		const screen = open("budget.xlsx");
		await vi.waitFor(
			() => expect(screen.baseElement.querySelectorAll('canvas[role="img"]').length).toBe(1),
			{ timeout: 30_000 }
		);
		expect(calls).toEqual(["/conversation/c1/code-execution/output/abc/preview"]);
		// Drawn in the page by pdf.js, not handed to a frame.
		expect(screen.baseElement.querySelector("iframe")).toBeNull();
	});

	it("draws that PDF the same way on a phone: canvases, not an 'Open in a new tab' dead end", async () => {
		vi.spyOn(navigator, "userAgent", "get").mockReturnValue(
			"Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36"
		);
		vi.spyOn(navigator, "maxTouchPoints", "get").mockReturnValue(5);
		state.data = { officePreviewEnabled: true };
		const screen = open("budget.xlsx");
		await vi.waitFor(
			() => expect(screen.baseElement.querySelectorAll('canvas[role="img"]').length).toBe(1),
			{ timeout: 30_000 }
		);
		expect(screen.baseElement.textContent).not.toContain("opens in the browser's PDF viewer");
		vi.restoreAllMocks();
	});

	it("draws a stored deck with the browser renderer when the converter cannot make its PDF", async () => {
		state.data = { officePreviewEnabled: true };
		previewStatus = 503;
		const screen = open("deck.pptx");
		await vi.waitFor(
			() =>
				expect(screen.baseElement.querySelectorAll('[data-testid="pptx-slides"] img')).toHaveLength(
					1
				),
			{ timeout: 20_000 }
		);
	});

	it("says why when the converter cannot make the preview", async () => {
		state.data = { officePreviewEnabled: true };
		previewStatus = 503;
		// A spreadsheet has no browser renderer to fall back to.
		const screen = open("notes.xlsx");
		await expect.element(screen.getByText("converter is busy", { exact: false })).toBeVisible();
	});

	it("keeps today's behaviour without a converter: no preview for a spreadsheet, a download card", async () => {
		const screen = open("budget.xlsx");
		await tick();
		expect(calls).toEqual([]);
		expect(screen.baseElement.querySelector('[data-kind="none"]')).not.toBeNull();
	});

	it("draws a deck in the browser without a converter, as images", async () => {
		const screen = open("deck.pptx");
		await vi.waitFor(
			() =>
				expect(screen.baseElement.querySelectorAll('[data-testid="pptx-slides"] img')).toHaveLength(
					1
				),
			{ timeout: 20_000 }
		);
		expect(calls.some((c) => c.includes("/preview"))).toBe(false);
		expect(screen.baseElement.querySelector('[data-testid="pptx-slides"] svg')).toBeNull();
	});
});

describe("an attachment", () => {
	const docx = {
		type: "hash" as const,
		name: "plan.docx",
		value: "sha1",
		mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	};

	it("is not clickable without a converter (a Word file), and opens the PDF preview with one", async () => {
		const off = render(UploadedFile, { file: docx, canClose: false });
		expect(off.baseElement.querySelector(".clickable")).toBeNull();
		off.unmount();

		state.data = { officePreviewEnabled: true };
		const on = render(UploadedFile, { file: docx, canClose: false });
		const chip = on.baseElement.querySelector(".clickable") as HTMLElement;
		expect(chip).not.toBeNull();
		chip.click();
		await vi.waitFor(() => expect(sidePane.preview?.kind).toBe("pdf"));
		expect(calls).toEqual(["/conversation/c1/output/sha1/preview?name=plan.docx"]);
		expect(sidePane.preview?.title).toBe("plan.docx");
	});

	it("opens a deck as slides without a converter", async () => {
		const deck = {
			type: "hash" as const,
			name: "deck.pptx",
			value: "sha2",
			mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
		};
		const screen = render(UploadedFile, { file: deck, canClose: false });
		(screen.baseElement.querySelector(".clickable") as HTMLElement).click();
		await vi.waitFor(() => expect(sidePane.preview?.kind).toBe("slides"), { timeout: 20_000 });
		expect(sidePane.preview?.slides).toHaveLength(1);
	});
});
