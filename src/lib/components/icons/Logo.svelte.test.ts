import { describe, expect, it } from "vitest";
import Logo from "./Logo.svelte";
import { renderWithApp } from "$lib/components/__tests__/renderWithApp";

describe("Logo small variant", () => {
	it("is the thick ridge in both themes at the sidebar's 27px box, with a bumped asset version", () => {
		const { container } = renderWithApp(Logo, { variant: "small", classNames: "h-[27px] w-auto" });
		const images = [...container.querySelectorAll("img")];
		expect(images).toHaveLength(2);
		const [light, dark] = images;
		expect(light.getAttribute("src")).toMatch(/\/logo-thick\.svg\?v=\d+$/);
		expect(dark.getAttribute("src")).toMatch(/\/logo-thick-white\.svg\?v=\d+$/);
		// 3:1, so 27px tall is 81px wide.
		expect(light.getAttribute("width")).toBe("81");
		expect(light.getAttribute("height")).toBe("27");
		expect(Number(light.getAttribute("src")?.split("v=")[1])).toBeGreaterThanOrEqual(9);
		// One image is named for screen readers, the other hidden from them.
		expect(dark.getAttribute("aria-hidden")).toBe("true");
	});
});
