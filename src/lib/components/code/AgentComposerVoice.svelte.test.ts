/** The agent composer has the same dictation as chat: the recorder when the administrator chose the model. */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { writable } from "svelte/store";
import { page as browserPage } from "@vitest/browser/context";
import { renderWithApp } from "$lib/components/__tests__/renderWithApp";
import AgentComposer from "./AgentComposer.svelte";

vi.mock("$env/dynamic/public", () => ({
	env: { PUBLIC_APP_ASSETS: "chatui", PUBLIC_APP_NAME: "chat-ui" },
}));
vi.mock("$lib/codeApi", async (importOriginal) => ({
	...(await importOriginal<typeof import("$lib/codeApi")>()),
	listAgentCommands: async () => ({ commands: [] }),
	// The context meter reads this on mount; the test counts only its own fetches.
	getAgentGatewayUsage: async () => ({ available: false }),
}));

class FakeRecorder {
	static isTypeSupported = () => true;
	state: "inactive" | "recording" = "inactive";
	ondataavailable: ((e: { data: Blob }) => void) | null = null;
	onstop: (() => void) | null = null;
	constructor(
		public stream: unknown,
		public options: unknown
	) {}
	start() {
		this.state = "recording";
		queueMicrotask(() =>
			this.ondataavailable?.({ data: new Blob([new Uint8Array(64)], { type: "audio/webm" }) })
		);
	}
	stop() {
		this.state = "inactive";
		this.onstop?.();
	}
}
class FakeAudioContext {
	createMediaStreamSource() {
		return { connect() {} };
	}
	createAnalyser() {
		return {
			fftSize: 0,
			smoothingTimeConstant: 0,
			frequencyBinCount: 32,
			getByteFrequencyData() {},
		};
	}
	close() {}
}

let fetched: { url: string; type: string | null }[] = [];

beforeEach(() => {
	fetched = [];
	vi.stubGlobal("MediaRecorder", FakeRecorder);
	vi.stubGlobal("AudioContext", FakeAudioContext);
	Object.defineProperty(navigator, "mediaDevices", {
		configurable: true,
		value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop() {} }] })) },
	});
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			fetched.push({
				url: String(input),
				type: new Headers(init?.headers).get("content-type"),
			});
			return Response.json({ text: "run the tests again" });
		})
	);
	for (let i = localStorage.length - 1; i >= 0; i--) {
		const key = localStorage.key(i);
		if (key?.startsWith("cerea:composer-draft:")) localStorage.removeItem(key);
	}
});

afterEach(() => {
	vi.unstubAllGlobals();
	document.body.innerHTML = "";
});

function mount(transcriptionEnabled: boolean) {
	const store = writable({ directPaste: false });
	return renderWithApp(
		AgentComposer,
		{
			deviceId: "d1",
			agentId: "a1",
			agent: null,
			running: false,
			steerSupported: true,
			onsend: async () => {},
			onstop: async () => true,
			onchanged: () => {},
		},
		{
			page: { data: { transcriptionEnabled } },
			context: new Map<unknown, unknown>([["settings", { subscribe: store.subscribe }]]),
		}
	);
}

for (const [label, width] of [
	["desktop", 1200],
	["mobile", 400],
] as const) {
	describe(`AgentComposer dictation by the model (${label})`, () => {
		it("has the microphone when the model option is on, and records into the draft", async () => {
			await browserPage.viewport(width, 800);
			mount(true);
			await browserPage.getByRole("button", { name: "Start voice recording" }).click();
			await expect.element(browserPage.getByTestId("recording-timer")).toBeVisible();
			await browserPage
				.getByRole("button", { name: /confirm and transcribe|send message/i })
				.first()
				.click();
			await expect
				.poll(() => fetched.filter((f) => f.url.endsWith("/api/transcribe")).length)
				.toBe(1);
			expect(fetched[0].type).toBe("audio/webm");
			// On a touch device the recording would send; here the text lands in the box.
			await expect
				.element(browserPage.getByPlaceholder(/./).first())
				.toHaveValue("run the tests again");
		});

		it("has no microphone when the model option is off", async () => {
			await browserPage.viewport(width, 800);
			mount(false);
			expect(document.querySelector('button[aria-label="Start voice recording"]')).toBeNull();
		});
	});
}
