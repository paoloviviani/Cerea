import FileArtifactView from "./FileArtifactView.svelte";
import { render } from "vitest-browser-svelte";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderAsync } from "docx-preview";

// The renderer is a real dependency with its own upstream tests; what is
// under test here is the wiring (and, specifically, the size re-check), so
// the module boundary is mocked, not the zip format.
vi.mock("docx-preview", () => ({
	renderAsync: vi.fn(async (_data: Blob, container: HTMLElement) => {
		container.innerHTML = '<section class="docx-wrapper"><h1>Hi</h1></section>';
	}),
}));

const OVERSIZE = 8 * 1024 * 1024 + 1;

function stubFetch(bytes: Uint8Array) {
	const realFetch = globalThis.fetch;
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response(bytes.buffer as ArrayBuffer))
	);
	return () => vi.stubGlobal("fetch", realFetch);
}

beforeEach(() => {
	vi.mocked(renderAsync).mockClear();
	vi.mocked(renderAsync).mockImplementation(async (_data: Blob, container: HTMLElement) => {
		container.innerHTML = '<section class="docx-wrapper"><h1>Hi</h1></section>';
	});
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("FileArtifactView — actual bytes, not just recorded metadata", () => {
	/**
	 * `version.size` is metadata recorded in the message at tool-call time; it
	 * is not the bytes the store actually serves. Each case below records a
	 * small size but serves oversized bytes, so only a post-fetch check on the
	 * real payload — not the pre-fetch metadata gate — can catch it.
	 */

	it("refuses an oversized pdf even though the recorded size is small", async () => {
		const restore = stubFetch(new Uint8Array(OVERSIZE));
		try {
			const screen = render(FileArtifactView, {
				version: { name: "report.pdf", size: 10, sha256: "abc", version: 1, messageId: "m1" },
				conversationId: "conv1",
			});
			await expect
				.element(screen.getByText("too large to preview", { exact: false }))
				.toBeVisible();
			expect(screen.baseElement.querySelector("iframe")).toBeNull();
		} finally {
			restore();
		}
	});

	it("refuses an oversized docx even though the recorded size is small, without rendering it", async () => {
		const restore = stubFetch(new Uint8Array(OVERSIZE));
		try {
			const screen = render(FileArtifactView, {
				version: { name: "report.docx", size: 10, sha256: "abc", version: 1, messageId: "m1" },
				conversationId: "conv1",
			});
			await expect
				.element(screen.getByText("too large to preview", { exact: false }))
				.toBeVisible();
			expect(vi.mocked(renderAsync)).not.toHaveBeenCalled();
		} finally {
			restore();
		}
	});

	it("refuses an oversized text file even though the recorded size is small", async () => {
		const restore = stubFetch(new Uint8Array(OVERSIZE));
		try {
			const screen = render(FileArtifactView, {
				version: { name: "notes.txt", size: 10, sha256: "abc", version: 1, messageId: "m1" },
				conversationId: "conv1",
			});
			await expect
				.element(screen.getByText("too large to preview", { exact: false }))
				.toBeVisible();
			expect(screen.baseElement.querySelector("pre")).toBeNull();
		} finally {
			restore();
		}
	});

	it("still previews a pdf whose recorded and actual sizes agree and are within the cap", async () => {
		const bytes = new Uint8Array([37, 80, 68, 70]);
		const restore = stubFetch(bytes);
		try {
			const screen = render(FileArtifactView, {
				version: {
					name: "report.pdf",
					size: bytes.length,
					sha256: "abc",
					version: 1,
					messageId: "m1",
				},
				conversationId: "conv1",
			});
			await vi.waitFor(() =>
				expect(
					screen.baseElement.querySelector('[data-testid="file-artifact-view"]')
				).not.toBeNull()
			);
			expect(
				screen.baseElement.querySelector('[data-testid="file-artifact-view"]')?.textContent
			).not.toContain("too large to preview");
		} finally {
			restore();
		}
	});
});
