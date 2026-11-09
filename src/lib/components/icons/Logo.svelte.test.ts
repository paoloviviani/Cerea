import { describe, expect, it } from "vitest";
import Logo from "./Logo.svelte";
import { renderWithApp } from "$lib/components/__tests__/renderWithApp";

describe("Logo", () => {
	it("is one filled-ridge svg, named for screen readers, at the sidebar's 3:1 box", () => {
		const { container } = renderWithApp(Logo, { variant: "small", classNames: "h-[27px] w-auto" });
		const svgs = container.querySelectorAll("svg.ridge-mark");
		expect(svgs).toHaveLength(1);
		expect(svgs[0].getAttribute("width")).toBe("81");
		expect(svgs[0].getAttribute("height")).toBe("27");
		expect(svgs[0].getAttribute("role")).toBe("img");
		expect(svgs[0].getAttribute("aria-label")).toMatch(/ logo$/);
		expect(svgs[0].getAttribute("class")).toContain("w-auto");
	});

	it("gives every instance its own gradient id", () => {
		const a = renderWithApp(Logo, {});
		const b = renderWithApp(Logo, {});
		const idA = a.container.querySelector("linearGradient")?.id;
		const idB = b.container.querySelector("linearGradient")?.id;
		expect(idA).toBeTruthy();
		expect(idA).not.toBe(idB);
		expect(a.container.querySelector("path")?.getAttribute("fill")).toBe(`url(#${idA})`);
	});
});
