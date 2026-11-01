import VoiceSection from "./VoiceSection.svelte";
import { renderWithApp } from "$lib/components/__tests__/renderWithApp";
import { page } from "@vitest/browser/context";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("$env/dynamic/public", () => ({ env: { PUBLIC_APP_NAME: "chat-ui" } }));

const calls: { url: string; init?: RequestInit }[] = [];

function stub(
	state: Record<string, unknown>,
	model: Record<string, unknown> = {
		model: "whisper-large-v3-turbo",
		source: "first-available",
		stored_model: null,
		env_model: null,
		available_models: ["whisper-large-v3-turbo", "voxtral-mini"],
	}
) {
	calls.length = 0;
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			calls.push({ url, init });
			if (url.includes("/admin/transcription")) {
				return Response.json(
					init?.method === "PUT"
						? { ...model, stored_model: JSON.parse(String(init.body)).model }
						: model
				);
			}
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
		await page.getByRole("button", { name: /save/i }).first().click();
		const patch = calls.find((call) => call.init?.method === "PATCH");
		expect(patch?.url).toContain("/api/v2/admin/dictation");
		expect(JSON.parse(String(patch?.init?.body))).toEqual({ mode: "model" });
	});

	it("says when no transcription model is available", async () => {
		stub(base, {
			model: null,
			source: "none",
			stored_model: null,
			env_model: null,
			available_models: [],
		});
		renderWithApp(VoiceSection, {});
		await expect
			.element(page.getByTestId("voice-model-state"))
			.toHaveTextContent(/no transcription model in its catalogue/);
	});

	it("shows whether audio works for the admin's own account, with the reason, and the grant hint", async () => {
		stub(base, {
			model: "voxtral-mini",
			source: "stored",
			stored_model: "voxtral-mini",
			env_model: null,
			available_models: ["whisper-large-v3-turbo"],
			account_available: false,
			account_reason: "not_granted",
		});
		renderWithApp(VoiceSection, {});
		await expect
			.element(page.getByTestId("voice-account-state"))
			.toHaveTextContent(
				/Available to your account: no — .*not granted to you in the gateway console/
			);
		await expect.element(page.getByTestId("voice-grant-hint")).toHaveTextContent(/after a reload/);
	});

	it("says yes when the model is in the admin's catalogue", async () => {
		stub(base, {
			model: "whisper-large-v3-turbo",
			source: "first-available",
			stored_model: null,
			env_model: null,
			available_models: ["whisper-large-v3-turbo"],
			account_available: true,
			account_reason: null,
		});
		renderWithApp(VoiceSection, {});
		await expect
			.element(page.getByTestId("voice-account-state"))
			.toHaveTextContent("Available to your account: yes");
	});

	it("is called Voice & audio and picks the transcription model, saved to its own route", async () => {
		stub(base);
		renderWithApp(VoiceSection, {});
		await expect.element(page.getByRole("heading", { name: "Voice & audio" })).toBeVisible();
		await page.getByTestId("transcription-model").selectOptions("voxtral-mini");
		await expect.element(page.getByTestId("save-transcription-model")).toBeEnabled();
		await page.getByTestId("save-transcription-model").click();
		await expect.poll(() => calls.some((call) => call.init?.method === "PUT")).toBe(true);
		const put = calls.find((call) => call.init?.method === "PUT");
		expect(put?.url).toContain("/api/v2/admin/transcription");
		expect(JSON.parse(String(put?.init?.body))).toEqual({ model: "voxtral-mini" });
		// Not through the Knowledge screen's route.
		expect(calls.some((call) => call.url.includes("/admin/knowledge"))).toBe(false);
	});

	it("says the legacy endpoint uses the deployment's key", async () => {
		stub({ ...base, legacyTranscription: true });
		renderWithApp(VoiceSection, {});
		await expect
			.element(page.getByTestId("voice-legacy"))
			.toHaveTextContent(/deployment's own key, not each user's token/);
	});

	it("is read-only when configuration is environment-only", async () => {
		stub({ ...base, configurable: false });
		renderWithApp(VoiceSection, {});
		await expect.element(page.getByRole("radio", { name: /Off/ })).toBeDisabled();
	});
});
