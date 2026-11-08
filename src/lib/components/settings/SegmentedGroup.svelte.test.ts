import { describe, it, expect, vi } from "vitest";
import { userEvent } from "@vitest/browser/context";
import { render } from "vitest-browser-svelte";
import SegmentedGroup from "./SegmentedGroup.svelte";

const options = [
	{ value: "none", label: "None" },
	{ value: "dots", label: "Dots" },
	{ value: "mesh", label: "Mesh" },
	{ value: "bold", label: "Bold" },
];

function mount(value = "none") {
	const onchange = vi.fn();
	const screen = render(SegmentedGroup, { label: "Background pattern", options, value, onchange });
	return { screen, onchange };
}

describe("SegmentedGroup", () => {
	it("is a named radio group, one radio per option, the current one checked", async () => {
		const { screen } = mount("mesh");
		await expect
			.element(screen.getByRole("radiogroup", { name: "Background pattern" }))
			.toBeVisible();
		expect(screen.getByRole("radio").elements()).toHaveLength(4);
		await expect.element(screen.getByRole("radio", { name: "Mesh" })).toBeChecked();
		await expect.element(screen.getByRole("radio", { name: "None" })).not.toBeChecked();
	});

	it("reports a click", async () => {
		const { screen, onchange } = mount();
		await screen.getByRole("radio", { name: "Bold" }).click();
		expect(onchange).toHaveBeenCalledExactlyOnceWith("bold");
	});

	const stops = (value: string) => {
		const { screen } = mount(value);
		return options.map((o) =>
			screen.getByRole("radio", { name: o.label }).element().getAttribute("tabindex")
		);
	};

	it("keeps a single tab stop on the chosen option", async () => {
		expect(stops("dots")).toEqual(["-1", "0", "-1", "-1"]);
	});

	it("keeps a tab stop when the stored value is not one of the options", async () => {
		expect(stops("zigzag")).toEqual(["0", "-1", "-1", "-1"]);
	});

	it("moves the choice with the arrow keys, wrapping at the ends", async () => {
		const { screen, onchange } = mount("none");
		(screen.getByRole("radio", { name: "None" }).element() as HTMLElement).focus();
		await userEvent.keyboard("{ArrowRight}");
		expect(onchange).toHaveBeenLastCalledWith("dots");
		await userEvent.keyboard("{ArrowLeft}");
		await userEvent.keyboard("{ArrowLeft}");
		expect(onchange).toHaveBeenLastCalledWith("bold");
		await userEvent.keyboard("{Home}");
		expect(onchange).toHaveBeenLastCalledWith("none");
	});

	it("is named and described by the visible title and description when given ids", async () => {
		const screen = render(SegmentedGroup, {
			label: "Fallback",
			labelledby: "t",
			describedby: "d",
			options,
			value: "none",
			onchange: vi.fn(),
		});
		const group = screen.getByRole("radiogroup").element();
		expect(group.getAttribute("aria-labelledby")).toBe("t");
		expect(group.getAttribute("aria-describedby")).toBe("d");
		expect(group.hasAttribute("aria-label")).toBe(false);
	});

	it("gives the checked option a visible border, not only a fill", async () => {
		const { screen } = mount("dots");
		const border = (name: string) =>
			getComputedStyle(screen.getByRole("radio", { name }).element()).borderTopColor;
		expect(border("Dots")).not.toBe(border("None"));
	});

	it("flips the arrow keys in a right-to-left page", async () => {
		const { screen, onchange } = mount("none");
		const group = screen.getByRole("radiogroup").element() as HTMLElement;
		group.dir = "rtl";
		(screen.getByRole("radio", { name: "None" }).element() as HTMLElement).focus();
		await userEvent.keyboard("{ArrowLeft}");
		expect(onchange).toHaveBeenLastCalledWith("dots");
		await userEvent.keyboard("{ArrowRight}");
		expect(onchange).toHaveBeenLastCalledWith("none");
	});
});
