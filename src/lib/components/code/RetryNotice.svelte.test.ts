import { describe, it, expect } from "vitest";
import { render } from "vitest-browser-svelte";
import RetryNotice from "./RetryNotice.svelte";

describe("RetryNotice", () => {
	it("says the provider's message, the attempt and a countdown", async () => {
		const screen = render(RetryNotice, {
			retry: { attempt: 3, message: "Rate limit exceeded", next: Date.now() + 20_000 },
		});
		const note = screen.getByTestId("retry-notice");
		await expect
			.element(note)
			.toHaveTextContent("Retrying — Rate limit exceeded (attempt 3, next try in");
		await expect.element(note).toHaveTextContent(/next try in (19|20) s/);
	});

	it("omits the countdown when the next try is unknown or absurdly far", async () => {
		const unknown = render(RetryNotice, { retry: { attempt: 1, message: "Overloaded" } });
		await expect
			.element(unknown.getByTestId("retry-notice"))
			.toHaveTextContent("Retrying — Overloaded (attempt 1)");
		const far = render(RetryNotice, {
			retry: { attempt: 2, message: "Overloaded", next: Date.now() + 86_400_000 },
		});
		await expect
			.element(far.getByTestId("retry-notice").last())
			.toHaveTextContent("Retrying — Overloaded (attempt 2)");
	});
});
