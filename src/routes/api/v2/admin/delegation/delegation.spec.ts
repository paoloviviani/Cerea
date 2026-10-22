import { beforeEach, describe, expect, it, vi } from "vitest";

const { state, setMock, infoMock } = vi.hoisted(() => ({
	state: { stored: "" as string, managerOn: "true", admin: true },
	setMock: vi.fn(),
	infoMock: vi.fn(),
}));

vi.mock("$lib/server/admin", () => ({
	requireAdmin: vi.fn(async () => {
		if (!state.admin) throw Object.assign(new Error("forbidden"), { status: 403 });
		return { email: "admin@example.org", isAdmin: true };
	}),
}));
vi.mock("$lib/server/logger", () => ({
	logger: { debug: vi.fn(), info: infoMock, warn: vi.fn(), error: vi.fn() },
}));
vi.mock("$lib/server/config", () => ({
	config: new Proxy(
		{
			set: async (key: string, value: string) => {
				setMock(key, value);
				if (key === "CHAT_DELEGATION") state.stored = value;
			},
		} as Record<string, unknown>,
		{
			get(target, key: string) {
				if (key === "set") return target[key];
				if (key === "ENABLE_CONFIG_MANAGER") return state.managerOn;
				if (key === "CHAT_DELEGATION") return state.stored;
				return undefined;
			},
		}
	),
}));

import { GET, PATCH } from "./+server";
import { delegationEnabled } from "$lib/server/delegation";

const get = () => ({ locals: { token: "t" } }) as unknown as Parameters<typeof GET>[0];
const patch = (body: unknown) =>
	({
		locals: { token: "t" },
		request: new Request("http://localhost/api/v2/admin/delegation", {
			method: "PATCH",
			body: JSON.stringify(body),
		}),
	}) as unknown as Parameters<typeof PATCH>[0];

beforeEach(() => {
	vi.clearAllMocks();
	state.stored = "";
	state.managerOn = "true";
	state.admin = true;
});

describe("the sub-agent switch", () => {
	it("is on when nothing was ever set", async () => {
		expect(delegationEnabled()).toBe(true);
		expect(await (await GET(get())).json()).toEqual({ enabled: true, configurable: true });
	});

	it("is on for any value but an explicit false", () => {
		state.stored = "true";
		expect(delegationEnabled()).toBe(true);
		state.stored = "banana";
		expect(delegationEnabled()).toBe(true);
	});

	it("turns off, and the server then reads it as off", async () => {
		const body = await (await PATCH(patch({ enabled: false }))).json();
		expect(setMock).toHaveBeenCalledWith("CHAT_DELEGATION", "false");
		expect(body).toEqual({ enabled: false });
		expect(delegationEnabled()).toBe(false);
	});

	it("turns back on", async () => {
		state.stored = "false";
		await PATCH(patch({ enabled: true }));
		expect(setMock).toHaveBeenCalledWith("CHAT_DELEGATION", "true");
		expect(delegationEnabled()).toBe(true);
	});

	it("logs who changed it and from what", async () => {
		await PATCH(patch({ enabled: false }));
		expect(infoMock).toHaveBeenCalledWith(
			{ from: true, to: false, admin: "admin@example.org" },
			"delegation_enabled_changed"
		);
	});

	it("refuses a value that is not a boolean", async () => {
		await expect(PATCH(patch({ enabled: "no" }))).rejects.toMatchObject({ status: 400 });
		await expect(PATCH(patch({}))).rejects.toMatchObject({ status: 400 });
		expect(setMock).not.toHaveBeenCalled();
	});

	it("refuses to read or write for somebody who is not an administrator", async () => {
		state.admin = false;
		await expect(PATCH(patch({ enabled: false }))).rejects.toMatchObject({ status: 403 });
		await expect(GET(get())).rejects.toMatchObject({ status: 403 });
		expect(setMock).not.toHaveBeenCalled();
	});

	it("says so when configuration is environment-only", async () => {
		state.managerOn = "false";
		await expect(PATCH(patch({ enabled: false }))).rejects.toMatchObject({ status: 409 });
		expect(setMock).not.toHaveBeenCalled();
	});
});
