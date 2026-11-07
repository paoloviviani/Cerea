import { createRawSnippet } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "@vitest/browser/context";
import SettingsShell from "./SettingsShell.svelte";
import { renderWithApp } from "$lib/components/__tests__/renderWithApp";

/**
 * The project page's table of contents scrolled the whole app window (sidebar
 * cut off, header gone). Mounted in the app's real frame — a fixed
 * `overflow-hidden` root over the page's own scrolling column — a click on an
 * index entry must move that column and nothing else.
 */
const body = createRawSnippet(() => ({
	render: () => `<div>
		<div style="height:1400px">first</div>
		<h3 id="sec-two" style="height:40px">Second</h3>
		<div style="height:1400px">last</div>
	</div>`,
}));

describe("SettingsShell index", () => {
	let frame: HTMLElement;

	afterEach(() => frame?.remove());

	function mount() {
		frame = document.createElement("div");
		frame.id = "app";
		frame.style.cssText =
			"position:fixed;inset:0;overflow:hidden;display:grid;grid-template-columns:200px 1fr";
		frame.innerHTML = `<aside id="sidebar" style="padding:8px">sidebar</aside>
			<main style="display:grid;grid-template-rows:auto 1fr;min-height:0">
				<h1 id="title" style="height:48px;margin:0">Page</h1>
				<div id="column" style="overflow-y:auto;min-height:0"></div>
			</main>`;
		document.body.appendChild(frame);
		return renderWithApp(
			SettingsShell,
			{
				indexLabel: "On this page",
				index: [
					{ id: "sec-one", label: "First" },
					{ id: "sec-two", label: "Second" },
				],
				children: body,
			} as never,
			{ baseElement: frame.querySelector("#column") as HTMLElement }
		);
	}

	it("scrolls the content column to the section, not the window", async () => {
		await page.viewport(1400, 800);
		mount();
		const column = frame.querySelector("#column") as HTMLElement;
		const link = [...frame.querySelectorAll('[data-testid="settings-index"] a')].find(
			(a) => a.textContent?.trim() === "Second"
		) as HTMLElement;
		expect(link).toBeTruthy();

		await userEvent.click(link);

		// The scroll is smooth: wait for it to arrive.
		const gap = () =>
			(document.getElementById("sec-two") as HTMLElement).getBoundingClientRect().top -
			column.getBoundingClientRect().top;
		await vi.waitFor(() => expect(gap()).toBeLessThanOrEqual(12), { timeout: 4000 });
		expect(gap()).toBeGreaterThanOrEqual(0);
		// The frame, the window and the page's own header and sidebar did not move.
		expect(frame.scrollTop).toBe(0);
		expect(document.scrollingElement?.scrollTop ?? 0).toBe(0);
		expect(frame.querySelector("#title")?.getBoundingClientRect().top).toBe(0);
		expect(frame.querySelector("#sidebar")?.getBoundingClientRect().top).toBe(0);
	});
});
