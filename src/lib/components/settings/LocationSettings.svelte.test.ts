import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { userEvent } from "@vitest/browser/context";
import LocationSettings from "./LocationSettings.svelte";
import type { LocationMode } from "$lib/utils/location";

type Handlers = {
	success: (p: { coords: { latitude: number; longitude: number; accuracy: number } }) => void;
	error: (e: { code: number }) => void;
};

let getCurrentPosition: ReturnType<typeof vi.fn>;
const original = Object.getOwnPropertyDescriptor(Navigator.prototype, "geolocation");

function mockGeolocation(behaviour: "ok" | "denied" | "unavailable") {
	getCurrentPosition = vi.fn((success: Handlers["success"], error: Handlers["error"]) => {
		if (behaviour === "ok") {
			success({ coords: { latitude: 45.0703, longitude: 7.6869, accuracy: 30 } });
		} else error({ code: behaviour === "denied" ? 1 : 2 });
	});
	Object.defineProperty(navigator, "geolocation", {
		configurable: true,
		value: { getCurrentPosition },
	});
}

beforeEach(() => mockGeolocation("ok"));
afterEach(() => {
	if (original) Object.defineProperty(Navigator.prototype, "geolocation", original);
	Reflect.deleteProperty(navigator, "geolocation");
});

// Like the settings page, apply a mode change by passing the new prop back in.
function mountControlled(mode: LocationMode = "off") {
	const onchange = vi.fn((next: { mode?: LocationMode }) => {
		if (next.mode) void screen.rerender({ mode: next.mode });
	});
	const screen = render(LocationSettings, { mode, place: "", onchange });
	return { screen, onchange };
}

describe("LocationSettings", () => {
	it("is off by default, says where the location goes, and does not ask the browser", async () => {
		const onchange = vi.fn();
		const screen = render(LocationSettings, { mode: "off", place: "", onchange });
		const select = screen.getByRole("combobox", { name: "Share my location" });
		await expect.element(select).toHaveValue("off");
		expect(select.element().tagName).toBe("SELECT");
		expect(
			[...select.element().querySelectorAll("option")].map((o) => o.textContent?.trim())
		).toEqual(["Off", "A place I type", "From this device"]);
		await expect
			.element(screen.getByText(/sent to the model provider with every message/))
			.toBeVisible();
		expect(getCurrentPosition).not.toHaveBeenCalled();
	});

	it("choosing a typed place reports the mode without asking the browser, and takes text", async () => {
		const onchange = vi.fn();
		const screen = render(LocationSettings, { mode: "off", place: "", onchange });
		await userEvent.selectOptions(
			screen.getByRole("combobox", { name: "Share my location" }).element(),
			"place"
		);
		expect(onchange).toHaveBeenCalledWith({ mode: "place" });
		expect(getCurrentPosition).not.toHaveBeenCalled();

		const typed = render(LocationSettings, { mode: "place", place: "", onchange });
		const input = typed.getByRole("textbox");
		await userEvent.type(input, "Torino");
		expect(onchange).toHaveBeenLastCalledWith({ place: expect.stringMatching(/^[A-Za-z]+$/) });
		expect(input.element().getAttribute("maxlength")).toBe("100");
	});

	it("asks for the browser's permission only when 'From this device' is chosen", async () => {
		const { screen, onchange } = mountControlled();
		expect(getCurrentPosition).not.toHaveBeenCalled();
		await userEvent.selectOptions(
			screen.getByRole("combobox", { name: "Share my location" }).element(),
			"device"
		);
		expect(onchange).toHaveBeenCalledWith({ mode: "device" });
		expect(getCurrentPosition).toHaveBeenCalledTimes(1);
		await expect.element(screen.getByText("Location available.")).toBeVisible();
	});

	it("says so when permission is denied, and keeps the choice", async () => {
		mockGeolocation("denied");
		const { screen, onchange } = mountControlled();
		await userEvent.selectOptions(
			screen.getByRole("combobox", { name: "Share my location" }).element(),
			"device"
		);
		await expect.element(screen.getByRole("alert")).toHaveTextContent(/permission was denied/);
		expect(onchange).toHaveBeenCalledWith({ mode: "device" });
		expect(onchange).not.toHaveBeenCalledWith({ mode: "off" });
	});

	it("says so when the device has no location", async () => {
		mockGeolocation("unavailable");
		const { screen } = mountControlled();
		await userEvent.selectOptions(
			screen.getByRole("combobox", { name: "Share my location" }).element(),
			"device"
		);
		await expect.element(screen.getByRole("alert")).toHaveTextContent(/unavailable/);
	});
});
