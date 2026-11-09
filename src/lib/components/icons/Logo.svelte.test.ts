import { describe, expect, it } from "vitest";
import Logo from "./Logo.svelte";
import { renderWithApp } from "$lib/components/__tests__/renderWithApp";

describe("Logo", () => {
	it("tile is one square svg, bled to a 400 viewBox, named for screen readers", () => {
		const { container } = renderWithApp(Logo, { variant: "tile", classNames: "h-8 w-8" });
		const svgs = container.querySelectorAll("svg.ridge-mark");
		expect(svgs).toHaveLength(1);
		expect(svgs[0].getAttribute("viewBox")).toBe("0 0 400 400");
		expect(svgs[0].getAttribute("width")).toBe("32");
		expect(svgs[0].getAttribute("height")).toBe("32");
		expect(svgs[0].getAttribute("role")).toBe("img");
		expect(svgs[0].getAttribute("aria-label")).toMatch(/ logo$/);
		expect(container.querySelector("rect.tile-bg")).not.toBeNull();
		expect(container.querySelector("path.ridge")?.getAttribute("stroke-linejoin")).toBe("round");
	});

	it("default is the open 3:1 ridge, with no background square", () => {
		const { container } = renderWithApp(Logo, { classNames: "h-9 w-auto" });
		const svg = container.querySelector("svg.ridge-mark");
		expect(svg?.getAttribute("width")).toBe("337");
		expect(svg?.getAttribute("height")).toBe("112");
		expect(container.querySelector("rect")).toBeNull();
		expect(container.querySelector("path.ridge")?.hasAttribute("stroke-width")).toBe(false);
	});

	it("gives every instance its own gradient id", () => {
		const a = renderWithApp(Logo, {});
		const b = renderWithApp(Logo, {});
		const idsA = Array.from(a.container.querySelectorAll("linearGradient")).map((g) => g.id);
		const idsB = Array.from(b.container.querySelectorAll("linearGradient")).map((g) => g.id);
		expect(idsA).toHaveLength(2);
		expect(new Set([...idsA, ...idsB]).size).toBe(4);
		const style = a.container.querySelector("svg")?.getAttribute("style") ?? "";
		expect(style).toContain(`url(#${idsA[0]})`);
		expect(style).toContain(`url(#${idsA[1]})`);
	});
});
