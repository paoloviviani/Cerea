/** The browser use admin route: admin only, validated, and stored in the chat's config. */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { state, setMock } = vi.hoisted(() => ({
	state: { admin: true, manager: "true", store: {} as Record<string, string> },
	setMock: vi.fn(),
}));

vi.mock("$lib/server/admin", () => ({
	requireAdmin: vi.fn(async () => {
		if (!state.admin) throw Object.assign(new Error("forbidden"), { status: 403 });
		return { email: "admin@example.org", isAdmin: true };
	}),
}));
vi.mock("$lib/server/logger", () => ({
	logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("$lib/server/config", () => ({
	config: new Proxy(
		{
			set: async (k: string, v: string) => {
				setMock(k, v);
				state.store[k] = v;
			},
		} as Record<string, unknown>,
		{
			get: (target, key: string) =>
				key === "ENABLE_CONFIG_MANAGER"
					? state.manager
					: key in target
						? target[key]
						: state.store[key],
		}
	),
}));
vi.mock("$lib/server/models", () => ({
	models: [
		{ id: "tooler", name: "tooler", displayName: "Tooler", supportsTools: true },
		{ id: "plain", name: "plain", displayName: "Plain", supportsTools: false },
	],
}));

import { GET, PUT } from "./+server";

const get = () => ({ locals: {} }) as unknown as Parameters<typeof GET>[0];
const put = (body: unknown) =>
	({
		locals: {},
		request: new Request("http://localhost/api/v2/admin/browser", {
			method: "PUT",
			body: JSON.stringify(body),
		}),
	}) as unknown as Parameters<typeof PUT>[0];

const valid = {
	enabled: true,
	model: "tooler",
	max_steps: 30,
	max_tokens: 150_000,
	max_seconds: 240,
	sites_allow: ["shop.example.com", "*.example.org"],
	sites_deny: ["https://bank.test/login"],
};

beforeEach(() => {
	state.admin = true;
	state.manager = "true";
	state.store = {};
	setMock.mockClear();
});

describe("/api/v2/admin/browser", () => {
	it("is off by default, with the documented defaults and the tool-capable models", async () => {
		const body = await (await GET(get())).json();
		expect(body).toMatchObject({
			enabled: false,
			model: null,
			max_steps: 25,
			max_tokens: 200_000,
			max_seconds: 300,
			sites_allow: [],
			sites_deny: [],
			configurable: true,
			available_models: [{ id: "tooler", name: "Tooler" }],
		});
	});

	it("saves every setting and returns what is stored", async () => {
		const body = await (await PUT(put(valid))).json();
		expect(body).toMatchObject({
			enabled: true,
			model: "tooler",
			max_steps: 30,
			max_tokens: 150_000,
			max_seconds: 240,
			sites_allow: ["shop.example.com", "*.example.org"],
			sites_deny: ["bank.test"],
		});
		expect(setMock).toHaveBeenCalledWith("CHAT_BROWSER_ENABLED", "true");
		expect(setMock).toHaveBeenCalledWith("CHAT_BROWSER_MODEL", "tooler");
		expect(setMock).toHaveBeenCalledWith("CHAT_BROWSER_SITES_DENY", "bank.test");
	});

	it("clears the model back to the chat's own", async () => {
		await PUT(put(valid));
		const body = await (await PUT(put({ ...valid, model: null }))).json();
		expect(body.model).toBeNull();
	});

	it("refuses a model that is not in the catalogue, or cannot call tools", async () => {
		await expect(PUT(put({ ...valid, model: "ghost" }))).rejects.toMatchObject({ status: 400 });
		await expect(PUT(put({ ...valid, model: "plain" }))).rejects.toMatchObject({ status: 400 });
	});

	it("refuses budgets outside the limits, so a typo cannot remove them", async () => {
		await expect(PUT(put({ ...valid, max_steps: 0 }))).rejects.toMatchObject({ status: 400 });
		await expect(PUT(put({ ...valid, max_steps: 5000 }))).rejects.toMatchObject({ status: 400 });
		await expect(PUT(put({ ...valid, max_seconds: 1 }))).rejects.toMatchObject({ status: 400 });
		await expect(PUT(put({ ...valid, max_tokens: 10 }))).rejects.toMatchObject({ status: 400 });
	});

	it("refuses a site entry that is not an address, by name", async () => {
		await expect(
			PUT(put({ ...valid, sites_allow: ["shop.example.com", "not a site"] }))
		).rejects.toMatchObject({
			status: 400,
			body: { message: expect.stringContaining("not a site") },
		});
		expect(setMock).not.toHaveBeenCalled();
	});

	it("is for administrators only", async () => {
		state.admin = false;
		await expect(GET(get())).rejects.toMatchObject({ status: 403 });
		await expect(PUT(put(valid))).rejects.toMatchObject({ status: 403 });
	});

	it("says so when the deployment keeps configuration in the environment only", async () => {
		state.manager = "false";
		await expect(PUT(put(valid))).rejects.toMatchObject({ status: 409 });
		expect((await (await GET(get())).json()).configurable).toBe(false);
	});
});
