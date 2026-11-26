import AppSuggestionChip from "./AppSuggestionChip.svelte";
import { render } from "vitest-browser-svelte";
import { describe, expect, it, vi } from "vitest";

describe("AppSuggestionChip", () => {
	it("names the connector and shows the suggested text, with Insert and Dismiss", () => {
		const view = render(AppSuggestionChip, {
			from: "Maps",
			text: "Tell me more about pin 2",
			oninsert: () => {},
			ondismiss: () => {},
		});
		const text = view.baseElement.textContent ?? "";
		expect(text).toContain("Maps suggests a message:");
		expect(text).toContain("Tell me more about pin 2");
		expect(text).toContain("Insert");
		expect(text).toContain("Dismiss");
	});

	it("does nothing until a button is clicked", () => {
		const oninsert = vi.fn();
		const ondismiss = vi.fn();
		const view = render(AppSuggestionChip, { from: "Maps", text: "x", oninsert, ondismiss });
		expect(oninsert).not.toHaveBeenCalled();

		const buttons = Array.from(view.baseElement.querySelectorAll("button"));
		buttons.find((b) => b.textContent?.includes("Insert"))?.click();
		buttons.find((b) => b.textContent?.includes("Dismiss"))?.click();

		expect(oninsert).toHaveBeenCalledTimes(1);
		expect(ondismiss).toHaveBeenCalledTimes(1);
	});
});
