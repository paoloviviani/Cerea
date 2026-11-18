import AgentReviewLog from "./AgentReviewLog.svelte";
import { renderWithApp } from "$lib/components/__tests__/renderWithApp";
import { page } from "@vitest/browser/context";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("$env/dynamic/public", () => ({ env: { PUBLIC_APP_NAME: "chat-ui" } }));

const calls: string[] = [];
const logEntries = [
	{
		id: "e1",
		time: "2026-11-05T09:00:00Z",
		machine: "studio-laptop",
		deviceId: "d1",
		sessionId: "s",
		class: "command",
		summary: "npm test",
		probability: 0.96,
		outcome: "allowed",
		reason: "routine",
		applied: true,
		modelId: "judge-a",
	},
	{
		id: "e2",
		time: "2026-11-05T08:00:00Z",
		machine: "studio-laptop",
		deviceId: "d1",
		sessionId: "s",
		class: "outside",
		summary: "rm -rf /etc",
		probability: 0.12,
		outcome: "escalated",
		reason: "no",
		applied: true,
		modelId: "judge-a",
	},
];

function stub(opts: { log?: unknown[]; next?: string | null } = {}) {
	calls.length = 0;
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL) => {
			calls.push(String(input));
			return Response.json({ entries: opts.log ?? [], next: opts.next ?? null });
		})
	);
}
afterEach(() => {
	vi.unstubAllGlobals();
	document.body.innerHTML = "";
});

describe("Administration -> Agents -> Review log", () => {
	it("lists the review log and filters by outcome", async () => {
		stub({ log: logEntries });
		renderWithApp(AgentReviewLog, {});
		await expect
			.poll(() => document.querySelectorAll('[data-testid="auto-log-row"]').length)
			.toBe(2);
		await expect.element(page.getByTestId("auto-log")).toHaveTextContent("rm -rf /etc");
		await page.getByLabelText("Outcome").selectOptions("escalated");
		await vi.waitFor(() => expect(calls.some((c) => c.includes("outcome=escalated"))).toBe(true));
	});

	it("renders a read-only rule entry as 'Allowed: read-only' and filters on it", async () => {
		stub({
			log: [
				{
					...logEntries[0],
					id: "e3",
					summary: "docker compose ps",
					probability: null,
					outcome: "read-only",
					reason: "a plain read inside the workspace",
				},
			],
		});
		renderWithApp(AgentReviewLog, {});
		await expect.element(page.getByTestId("auto-log")).toHaveTextContent("Allowed: read-only");
		await page.getByLabelText("Outcome").selectOptions("read-only");
		await vi.waitFor(() => expect(calls.some((c) => c.includes("outcome=read-only"))).toBe(true));
	});

	it("shows an empty log, and pages with 'Older entries'", async () => {
		stub({ log: [] });
		renderWithApp(AgentReviewLog, {});
		await expect.element(page.getByTestId("auto-log-empty")).toBeVisible();
		document.body.innerHTML = "";
		stub({ log: logEntries, next: "2026-11-05T08:00:00Z" });
		renderWithApp(AgentReviewLog, {});
		await page.getByTestId("auto-log-more").click();
		await vi.waitFor(() =>
			expect(calls.some((c) => c.includes("before=2026-11-05T08%3A00%3A00Z"))).toBe(true)
		);
	});

	it("reads the user-scoped endpoint for scope=own, and renders a stacked card per entry", async () => {
		stub({ log: logEntries });
		renderWithApp(AgentReviewLog, { scope: "own" });
		await expect
			.poll(() => document.querySelectorAll('[data-testid="auto-log-card"]').length)
			.toBe(2);
		expect(calls[0]).toContain("/api/v2/code/review-log");
		expect(calls[0]).not.toContain("/admin/");
		await expect.element(page.getByTestId("auto-log-cards")).toHaveTextContent("npm test");
	});
});

describe("Review log with an expired agents sign-in", () => {
	it("answers a 401 with a sign-in-again card, not a raw status", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("Must have a valid session or user", { status: 401 }))
		);
		renderWithApp(AgentReviewLog, { scope: "own" });
		const card = page.getByTestId("auto-log-reauth");
		await expect.element(card).toHaveTextContent("Your sign-in for agents has expired");
		await expect
			.element(card.getByRole("link", { name: "Sign in again" }))
			.toHaveAttribute("href", expect.stringContaining("/login?reauth=1&next="));
		expect(document.body.textContent).not.toContain("Something went wrong (401)");
	});
});
