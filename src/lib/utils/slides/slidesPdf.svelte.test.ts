import { describe, expect, it } from "vitest";
import { exportSlidesPdf, isAbortError, PdfTooLargeError } from "./slidesPdf";

const DECK = "<section>one</section><section>two</section>";
const hiddenFrames = () => document.querySelectorAll("iframe[aria-hidden='true']").length;

describe("exportSlidesPdf limits", () => {
	it("fails with a clear error past the size cap, and removes its frame", async () => {
		await expect(exportSlidesPdf(DECK, { maxBytes: 1 })).rejects.toBeInstanceOf(PdfTooLargeError);
		expect(hiddenFrames()).toBe(0);
	});

	it("rejects with an AbortError when already aborted, without making a frame", async () => {
		const abort = new AbortController();
		abort.abort();
		const err = await exportSlidesPdf(DECK, { signal: abort.signal }).catch((e) => e);
		expect(isAbortError(err)).toBe(true);
		expect(hiddenFrames()).toBe(0);
	});

	it("stops when aborted part-way and cleans up", async () => {
		const abort = new AbortController();
		const long = Array.from({ length: 20 }, (_, i) => `<section>${i}</section>`).join("");
		const run = exportSlidesPdf(long, {
			signal: abort.signal,
			onProgress: (done) => {
				if (done === 2) abort.abort();
			},
		});
		const err = await run.catch((e) => e);
		expect(isAbortError(err)).toBe(true);
		expect(hiddenFrames()).toBe(0);
	}, 60_000);

	it("refuses a deck with more slides than a PDF may have", async () => {
		const many = Array.from({ length: 201 }, (_, i) => `<section>${i}</section>`).join("");
		await expect(exportSlidesPdf(many)).rejects.toBeInstanceOf(PdfTooLargeError);
		expect(hiddenFrames()).toBe(0);
	}, 60_000);
});
