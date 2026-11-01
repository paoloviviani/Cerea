import UploadedFile from "./UploadedFile.svelte";
import { render } from "vitest-browser-svelte";
import { page as browserPage } from "@vitest/browser/context";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { MessageFile } from "$lib/types/Message";
import { sidePane } from "$lib/stores/sidePane.svelte";

vi.mock("$app/state", () => ({
	page: {
		data: {},
		url: new URL("http://localhost/conversation/c1"),
		params: { id: "c1" },
	},
}));

let fetched: string[] = [];

beforeEach(() => {
	fetched = [];
	sidePane.preview = null;
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL) => {
			fetched.push(String(input));
			return new Response(new Blob(["%PDF-1.4 test"]), { status: 200 });
		})
	);
});

afterEach(() => {
	vi.unstubAllGlobals();
	document.body.innerHTML = "";
});

describe("a PDF attachment", () => {
	it("opens the side pane's PDF preview with the stored file's bytes", async () => {
		const file: MessageFile = {
			type: "hash",
			value: "pdfsha",
			mime: "application/pdf",
			name: "report.pdf",
		};
		render(UploadedFile, { file, canClose: false });
		await browserPage.getByRole("button").first().click();
		await vi.waitFor(() => expect(sidePane.preview?.kind).toBe("pdf"));
		expect(fetched).toEqual(["/conversation/c1/output/pdfsha"]);
		expect(sidePane.preview?.title).toBe("report.pdf");
		expect(sidePane.preview?.content).toMatch(/^data:application\/pdf/);
	});

	it("previews a file still in the composer without fetching", async () => {
		const file: MessageFile = {
			type: "base64",
			value: btoa("%PDF-1.4 test"),
			mime: "application/pdf",
			name: "draft.pdf",
		};
		render(UploadedFile, { file, canClose: false });
		await browserPage.getByRole("button").first().click();
		await vi.waitFor(() => expect(sidePane.preview?.kind).toBe("pdf"));
		expect(fetched).toEqual([]);
	});

	it("falls back to the download panel when the file cannot be fetched", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("gone", { status: 404 }))
		);
		const file: MessageFile = {
			type: "hash",
			value: "gonesha",
			mime: "application/pdf",
			name: "lost.pdf",
		};
		render(UploadedFile, { file, canClose: false });
		await browserPage.getByRole("button").first().click();
		await expect.element(browserPage.getByTestId("file-details")).toBeVisible();
		await expect
			.element(browserPage.getByTestId("file-download"))
			.toHaveAttribute("href", "/conversation/c1/output/gonesha");
		expect(sidePane.preview).toBeNull();
	});
});

describe("a file with no preview", () => {
	it("opens a panel with its details and a download", async () => {
		const file: MessageFile = {
			type: "hash",
			value: "zipsha",
			mime: "application/zip",
			name: "bundle.zip",
		};
		render(UploadedFile, { file, canClose: false });
		await browserPage.getByRole("button").first().click();
		await expect.element(browserPage.getByTestId("file-details")).toBeVisible();
		await expect
			.element(browserPage.getByTestId("file-details-meta"))
			.toHaveTextContent("application/zip");
		await expect
			.element(browserPage.getByTestId("file-download"))
			.toHaveAttribute("href", "/conversation/c1/output/zipsha");
		expect(sidePane.preview).toBeNull();
	});
});
