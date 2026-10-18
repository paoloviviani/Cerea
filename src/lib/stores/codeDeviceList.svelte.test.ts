import { beforeEach, describe, expect, it, vi } from "vitest";

const listDevices = vi.fn();
vi.mock("$lib/codeApi", () => ({
	CodeApiError: class extends Error {
		status = 0;
	},
	listDevices: (...a: unknown[]) => listDevices(...a),
	loadCodeStatus: vi.fn(),
}));
vi.mock("$lib/utils/appResume", () => ({ onAppResume: () => () => {} }));
vi.mock("$lib/stores/codeReauth.svelte", () => ({
	codeReauth: { required: false },
	onCodeReauth: () => {},
}));

import { codeDeviceList, dropCodeDevice, refreshCodeDevices } from "./codeDeviceList.svelte";

const dev = (id: string) => ({ id }) as never;

describe("codeDeviceList", () => {
	beforeEach(() => {
		listDevices.mockReset();
		codeDeviceList.devices = [dev("a"), dev("b")];
	});

	it("drops a revoked machine at once", () => {
		dropCodeDevice("a");
		expect(codeDeviceList.devices.map((d) => d.id)).toEqual(["b"]);
	});

	it("a read in flight when a machine is dropped cannot bring its card back", async () => {
		let resolve!: (v: unknown) => void;
		listDevices.mockReturnValueOnce(new Promise((r) => (resolve = r)));
		const pending = refreshCodeDevices();
		dropCodeDevice("a");
		resolve({ devices: [dev("a"), dev("b")] });
		await pending;
		expect(codeDeviceList.devices.map((d) => d.id)).toEqual(["b"]);
	});

	it("a failing read keeps the list", async () => {
		listDevices.mockRejectedValueOnce(new Error("boom"));
		await refreshCodeDevices();
		expect(codeDeviceList.devices).toHaveLength(2);
	});
});
