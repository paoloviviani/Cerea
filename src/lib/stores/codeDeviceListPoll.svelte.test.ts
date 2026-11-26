import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/codeApi", async () => {
	const actual = await vi.importActual<typeof import("$lib/codeApi")>("$lib/codeApi");
	return { ...actual, listDevices: vi.fn(async () => ({ devices: [] })), loadCodeStatus: vi.fn() };
});

import { listDevices } from "$lib/codeApi";
import { codeDeviceList, useCodeDevicePoll } from "./codeDeviceList.svelte";

let hidden = false;
function setHidden(value: boolean) {
	hidden = value;
	document.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(() => {
	vi.useFakeTimers();
	hidden = false;
	Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
	codeDeviceList.devices = [];
	vi.mocked(listDevices).mockReset();
	vi.mocked(listDevices).mockResolvedValue({ devices: [] });
});
afterEach(() => {
	vi.useRealTimers();
});

describe("the shared machine-list poll", () => {
	it("asks nothing while the tab is hidden", async () => {
		const stop = useCodeDevicePoll();
		await vi.advanceTimersByTimeAsync(0);
		setHidden(true);
		vi.mocked(listDevices).mockClear();
		await vi.advanceTimersByTimeAsync(120_000);
		expect(listDevices).not.toHaveBeenCalled();
		stop();
		setHidden(false);
	});

	it("backs off to every fourth tick with no machine, unless someone waits for one", async () => {
		const stop = useCodeDevicePoll();
		await vi.advanceTimersByTimeAsync(0);
		vi.mocked(listDevices).mockClear();
		await vi.advanceTimersByTimeAsync(64_000);
		expect(vi.mocked(listDevices).mock.calls.length).toBe(2);
		stop();

		const stopFast = useCodeDevicePoll({ fast: true });
		await vi.advanceTimersByTimeAsync(0);
		vi.mocked(listDevices).mockClear();
		await vi.advanceTimersByTimeAsync(64_000);
		expect(vi.mocked(listDevices).mock.calls.length).toBe(8);
		stopFast();
	});

	it("keeps the full rate once a machine is listed", async () => {
		const box = { id: "d1", name: "box", status: "paired" } as never;
		vi.mocked(listDevices).mockResolvedValue({ devices: [box] });
		codeDeviceList.devices = [box];
		const stop = useCodeDevicePoll();
		await vi.advanceTimersByTimeAsync(0);
		vi.mocked(listDevices).mockClear();
		await vi.advanceTimersByTimeAsync(32_000);
		expect(vi.mocked(listDevices).mock.calls.length).toBe(4);
		stop();
	});
});
