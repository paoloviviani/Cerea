import { beforeEach, describe, expect, it, vi } from "vitest";

const { state } = vi.hoisted(() => ({
	state: { values: {} as Record<string, string>, managerOn: "true", admin: true },
}));

vi.mock("$lib/server/admin", () => ({
	requireAdmin: vi.fn(async () => {
		if (!state.admin) throw Object.assign(new Error("forbidden"), { status: 403 });
		return { email: "admin@example.org", isAdmin: true };
	}),
}));
vi.mock("$lib/server/config", () => ({
	config: new Proxy({} as Record<string, unknown>, {
		get(_target, key: string) {
			if (key === "set") {
				return async (name: string, value: string) => {
					state.values[name] = value;
				};
			}
			if (key === "getSaved") return (name: string) => state.values[name];
			if (key === "ENABLE_CONFIG_MANAGER") return state.managerOn;
			return state.values[key];
		},
	}),
}));

import { GET, PUT } from "./+server";

const get = () => ({ locals: { token: "t" } }) as unknown as Parameters<typeof GET>[0];
const put = (body: unknown) =>
	({
		locals: { token: "t" },
		request: new Request("http://localhost/api/v2/admin/starters", {
			method: "PUT",
			body: JSON.stringify(body),
		}),
	}) as unknown as Parameters<typeof PUT>[0];
const status = async (run: () => Promise<Response>) =>
	run().then(
		(r) => r.status,
		(e: { status?: number }) => e.status
	);

beforeEach(() => {
	state.values = {};
	state.managerOn = "true";
	state.admin = true;
});

describe("the starter suggestions switch", () => {
	it("is off until an administrator turns it on, and then reads back on", async () => {
		expect((await (await GET(get())).json()).enabled).toBe(false);
		const saved = await (await PUT(put({ enabled: true }))).json();
		expect(saved.enabled).toBe(true);
		expect((await (await GET(get())).json()).enabled).toBe(true);
		expect((await (await PUT(put({ enabled: false }))).json()).enabled).toBe(false);
	});

	it("refuses a non-administrator, a bad body, and a deployment that keeps config in the environment", async () => {
		state.admin = false;
		expect(await status(async () => GET(get()))).toBe(403);
		state.admin = true;
		expect(await status(async () => PUT(put({ enabled: "yes" })))).toBe(400);
		state.managerOn = "false";
		expect(await status(async () => PUT(put({ enabled: true })))).toBe(409);
	});
});
