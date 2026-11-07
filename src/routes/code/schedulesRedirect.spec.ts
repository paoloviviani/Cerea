import { describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/codeEnabled", () => ({
	codeAgentsEnabled: () => true,
	codeAgentsAllowedFor: async () => true,
}));

const { load } = await import("./+page.server");

const run = (search: string) =>
	load({ locals: {}, url: new URL(`http://localhost/code${search}`) } as unknown as Parameters<
		typeof load
	>[0]);

describe("/code?view=schedules", () => {
	it("redirects to the one Schedules page on its agents filter, keeping the other parameters", async () => {
		await expect(run("?view=schedules&new=1&device=d1&ws=w1&agent=a1")).rejects.toMatchObject({
			status: 307,
			location: "/schedules?new=1&device=d1&ws=w1&agent=a1&kind=agent",
		});
		await expect(run("?view=schedules")).rejects.toMatchObject({
			location: "/schedules?kind=agent",
		});
	});

	it("leaves every other /code address alone", async () => {
		await expect(run("?device=d1&ws=w1&agent=a1")).resolves.toEqual({});
	});
});
