import { createRawSnippet } from "svelte";
import { describe, expect, it } from "vitest";
import { page, userEvent } from "@vitest/browser/context";
import TreeBranch from "./TreeBranch.svelte";
import { renderWithApp } from "$lib/components/__tests__/renderWithApp";

const child = createRawSnippet(() => ({ render: () => `<p data-testid="child">inside</p>` }));

const queryChild = (container: ParentNode) => container.querySelector('[data-testid="child"]');

describe("TreeBranch with an href: the label is a link, the triangle is the toggle", () => {
	it("draws the label as a link and the triangle as a named, stateful button", () => {
		const { container } = renderWithApp(TreeBranch, {
			label: "Projects",
			href: "/projects",
			open: false,
			children: child,
		});

		const link = container.querySelector("a");
		expect(link?.getAttribute("href")).toBe("/projects");
		expect(link?.textContent?.trim()).toBe("Projects");

		const chevron = container.querySelector("button");
		expect(chevron?.getAttribute("aria-label")).toBe("Expand Projects");
		expect(chevron?.getAttribute("aria-expanded")).toBe("false");
		// Neither contains the other: a button inside a link cannot be reached.
		expect(link?.contains(chevron)).toBe(false);
		expect(chevron?.contains(link)).toBe(false);
	});

	it("the triangle expands and collapses, and flips its name and aria-expanded", async () => {
		const { container } = renderWithApp(TreeBranch, {
			label: "Chats",
			href: "/chats",
			open: false,
			children: child,
		});
		expect(queryChild(container)).toBeNull();

		await page.getByRole("button", { name: "Expand Chats" }).click();
		expect(queryChild(container)).not.toBeNull();
		const collapse = page.getByRole("button", { name: "Collapse Chats" });
		await expect.element(collapse).toHaveAttribute("aria-expanded", "true");

		await collapse.click();
		expect(queryChild(container)).toBeNull();
		await expect
			.element(page.getByRole("button", { name: "Expand Chats" }))
			.toHaveAttribute("aria-expanded", "false");
	});

	it("clicking the label follows the link and leaves the branch as it was", () => {
		const { container } = renderWithApp(TreeBranch, {
			label: "Chats",
			href: "/chats",
			open: true,
			children: child,
		});
		const link = container.querySelector("a") as HTMLAnchorElement;
		// Stop the test page itself from navigating; what matters is that the
		// click reaches nothing that toggles.
		let followed = false;
		link.addEventListener("click", (event) => {
			followed = !event.defaultPrevented;
			event.preventDefault();
		});
		link.click();

		expect(followed).toBe(true);
		expect(queryChild(container)).not.toBeNull();
		expect(container.querySelector("button")?.getAttribute("aria-expanded")).toBe("true");
	});

	it("Tab reaches the label link and the triangle as two stops, then the +", async () => {
		const { container } = renderWithApp(TreeBranch, {
			label: "Projects",
			href: "/projects",
			open: false,
			onadd: () => {},
			addTitle: "New project",
			children: child,
		});

		await userEvent.tab();
		const first = document.activeElement;
		await userEvent.tab();
		const second = document.activeElement;
		await userEvent.tab();
		const third = document.activeElement;

		const link = container.querySelector("a");
		const chevron = container.querySelector("button[aria-expanded]");
		const plus = container.querySelector('button[aria-label="New project"]');
		expect([first, second, third]).toEqual([chevron, link, plus]);
	});

	it("calls onactivate from the triangle, for a branch that loads on open", async () => {
		let activated = 0;
		renderWithApp(TreeBranch, {
			label: "Projects",
			href: "/projects",
			onactivate: () => activated++,
			children: child,
		});

		await page.getByRole("button", { name: "Expand Projects" }).click();
		expect(activated).toBe(1);
	});
});

describe("TreeBranch without an href keeps its one-button row", () => {
	it("clicking the label toggles, and there is no link", async () => {
		const { container } = renderWithApp(TreeBranch, {
			label: "Mortgage",
			open: false,
			children: child,
		});
		expect(container.querySelector("a")).toBeNull();

		await page.getByRole("button", { name: "Mortgage" }).click();
		expect(queryChild(container)).not.toBeNull();
	});
});
