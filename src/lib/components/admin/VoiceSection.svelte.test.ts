import VoiceSection from "./VoiceSection.svelte";
import { renderWithApp } from "$lib/components/__tests__/renderWithApp";
import { page } from "@vitest/browser/context";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("$env/dynamic/public", () => ({ env: { PUBLIC_APP_NAME: "chat-ui" } }));

const calls: { url: string; init?: RequestInit }[] = [];

function stub(state: Record<string, unknown>) {
	calls.length = 0;
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			calls.push({ url: String(input), init });
			return Response.json(init?.method === "PATCH" ? { mode: "model" } : state);
		})
	);
}

afterEach(() => {
	vi.unstubAllGlobals();
	document.body.innerHTML = "";
});

const base = {
	mode: "browser",
	available: ["browser", "model", "off"],
	transcriptionModel: "whisper-large-v3-turbo",
	transcriptionSource: "first-available",
	legacyTranscription: false,
	configurable: true,
};

describe("Administration -> Voice", () => {
	it("offers Browser, Transcription model and Off, with the privacy wording of each", async () => {
		stub(base);
		renderWithApp(VoiceSection, {});
		await expect.element(page.getByText("Transcription model", { exact: true })).toBeVisible();
		await expect.element(page.getByText("Browser", { exact: true })).toBeVisible();
		await expect.element(page.getByText("Off", { exact: true })).toBeVisible();
		await expect.element(page.getByText(/may send it to the browser vendor/i)).toBeVisible();
		await expect.element(page.getByText(/not screened by redaction/i)).toBeVisible();
		await expect
			.element(page.getByTestId("voice-model-state"))
			.toHaveTextContent("whisper-large-v3-turbo");
	});

	it("saves the chosen mode", async () => {
		stub(base);
		renderWithApp(VoiceSection, {});
		await page.getByRole("radio", { name: /Transcription model/ }).click();
		await page.getByRole("button", { name: /save/i }).click();
		const patch = calls.find((call) => call.init?.method === "PATCH");
		expect(patch?.url).toContain("/api/v2/admin/dictation");
		expect(JSON.parse(String(patch?.init?.body))).toEqual({ mode: "model" });
	});

	it("says when no transcription model is available", async () => {
		stub({ ...base, transcriptionModel: null, transcriptionSource: "none" });
		renderWithApp(VoiceSection, {});
		await expect
			.element(page.getByTestId("voice-model-state"))
			.toHaveTextContent(/No transcription model is available/);
	});

	it("is read-only when configuration is environment-only", async () => {
		stub({ ...base, configurable: false });
		renderWithApp(VoiceSection, {});
		await expect.element(page.getByRole("radio", { name: /Off/ })).toBeDisabled();
	});
});
