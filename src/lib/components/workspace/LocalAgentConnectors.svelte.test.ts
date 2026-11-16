import LocalAgentConnectors from "./LocalAgentConnectors.svelte";
import { renderWithApp } from "$lib/components/__tests__/renderWithApp";
import { page } from "@vitest/browser/context";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("$env/dynamic/public", () => ({ env: { PUBLIC_APP_NAME: "chat-ui" } }));

afterEach(() => {
	vi.unstubAllGlobals();
	document.body.innerHTML = "";
});

const calls: { method: string; body?: string }[] = [];
function stub(over: Record<string, unknown> = {}) {
	calls.length = 0;
	vi.stubGlobal(
		"fetch",
		vi.fn(async (_url: string, init?: RequestInit) => {
			if (init?.method === "PUT") {
				const body = JSON.parse(String(init.body));
				calls.push({ method: "PUT", body: String(init.body) });
				return Response.json({
					selected: body.keys ?? ["connector:g"],
					appsToo: body.appsToo ?? true,
				});
			}
			return Response.json({
				options: [
					{ key: "connector:g", name: "GitHub", summary: "Issues and pull requests" },
					{ key: "connector:k", name: "Kiwi Flights", summary: "" },
				],
				computers: [
					{
						deviceId: "d1",
						name: "Work laptop",
						options: [
							{
								key: "local:d1:calendar",
								name: "Infomaniak Calendar",
								detail: "calendar",
								kind: "local",
								summary: "",
							},
						],
					},
				],
				selected: ["connector:g"],
				appsToo: true,
				...over,
			});
		})
	);
}

describe("Workspace -> Agents: the one list of connectors your agents may use", () => {
	it("shows each connector's title and own description, and a computer's servers under its name", async () => {
		stub();
		renderWithApp(LocalAgentConnectors, {});
		await expect
			.element(page.getByRole("heading", { name: "Connectors your agents may use" }))
			.toBeVisible();
		await expect.element(page.getByText("Issues and pull requests")).toBeVisible();
		await expect.element(page.getByTestId("local-agent-connector:g")).toBeChecked();
		await expect.element(page.getByTestId("local-agent-connector:k")).not.toBeChecked();
		await expect
			.element(page.getByTestId("local-agents-computer-d1"))
			.toHaveTextContent("On Work laptop");
		await expect
			.element(page.getByTestId("local-agents-computer-d1"))
			.toHaveTextContent("Infomaniak Calendar");
		await expect.element(page.getByText("(calendar)")).toBeVisible();
		await expect.element(page.getByTestId("local-agent-local:d1:calendar")).not.toBeChecked();
	});

	it("saves a computer's server with the same list", async () => {
		stub();
		renderWithApp(LocalAgentConnectors, {});
		await page.getByTestId("local-agent-local:d1:calendar").click();
		expect(JSON.parse(calls[0].body ?? "{}")).toEqual({
			keys: ["connector:g", "local:d1:calendar"],
		});
	});

	it("has the apps-on-my-computers switch on by default, and saves it alone", async () => {
		stub();
		renderWithApp(LocalAgentConnectors, {});
		const toggle = page.getByTestId("local-agents-apps-too");
		await expect.element(toggle).toBeChecked();
		await expect
			.element(
				page.getByText(
					"Apps on my computers may use these connectors too (their own approvals apply)"
				)
			)
			.toBeVisible();
		await toggle.click();
		await expect.element(toggle).not.toBeChecked();
		expect(JSON.parse(calls[0].body ?? "{}")).toEqual({ appsToo: false });
	});
});
