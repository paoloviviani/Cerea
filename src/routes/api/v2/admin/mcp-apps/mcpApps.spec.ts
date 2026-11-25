import { beforeEach, describe, expect, it, vi } from "vitest";

const { state } = vi.hoisted(() => ({
	state: { stored: "" as string, managerOn: "true", admin: true },
}));

vi.mock("$lib/server/admin", () => ({
	requireAdmin: vi.fn(async () => {
		if (!state.admin) throw Object.assign(new Error("forbidden"), { status: 403 });
		return { email: "admin@example.org", isAdmin: true };
	}),
}));
vi.mock("$lib/server/config", () => ({
	config: new Proxy(
		{
			set: async (key: string, value: string) => {
				if (key === "MCP_APPS") state.stored = value;
			},
		} as Record<string, unknown>,
		{
			get(target, key: string) {
				if (key === "set") return target[key];
				if (key === "ENABLE_CONFIG_MANAGER") return state.managerOn;
				if (key === "MCP_APPS") return state.stored;
				return undefined;
			},
		}
	),
}));

import { GET, PATCH } from "./+server";

const patch = (body: unknown) =>
	({
		locals: { token: "t" },
		request: new Request("http://localhost/api/v2/admin/mcp-apps", {
			method: "PATCH",
			body: JSON.stringify(body),
		}),
	}) as unknown as Parameters<typeof PATCH>[0];

beforeEach(() => {
	state.stored = "";
	state.managerOn = "true";
	state.admin = true;
});

describe("/api/v2/admin/mcp-apps", () => {
	it("reads all by default, saves a mode, and refuses a word it does not know", async () => {
		const read = async () =>
			(await GET({ locals: { token: "t" } } as unknown as Parameters<typeof GET>[0])).json();
		expect((await read()).mode).toBe("all");
		const saved = await PATCH(patch({ mode: "deployment" }));
		expect((await saved.json()).mode).toBe("deployment");
		expect((await read()).mode).toBe("deployment");
		await expect(PATCH(patch({ mode: "everything" }))).rejects.toMatchObject({ status: 400 });
	});

	it("reads an unknown environment value as off", async () => {
		state.stored = "banana";
		const res = await GET({ locals: { token: "t" } } as unknown as Parameters<typeof GET>[0]);
		expect((await res.json()).mode).toBe("off");
	});

	it("is for administrators, and for deployments that keep settings in the app", async () => {
		state.admin = false;
		await expect(PATCH(patch({ mode: "off" }))).rejects.toMatchObject({ status: 403 });
		state.admin = true;
		state.managerOn = "false";
		await expect(PATCH(patch({ mode: "off" }))).rejects.toMatchObject({ status: 409 });
	});
});
