import { describe, it, expect } from "vitest";
import { render } from "vitest-browser-svelte";
import TurnFailedBanner from "./TurnFailedBanner.svelte";

const REASON =
	"The model's provider refused the request: AuthenticationError: Insufficient Balance." +
	" Check the provider's credit or key, or switch model.";

describe("TurnFailedBanner", () => {
	it("the transcript's most recent failed turn starts open", async () => {
		const screen = render(TurnFailedBanner, { reason: REASON, isLatest: true });

		await expect
			.element(screen.getByTestId("turn-failed-toggle"))
			.toHaveAttribute("aria-expanded", "true");
		const text = document.body.querySelector('[data-testid="turn-failed-reason"] > span');
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
		const text = document.body.querySelector('[data-testid="turn-failed-reason"] > span');
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
});
