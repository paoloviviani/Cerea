import LocalAgentConnectors from "./LocalAgentConnectors.svelte";
import { renderWithApp } from "$lib/components/__tests__/renderWithApp";
import { page } from "@vitest/browser/context";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("$env/dynamic/public", () => ({ env: { PUBLIC_APP_NAME: "chat-ui" } }));

afterEach(() => {
	vi.unstubAllGlobals();
	document.body.innerHTML = "";
});

describe("Workspace -> Agents: connectors for local agents", () => {
	it("shows each connector's title and its own description", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				Response.json({
					options: [
						{ key: "connector:g", name: "GitHub", summary: "Issues and pull requests" },
						{ key: "connector:k", name: "Kiwi Flights", summary: "" },
					],
					selected: ["connector:g"],
				})
			)
		);
		renderWithApp(LocalAgentConnectors, {});
		await expect.element(page.getByText("GitHub")).toBeVisible();
		await expect.element(page.getByText("Issues and pull requests")).toBeVisible();
		await expect.element(page.getByTestId("local-agent-connector:g")).toBeChecked();
		await expect.element(page.getByTestId("local-agent-connector:k")).not.toBeChecked();
	});
});
