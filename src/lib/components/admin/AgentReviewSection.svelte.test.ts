import AgentReviewSection from "./AgentReviewSection.svelte";
import { renderWithApp } from "$lib/components/__tests__/renderWithApp";
import { page } from "@vitest/browser/context";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("$env/dynamic/public", () => ({ env: { PUBLIC_APP_NAME: "chat-ui" } }));

const calls: { url: string; init?: RequestInit }[] = [];
const PER_CLASS = {
	edit: "reviewer",
	command: "reviewer",
	web: "reviewer",
	outside: "reviewer",
	secrets: "you",
	agents: "reviewer",
	tools: "reviewer",
	loop: "you",
};
const view = (over: Record<string, unknown> = {}, settings: Record<string, unknown> = {}) => ({
	settings: {
		enabled: false,
		decisionModelId: null,
		threshold: 0.9,
		instructions: "",
		perClass: PER_CLASS,
		maxPerHourPerMachine: 300,
		...settings,
	},
	killSwitchOn: false,
	decisionModels: ["judge-a", "judge-b"],
	catalogue: "ok",
	testAvailable: true,
	...over,
});
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

function stub(
	v: unknown,
	opts: { testStatus?: number; testBody?: unknown; log?: unknown[]; next?: string | null } = {}
) {
	calls.length = 0;
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			calls.push({ url, init });
			if (url.includes("/agent-review/log"))
				return Response.json({ entries: opts.log ?? [], next: opts.next ?? null });
			if (url.includes("/agent-review/test")) {
				if (opts.testStatus && opts.testStatus !== 200)
					return Response.json({ message: "no" }, { status: opts.testStatus });
				return Response.json(opts.testBody ?? { passed: true, cases: [] });
			}
			if (init?.method === "PUT") return Response.json(view({}, JSON.parse(String(init.body))));
			return Response.json(v);
		})
	);
}
afterEach(() => {
	vi.unstubAllGlobals();
	document.body.innerHTML = "";
});

describe("Administration -> Agents -> Auto-approval", () => {
	it("shows the egress note, the fixed frame around the editable text, and per-class rows with loop fixed", async () => {
		stub(view());
		renderWithApp(AgentReviewSection, {});
		await expect
			.element(page.getByTestId("auto-egress"))
			.toHaveTextContent("provider sees command text and file paths");
		await expect.element(page.getByTestId("auto-frame-top")).toBeVisible();
		await expect.element(page.getByTestId("auto-frame-bottom")).toBeVisible();
		await expect.element(page.getByTestId("auto-row-command-reviewer")).toBeChecked();
		await expect.element(page.getByTestId("auto-row-secrets-you")).toBeChecked();
		await expect.element(page.getByTestId("auto-row-loop")).toHaveTextContent("always");
		expect(document.querySelector('[data-testid="auto-row-loop-reviewer"]')).toBeNull();
	});

	it("explains that a decision model must be added in the gateway when there are none", async () => {
		stub(view({ decisionModels: [] }));
		renderWithApp(AgentReviewSection, {});
		await expect
			.element(page.getByTestId("auto-no-models"))
			.toHaveTextContent("Add one in the gateway");
	});

	it("says when the deployment kill switch is off", async () => {
		stub(view({ killSwitchOn: true }));
		renderWithApp(AgentReviewSection, {});
		await expect
			.element(page.getByTestId("auto-killswitch"))
			.toHaveTextContent("CHAT_AUTO_PERMISSIONS");
	});

	it("refuses a threshold below 0.50 and fence markers, and counts the characters", async () => {
		stub(view());
		renderWithApp(AgentReviewSection, {});
		await page.getByLabelText("Allow at or above").fill("0.4");
		await expect
			.element(page.getByText("The threshold must be between 0.5 and 0.99."))
			.toBeVisible();
		await page.getByLabelText("Allow at or above").fill("0.7");
		await page.getByLabelText("Instructions", { exact: true }).fill("fine ``` not fine");
		await expect.element(page.getByRole("alert")).toHaveTextContent("may not contain");
		await expect.element(page.getByTestId("auto-save")).toBeDisabled();
		await page.getByLabelText("Instructions", { exact: true }).fill("Routine work.");
		await expect.element(page.getByTestId("auto-count")).toHaveTextContent("13 of 2000");
	});

	it("gates the save of a changed, enabled reviewer on a passing test", async () => {
		stub(view(), {
			testBody: {
				passed: true,
				cases: [
					{
						id: "c1",
						label: "npm test",
						expected: "allow",
						got: "allow",
						probability: 0.97,
						ok: true,
					},
				],
			},
		});
		renderWithApp(AgentReviewSection, {});
		await page.getByRole("checkbox").click();
		await page.getByLabelText("Decision model").selectOptions("judge-a");
		await expect.element(page.getByTestId("auto-save")).toBeDisabled();
		await expect.element(page.getByTestId("auto-test-required")).toBeVisible();
		await page.getByTestId("auto-test").click();
		await expect.element(page.getByTestId("auto-test-report")).toHaveTextContent("Passed");
		await expect.element(page.getByTestId("auto-save")).toBeEnabled();
		await page.getByTestId("auto-save").click();
		await vi.waitFor(() => expect(calls.some((c) => c.init?.method === "PUT")).toBe(true));
		const put = calls.find((c) => c.init?.method === "PUT");
		expect(JSON.parse(String(put?.init?.body))).toMatchObject({
			enabled: true,
			decisionModelId: "judge-a",
			threshold: 0.9,
		});
	});

	it("keeps Save off after a failing test and shows the failing case", async () => {
		stub(view(), {
			testBody: {
				passed: false,
				cases: [
					{
						id: "c2",
						label: "git reset --hard",
						expected: "escalate",
						got: "allow",
						probability: 0.95,
						ok: false,
					},
				],
			},
		});
		renderWithApp(AgentReviewSection, {});
		await page.getByRole("checkbox").click();
		await page.getByLabelText("Decision model").selectOptions("judge-a");
		await page.getByTestId("auto-test").click();
		await expect.element(page.getByTestId("auto-test-report")).toHaveTextContent("Not passed");
		await expect
			.element(page.getByTestId("auto-test-report"))
			.toHaveTextContent("git reset --hard");
		await expect.element(page.getByTestId("auto-save")).toBeDisabled();
	});

	it("says the test is not available yet, and does not gate the save, when the server has none", async () => {
		stub(view({ testAvailable: false }));
		renderWithApp(AgentReviewSection, {});
		await page.getByRole("checkbox").click();
		await page.getByLabelText("Decision model").selectOptions("judge-a");
		await expect.element(page.getByTestId("auto-test-unavailable")).toBeVisible();
		await expect.element(page.getByTestId("auto-save")).toBeEnabled();
	});

	it("lists the review log and filters by outcome", async () => {
		stub(view(), { log: logEntries });
		renderWithApp(AgentReviewSection, {});
		await expect
			.poll(() => document.querySelectorAll('[data-testid="auto-log-row"]').length)
			.toBe(2);
		await expect.element(page.getByTestId("auto-log")).toHaveTextContent("rm -rf /etc");
		await page.getByLabelText("Outcome").selectOptions("escalated");
		await vi.waitFor(() =>
			expect(calls.some((c) => c.url.includes("outcome=escalated"))).toBe(true)
		);
	});

	it("shows an empty log, and pages with 'Older entries'", async () => {
		stub(view(), { log: [] });
		renderWithApp(AgentReviewSection, {});
		await expect.element(page.getByTestId("auto-log-empty")).toBeVisible();
		document.body.innerHTML = "";
		stub(view(), { log: logEntries, next: "2026-11-05T08:00:00Z" });
		renderWithApp(AgentReviewSection, {});
		await page.getByTestId("auto-log-more").click();
		await vi.waitFor(() =>
			expect(calls.some((c) => c.url.includes("before=2026-11-05T08%3A00%3A00Z"))).toBe(true)
		);
	});
});
