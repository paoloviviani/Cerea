import VoiceRecorder from "./VoiceRecorder.svelte";
import { render } from "vitest-browser-svelte";
import { page as browserPage } from "@vitest/browser/context";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MAX_RECORDING_SECONDS } from "$lib/utils/dictation";

/** A MediaRecorder that records whatever the test tells it to. */
class FakeRecorder {
	static instances: FakeRecorder[] = [];
	static isTypeSupported = () => true;
	state: "inactive" | "recording" = "inactive";
	ondataavailable: ((e: { data: Blob }) => void) | null = null;
	onstop: (() => void) | null = null;
	constructor(
		public stream: unknown,
		public options: unknown
	) {
		FakeRecorder.instances.push(this);
	}
	start() {
		this.state = "recording";
	}
	emit(bytes: number) {
		this.ondataavailable?.({ data: new Blob([new Uint8Array(bytes)], { type: "audio/webm" }) });
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

const tracks = { stop: vi.fn() };

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
	FakeRecorder.instances = [];
	tracks.stop.mockClear();
	vi.stubGlobal("MediaRecorder", FakeRecorder);
	vi.stubGlobal("AudioContext", FakeAudioContext);
	Object.defineProperty(navigator, "mediaDevices", {
		configurable: true,
		value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [tracks] })) },
	});
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	document.body.innerHTML = "";
});

const flush = async () => {
	for (let i = 0; i < 5; i++) await Promise.resolve();
};

function mount(over: Record<string, unknown> = {}) {
	const handlers = {
		oncancel: vi.fn(),
		onconfirm: vi.fn(),
		onsend: vi.fn(),
		onerror: vi.fn(),
		onnotice: vi.fn(),
	};
	render(VoiceRecorder, {
		isTranscribing: false,
		isTouchDevice: false,
		...handlers,
		...over,
	} as never);
	return handlers;
}

describe("the microphone recorder", () => {
	it("records with MediaRecorder and shows a timer that counts up", async () => {
		mount();
		await flush();
		expect(FakeRecorder.instances).toHaveLength(1);
		expect(FakeRecorder.instances[0].state).toBe("recording");
		await expect.element(browserPage.getByTestId("recording-timer")).toHaveTextContent("0:00");
		await vi.advanceTimersByTimeAsync(7_000);
		await expect.element(browserPage.getByTestId("recording-timer")).toHaveTextContent("0:07");
	});

	it("hands the recording over on confirm, and lets go of the microphone", async () => {
		const h = mount();
		await flush();
		FakeRecorder.instances[0].emit(1000);
		await browserPage.getByRole("button", { name: /confirm and transcribe/i }).click();
		await flush();
		expect(h.onconfirm).toHaveBeenCalledTimes(1);
		const blob = h.onconfirm.mock.calls[0][0] as Blob;
		expect(blob.size).toBe(1000);
		expect(blob.type).toBe("audio/webm");
		expect(tracks.stop).toHaveBeenCalled();
	});

	it("sends straight away on a touch device", async () => {
		const h = mount({ isTouchDevice: true });
		await flush();
		FakeRecorder.instances[0].emit(10);
		await browserPage.getByRole("button", { name: /send message/i }).click();
		await flush();
		expect(h.onsend).toHaveBeenCalledTimes(1);
		expect(h.onconfirm).not.toHaveBeenCalled();
	});

	it("says so when nothing was recorded", async () => {
		const h = mount();
		await flush();
		await browserPage.getByRole("button", { name: /confirm and transcribe/i }).click();
		await flush();
		expect(h.onerror).toHaveBeenCalledWith(expect.stringMatching(/nothing was recorded/i));
		expect(h.onconfirm).not.toHaveBeenCalled();
	});

	it("stops at the time limit, says so, and transcribes what there is", async () => {
		const h = mount();
		await flush();
		FakeRecorder.instances[0].emit(500);
		vi.advanceTimersByTime((MAX_RECORDING_SECONDS + 1) * 1000);
		await flush();
		expect(h.onnotice).toHaveBeenCalledWith(expect.stringMatching(/stopped at 5 minutes/i));
		expect(h.onconfirm).toHaveBeenCalledTimes(1);
	});

	it("refuses a recording past the size the gateway takes", async () => {
		const h = mount();
		await flush();
		FakeRecorder.instances[0].emit(25 * 1024 * 1024 + 1);
		await browserPage.getByRole("button", { name: /confirm and transcribe/i }).click();
		await flush();
		expect(h.onerror).toHaveBeenCalledWith(expect.stringMatching(/too long to transcribe/i));
		expect(h.onconfirm).not.toHaveBeenCalled();
	});

	it("reports a blocked microphone", async () => {
		Object.defineProperty(navigator, "mediaDevices", {
			configurable: true,
			value: {
				getUserMedia: vi.fn(async () => {
					throw new DOMException("no", "NotAllowedError");
				}),
			},
		});
		const h = mount();
		await flush();
		expect(h.onerror).toHaveBeenCalledWith(expect.stringMatching(/microphone blocked/i));
	});
});
