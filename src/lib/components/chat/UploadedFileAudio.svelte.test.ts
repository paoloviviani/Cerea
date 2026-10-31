import UploadedFile from "./UploadedFile.svelte";
import { render } from "vitest-browser-svelte";
import { page as browserPage } from "@vitest/browser/context";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { MessageFile } from "$lib/types/Message";

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
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL) => {
			fetched.push(String(input));
			return new Response("Good morning. This is the transcript.", { status: 200 });
		})
	);
});

afterEach(() => {
	vi.unstubAllGlobals();
	document.body.innerHTML = "";
});

const stored: MessageFile = {
	type: "hash",
	value: "audiosha",
	mime: "audio/mpeg",
	name: "standup.mp3",
	extracted: { value: "textsha", pages: 0 },
	audio: { durationSeconds: 205, language: "en" },
};

describe("an audio attachment in the conversation", () => {
	it("is a chip with an audio badge and the duration", async () => {
		render(UploadedFile, { file: stored, canClose: false });
		await expect.element(browserPage.getByTestId("audio-badge")).toHaveTextContent(/audio/i);
		await expect.element(browserPage.getByTestId("audio-duration")).toHaveTextContent("3:25");
		await expect.element(browserPage.getByText("standup.mp3")).toBeVisible();
		// Nothing is fetched until the chip is opened.
		expect(fetched).toEqual([]);
	});

	it("opens a panel with a player on the stored file and the transcript", async () => {
		render(UploadedFile, { file: stored, canClose: false });
		await browserPage.getByRole("button").first().click();

		const panel = browserPage.getByTestId("audio-panel");
		await expect.element(panel).toBeVisible();
		await expect
			.element(browserPage.getByTestId("audio-transcript"))
			.toHaveTextContent("Good morning. This is the transcript.");
		const audio = document.querySelector("audio");
		expect(audio?.getAttribute("src")).toBe("/conversation/c1/output/audiosha");
		expect(audio?.hasAttribute("controls")).toBe(true);
		expect(fetched).toEqual(["/conversation/c1/output/textsha"]);
	});

	it("says why there is no transcript, when there is none", async () => {
		const failed: MessageFile = {
			type: "hash",
			value: "audiosha",
			mime: "audio/mpeg",
			name: "standup.mp3",
			extractionError: { kind: "no-reader", reason: "No transcription model is set up." },
		};
		render(UploadedFile, { file: failed, canClose: false });
		await browserPage.getByRole("button").first().click();
		await expect.element(browserPage.getByText("No transcription model is set up.")).toBeVisible();
		expect(fetched).toEqual([]);
	});

	it("is a plain chip, with no panel, while still in the composer", async () => {
		const pending: MessageFile = {
			type: "base64",
			value: "AAAA",
			mime: "audio/wav",
			name: "memo.wav",
		};
		render(UploadedFile, { file: pending, canClose: false });
		await expect.element(browserPage.getByTestId("audio-badge")).toBeVisible();
		await browserPage.getByRole("button").first().click();
		expect(document.querySelector("[data-testid=audio-panel]")).toBeNull();
	});
});
