import { describe, it, expect } from "vitest";
import { render } from "vitest-browser-svelte";
import TurnFailedBanner from "./TurnFailedBanner.svelte";

// Long enough to overflow one line at any test viewport width.
const REASON =
	"The model's provider refused the request: AuthenticationError: Insufficient Balance." +
	" Check the provider's credit or key, or switch model. " +
	"Details: ".repeat(60);
const SHORT = "403 Refused by privacy rule 'Rule 1'.";
const TEXT = '[data-testid="turn-failed-reason"] [title]';

describe("TurnFailedBanner", () => {
	it("the transcript's most recent failed turn starts open", async () => {
		const screen = render(TurnFailedBanner, { reason: REASON, isLatest: true });

		await expect
			.element(screen.getByTestId("turn-failed-toggle"))
			.toHaveAttribute("aria-expanded", "true");
		const text = document.body.querySelector(TEXT);
		expect(text?.className).toContain("break-words");
		await expect
			.element(screen.getByTestId("turn-failed-reason"))
			.toHaveTextContent("AuthenticationError: Insufficient Balance.");
	});

	it("an older failed turn starts collapsed to its title line, and opens on click", async () => {
		const screen = render(TurnFailedBanner, { reason: REASON, isLatest: false });

		const toggle = screen.getByTestId("turn-failed-toggle");
		await expect.element(toggle).toHaveAttribute("aria-expanded", "false");
		// Collapsed: one truncated line, and the title attribute — like the
		// DOM — still carries the whole reason.
		const text = document.body.querySelector(TEXT);
		expect(text?.className).toContain("truncate");
		expect(text?.getAttribute("title")).toBe(REASON);
		expect(text?.textContent).toContain("Check the provider's credit or key, or switch model.");

		await toggle.click();
		await expect.element(toggle).toHaveAttribute("aria-expanded", "true");
		expect(text?.className).toContain("break-words");
	});

	it("a caller that does not know the order keeps the open banner", async () => {
		const screen = render(TurnFailedBanner, { reason: REASON });

		await expect
			.element(screen.getByTestId("turn-failed-toggle"))
			.toHaveAttribute("aria-expanded", "true");
	});

	it("folds when a newer failure takes over the latest spot", async () => {
		const screen = render(TurnFailedBanner, { reason: REASON, isLatest: true });
		const toggle = screen.getByTestId("turn-failed-toggle");
		await expect.element(toggle).toHaveAttribute("aria-expanded", "true");

		await screen.rerender({ reason: REASON, isLatest: false });
		await expect.element(toggle).toHaveAttribute("aria-expanded", "false");
	});

	it("a one-line reason is a plain pill: no chevron, not a button, no aria-expanded", async () => {
		const screen = render(TurnFailedBanner, { reason: SHORT, isLatest: true });
		await expect.element(screen.getByTestId("turn-failed-reason")).toHaveTextContent("Rule 1");
		// Let the overflow measurement settle before asserting absence.
		await new Promise((r) => setTimeout(r, 100));
		const pill = document.body.querySelector('[data-testid="turn-failed-reason"]');
		expect(pill?.querySelector("button")).toBeNull();
		expect(pill?.querySelector("svg.rotate-90")).toBeNull();
		expect(pill?.querySelector("[aria-expanded]")).toBeNull();
		expect(pill?.querySelectorAll("svg")).toHaveLength(1);
	});

	it("a reason that overflows its line shows a chevron that expands it", async () => {
		const screen = render(TurnFailedBanner, { reason: REASON, isLatest: false });
		const toggle = screen.getByTestId("turn-failed-toggle");
		await expect.element(toggle).toHaveAttribute("aria-expanded", "false");
		await toggle.click();
		await expect.element(toggle).toHaveAttribute("aria-expanded", "true");
	});
});
