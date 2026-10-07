import { describe, it, expect, vi } from "vitest";
import { userEvent } from "@vitest/browser/context";
import { render } from "vitest-browser-svelte";
import SwatchGroup from "./SwatchGroup.svelte";

const options = [
	{ value: "blue", label: "Blue", colour: "#2563eb" },
	{ value: "teal", label: "Teal", colour: "#00786f" },
	{ value: "rose", label: "Rose", colour: "#ec003f" },
];

function mount(value = "blue") {
	const onchange = vi.fn();
	const screen = render(SwatchGroup, { label: "Accent colour", options, value, onchange });
	return { screen, onchange };
}

describe("SwatchGroup", () => {
	it("is a named radio group with one radio per option, the current one checked", async () => {
		const { screen } = mount("teal");
		await expect.element(screen.getByRole("radiogroup", { name: "Accent colour" })).toBeVisible();
		const radios = screen.getByRole("radio");
		expect(radios.elements()).toHaveLength(3);
		await expect.element(screen.getByRole("radio", { name: "Teal" })).toBeChecked();
		await expect.element(screen.getByRole("radio", { name: "Blue" })).not.toBeChecked();
		expect(screen.getByRole("radio", { name: "Teal" }).element().getAttribute("aria-checked")).toBe(
			"true"
		);
		expect(screen.getByRole("radio", { name: "Rose" }).element().getAttribute("aria-checked")).toBe(
			"false"
		);
	});

	it("paints each swatch with its own fixed colour", async () => {
		const { screen } = mount();
		const teal = screen.getByRole("radio", { name: "Teal" }).element();
		expect(getComputedStyle(teal).backgroundColor).toBe("rgb(0, 120, 111)");
	});

	it("reports a click", async () => {
		const { screen, onchange } = mount();
		await screen.getByRole("radio", { name: "Rose" }).click();
		expect(onchange).toHaveBeenCalledExactlyOnceWith("rose");
	});

	it("puts only the chosen swatch in the tab order", async () => {
		const { screen } = mount("teal");
		const tabindex = (name: string) =>
			screen.getByRole("radio", { name }).element().getAttribute("tabindex");
		expect([tabindex("Blue"), tabindex("Teal"), tabindex("Rose")]).toEqual(["-1", "0", "-1"]);
	});

	it("keeps a tab stop when the stored value is not one of the options", async () => {
		const { screen } = mount("chartreuse");
		expect(screen.getByRole("radio", { name: "Blue" }).element().getAttribute("tabindex")).toBe(
			"0"
		);
	});

	it("moves the choice with the arrow keys, wrapping at the ends", async () => {
		const { screen, onchange } = mount("blue");
		(screen.getByRole("radio", { name: "Blue" }).element() as HTMLElement).focus();
		await userEvent.keyboard("{ArrowRight}");
		expect(onchange).toHaveBeenLastCalledWith("teal");
		expect(document.activeElement).toBe(screen.getByRole("radio", { name: "Teal" }).element());

		await userEvent.keyboard("{ArrowLeft}");
		expect(onchange).toHaveBeenLastCalledWith("blue");
		// From the first, left wraps to the last.
		await userEvent.keyboard("{ArrowLeft}");
		expect(onchange).toHaveBeenLastCalledWith("rose");
		await userEvent.keyboard("{Home}");
		expect(onchange).toHaveBeenLastCalledWith("blue");
		await userEvent.keyboard("{End}");
		expect(onchange).toHaveBeenLastCalledWith("rose");
	});

	it("is reachable and operable from the keyboard alone", async () => {
		const { screen, onchange } = mount("blue");
		await userEvent.tab();
		expect(document.activeElement).toBe(screen.getByRole("radio", { name: "Blue" }).element());
		await userEvent.keyboard(" ");
		expect(onchange).toHaveBeenCalledWith("blue");
	});
});
