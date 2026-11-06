import AgentsSettings from "./AgentsSettings.svelte";
import { renderWithApp } from "$lib/components/__tests__/renderWithApp";
import { page } from "@vitest/browser/context";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("$env/dynamic/public", () => ({ env: { PUBLIC_APP_NAME: "chat-ui" } }));

const calls: { url: string; init?: RequestInit }[] = [];
const PER_CLASS = {
	edit: "run",
	command: "reviewer",
	web: "run",
	outside: "reviewer",
	secrets: "you",
	agents: "run",
	tools: "run",
	loop: "you",
};
const view = (over: Record<string, unknown> = {}, settings: Record<string, unknown> = {}) => ({
	settings: {
		enabled: false,
		decisionModelId: null,
		threshold: 0.85,
		instructions: "",
		perClass: PER_CLASS,
		...settings,
	},
	deploymentEnabled: true,
	killSwitchOn: false,
	decisionModels: ["judge-a", "judge-b"],
	catalogue: "ok",
	...over,
});
function stub(v: unknown, opts: { testStatus?: number; testBody?: unknown } = {}) {
	calls.length = 0;
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			calls.push({ url, init });
			if (url.includes("/auto-approval/test")) {
				if (opts.testStatus && opts.testStatus !== 200) {
					return Response.json({ message: "no" }, { status: opts.testStatus });
				}
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

describe("Workspace -> Agents (the user's own auto-approval, ADR 0109)", () => {
	it("shows the fixed frame around the editable text and three-way rows, loop fixed, secrets never runs", async () => {
		stub(view());
		renderWithApp(AgentsSettings, {});
		await expect.element(page.getByTestId("agents-frame-top")).toBeVisible();
		await expect.element(page.getByTestId("agents-frame-bottom")).toBeVisible();
		await expect.element(page.getByTestId("agents-row-edit-run")).toBeChecked();
		await expect.element(page.getByTestId("agents-row-command-reviewer")).toBeChecked();
		await expect.element(page.getByTestId("agents-row-secrets-you")).toBeChecked();
		await expect.element(page.getByTestId("agents-row-loop")).toHaveTextContent("always");
		expect(document.querySelector('[data-testid="agents-row-loop-reviewer"]')).toBeNull();
		expect(document.querySelector('[data-testid="agents-row-secrets-run"]')).toBeNull();
		await expect.element(page.getByTestId("agents-never-review")).toBeVisible();
	});

	it("links the user's own review log", async () => {
		stub(view());
		renderWithApp(AgentsSettings, {});
		await expect
			.element(page.getByTestId("agents-log-link"))
			.toHaveAttribute("href", "/settings/review-log");
	});

	it("explains that a decision model must be granted when there are none", async () => {
		stub(view({ decisionModels: [] }));
		renderWithApp(AgentsSettings, {});
		await expect.element(page.getByTestId("agents-no-models")).toHaveTextContent("grant you one");
	});

	it("says when the kill switch is off, and when the administrator has not switched reviewers on", async () => {
		stub(view({ killSwitchOn: true }));
		renderWithApp(AgentsSettings, {});
		await expect.element(page.getByTestId("agents-killswitch")).toBeVisible();
		document.body.innerHTML = "";
		stub(view({ deploymentEnabled: false }));
		renderWithApp(AgentsSettings, {});
		await expect.element(page.getByTestId("agents-not-enabled")).toBeVisible();
	});

	it("refuses a threshold below 0.50 and fence markers, and counts the characters", async () => {
		stub(view());
		renderWithApp(AgentsSettings, {});
		await page.getByLabelText("Allow at or above").fill("0.4");
		await expect
			.element(page.getByText("The threshold must be between 0.5 and 0.99."))
			.toBeVisible();
		await page.getByLabelText("Allow at or above").fill("0.7");
		await page.getByLabelText("Instructions", { exact: true }).fill("fine ``` not fine");
		await expect.element(page.getByRole("alert")).toHaveTextContent("may not contain");
		await expect.element(page.getByTestId("agents-save")).toBeDisabled();
		await page.getByLabelText("Instructions", { exact: true }).fill("Routine work.");
		await expect.element(page.getByTestId("agents-count")).toHaveTextContent("13 of 2000");
	});

	it("saves the user's settings without running the test first", async () => {
		stub(view());
		renderWithApp(AgentsSettings, {});
		await page.getByTestId("agents-enabled").click();
		await page.getByLabelText("Decision model").selectOptions("judge-a");
		await page.getByTestId("agents-row-edit-reviewer").click();
		await expect.element(page.getByTestId("agents-save")).toBeEnabled();
		await page.getByTestId("agents-save").click();
		await vi.waitFor(() => expect(calls.some((c) => c.init?.method === "PUT")).toBe(true));
		const put = calls.find((c) => c.init?.method === "PUT");
		expect(put?.url).toContain("/api/v2/code/auto-approval/settings");
		expect(JSON.parse(String(put?.init?.body))).toMatchObject({
			enabled: true,
			decisionModelId: "judge-a",
			threshold: 0.85,
			perClass: { edit: "reviewer", command: "reviewer", secrets: "you", loop: "you" },
		});
		expect(calls.some((c) => c.url.includes("/test"))).toBe(false);
	});

	it("shows a failing Test with its key cases highlighted and still lets the user save", async () => {
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
						gating: true,
					},
					{
						id: "c3",
						label: "apt install jq",
						expected: "allow",
						got: "escalate",
						probability: 0.4,
						ok: false,
					},
				],
			},
		});
		renderWithApp(AgentsSettings, {});
		await page.getByTestId("agents-enabled").click();
		await page.getByLabelText("Decision model").selectOptions("judge-a");
		await page.getByTestId("agents-test").click();
		const report = page.getByTestId("agents-test-report");
		await expect.element(report).toHaveTextContent("did not go as expected");
		await expect.element(report).toHaveTextContent("git reset --hard");
		const gating = document.querySelector('[data-testid="agents-test-report"] [data-gating]');
		expect(gating?.textContent).toContain("git reset --hard");
		expect(gating?.textContent).toContain("key case");
		expect(
			document.querySelectorAll('[data-testid="agents-test-report"] [data-gating]')
		).toHaveLength(1);
		await expect.element(page.getByTestId("agents-save")).toBeEnabled();
	});

	it("says the test is not available when the server has none", async () => {
		stub(view(), { testStatus: 501 });
		renderWithApp(AgentsSettings, {});
		await page.getByTestId("agents-enabled").click();
		await page.getByLabelText("Decision model").selectOptions("judge-a");
		await page.getByTestId("agents-test").click();
		await expect
			.element(page.getByText("The standard-case test is not available here."))
			.toBeVisible();
		await expect.element(page.getByTestId("agents-save")).toBeEnabled();
	});
});
