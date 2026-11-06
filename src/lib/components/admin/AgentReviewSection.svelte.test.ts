import AgentReviewSection from "./AgentReviewSection.svelte";
import { renderWithApp } from "$lib/components/__tests__/renderWithApp";
import { page } from "@vitest/browser/context";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("$env/dynamic/public", () => ({ env: { PUBLIC_APP_NAME: "chat-ui" } }));

const calls: { url: string; init?: RequestInit }[] = [];
function stub(v: { enabled: boolean; killSwitchOn: boolean }) {
	calls.length = 0;
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			calls.push({ url: String(input), init });
			if (init?.method === "PUT") {
				return Response.json({ ...v, enabled: JSON.parse(String(init.body)).enabled });
			}
			return Response.json(v);
		})
	);
}
afterEach(() => {
	vi.unstubAllGlobals();
	document.body.innerHTML = "";
});

describe("Administration -> Agents -> Auto-approval (the switch only, ADR 0109)", () => {
	it("shows the one switch and none of the per-user settings", async () => {
		stub({ enabled: false, killSwitchOn: false });
		renderWithApp(AgentReviewSection, {});
		await expect.element(page.getByTestId("auto-enabled")).toBeVisible();
		for (const gone of [
			"auto-frame-top",
			"auto-frame-bottom",
			"auto-test",
			"auto-row-command-reviewer",
		]) {
			expect(document.querySelector(`[data-testid="${gone}"]`), gone).toBeNull();
		}
		expect(document.body.textContent).not.toContain("Decision model");
		expect(document.body.textContent).not.toContain("Reviews per hour");
		// Only a checkbox: no model select, no threshold, no textarea.
		expect(document.querySelectorAll("select, textarea, input[type=number]")).toHaveLength(0);
	});

	it("saves only { enabled }", async () => {
		stub({ enabled: false, killSwitchOn: false });
		renderWithApp(AgentReviewSection, {});
		await expect.element(page.getByTestId("auto-save")).toBeDisabled();
		await page.getByTestId("auto-enabled").click();
		await page.getByTestId("auto-save").click();
		await vi.waitFor(() => expect(calls.some((c) => c.init?.method === "PUT")).toBe(true));
		const put = calls.find((c) => c.init?.method === "PUT");
		expect(JSON.parse(String(put?.init?.body))).toEqual({ enabled: true });
		await expect.element(page.getByText("Saved.")).toBeVisible();
	});

	it("says when the deployment kill switch is off", async () => {
		stub({ enabled: true, killSwitchOn: true });
		renderWithApp(AgentReviewSection, {});
		await expect
			.element(page.getByTestId("auto-killswitch"))
			.toHaveTextContent("CHAT_AUTO_PERMISSIONS");
	});

	it("links to the review log page instead of showing the log", async () => {
		stub({ enabled: true, killSwitchOn: false });
		renderWithApp(AgentReviewSection, {});
		await expect
			.element(page.getByTestId("auto-log-link"))
			.toHaveAttribute("href", "/admin/agents/review-log");
		expect(document.querySelector('[data-testid="auto-log"]')).toBeNull();
		expect(calls.some((c) => c.url.includes("/agent-review/log"))).toBe(false);
	});
});
