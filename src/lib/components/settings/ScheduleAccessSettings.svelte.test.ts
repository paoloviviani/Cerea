import { afterEach, describe, expect, it, vi } from "vitest";
import superjson from "superjson";
import { render } from "vitest-browser-svelte";
import ScheduleAccessSettings from "./ScheduleAccessSettings.svelte";

const answer = (body: object) => new Response(superjson.stringify(body));

afterEach(() => vi.unstubAllGlobals());

describe("ScheduleAccessSettings", () => {
	it("stops background access for schedules without signing anyone out, and says so", async () => {
		const calls: string[] = [];
		let active = true;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: string, init?: RequestInit) => {
				calls.push(init?.method ?? "GET");
				if (init?.method === "DELETE") {
					active = false;
					return answer({ revoked: true, disabled: 2 });
				}
				return answer({ required: true, granted: true, active, chatSchedules: 2 });
			})
		);
		const screen = render(ScheduleAccessSettings);
		await expect.element(screen.getByText(/2 chat schedules use it/)).toBeVisible();
		await expect.element(screen.getByText(/does not sign you out/)).toBeVisible();

		await screen.getByRole("button", { name: "Stop background access for schedules" }).click();

		await expect
			.element(screen.getByTestId("schedule-access-stopped"))
			.toHaveTextContent("2 chat schedules were switched off");
		await expect
			.element(screen.getByText(/Stopped\. Turning a chat schedule on again/))
			.toBeVisible();
		expect(calls).toEqual(["GET", "DELETE", "GET"]);
	});

	it("says what is missing when the sign-in left no background access, and offers nothing to stop", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => answer({ required: true, granted: false, active: false, chatSchedules: 0 }))
		);
		const screen = render(ScheduleAccessSettings);
		await expect.element(screen.getByText(/offline_access/)).toBeVisible();
		expect(screen.getByTestId("schedule-access-stop").elements()).toHaveLength(0);
	});

	it("draws nothing off a gateway", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				answer({ required: false, granted: false, active: false, chatSchedules: 0 })
			)
		);
		const screen = render(ScheduleAccessSettings);
		await new Promise((r) => setTimeout(r, 100));
		expect(screen.getByTestId("schedule-access").elements()).toHaveLength(0);
	});
});
