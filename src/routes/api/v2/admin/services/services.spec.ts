import { beforeEach, describe, expect, it, vi } from "vitest";
import { error } from "@sveltejs/kit";

const h = vi.hoisted(() => ({ admin: true }));
vi.mock("$lib/server/admin", () => ({
	requireAdmin: vi.fn(async () => {
		const { error } = await import("@sveltejs/kit");
		if (!h.admin) error(403, "This deployment's gateway does not list you as an administrator.");
		return { email: "a@example.org", isAdmin: true };
	}),
}));
const report = vi.hoisted(() => vi.fn());
const updates = vi.hoisted(() => vi.fn());
vi.mock("$lib/server/services", () => ({ servicesReport: report }));
vi.mock("$lib/server/services/updates", () => ({ checkForUpdates: updates }));

import { GET } from "./+server";
import { POST } from "./updates/+server";

void error;
const get = (query = "") =>
	GET({
		locals: { token: "t" },
		url: new URL(`http://localhost/api/v2/admin/services${query}`),
	} as unknown as Parameters<typeof GET>[0]);

beforeEach(() => {
	h.admin = true;
	report.mockReset().mockResolvedValue({ checkedAt: "now", cached: false, rows: [] });
	updates.mockReset().mockResolvedValue({ cerea: { state: "current" } });
});

describe("admin services API", () => {
	it("a non-admin gets 403 from both routes and nothing is probed or fetched", async () => {
		h.admin = false;
		await expect(get()).rejects.toMatchObject({ status: 403 });
		await expect(
			POST({ locals: { token: "t" } } as unknown as Parameters<typeof POST>[0])
		).rejects.toMatchObject({ status: 403 });
		expect(report).not.toHaveBeenCalled();
		expect(updates).not.toHaveBeenCalled();
	});

	it("an administrator gets the report; ?refresh=1 bypasses the memory", async () => {
		expect(await (await get()).json()).toMatchObject({ rows: [] });
		expect(report).toHaveBeenLastCalledWith("t", { refresh: false });
		await get("?refresh=1");
		expect(report).toHaveBeenLastCalledWith("t", { refresh: true });
	});

	it("only a POST checks for updates", async () => {
		const response = await POST({ locals: { token: "t" } } as unknown as Parameters<
			typeof POST
		>[0]);
		expect(await response.json()).toEqual({ cerea: { state: "current" } });
		expect(updates).toHaveBeenCalledWith("t");
	});
});
