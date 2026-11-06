/** The hidden-models admin route: admin only, validated, never the default model. */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { state, setMock } = vi.hoisted(() => ({
	state: { admin: true, saved: undefined as string | undefined, manager: "true" },
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
	config: {
		getSaved: () => state.saved,
		HIDDEN_MODELS: "",
		get ENABLE_CONFIG_MANAGER() {
			return state.manager;
		},
		set: async (k: string, v: string) => {
			setMock(k, v);
			state.saved = v;
		},
	},
}));
vi.mock("$lib/server/models", () => {
	const models = [
		{ id: "big", name: "big", displayName: "Big", supportsReasoning: true },
		{ id: "small", name: "small", displayName: "Small", supportsReasoning: false },
		{ id: "old", name: "old", unlisted: true },
	];
	return { models, defaultModel: models[0] };
});

import { GET, PUT } from "./+server";

const get = () => ({ locals: {} }) as unknown as Parameters<typeof GET>[0];
const put = (body: unknown) =>
	({
		locals: {},
		request: new Request("http://localhost/api/v2/admin/hidden-models", {
			method: "PUT",
			body: JSON.stringify(body),
		}),
	}) as unknown as Parameters<typeof PUT>[0];

beforeEach(() => {
	state.admin = true;
	state.saved = undefined;
	state.manager = "true";
	setMock.mockClear();
});

describe("/api/v2/admin/hidden-models", () => {
	it("lists the models with their hidden, default and env-unlisted state", async () => {
		state.saved = "small";
		const body = await (await GET(get())).json();
		expect(body.configurable).toBe(true);
		expect(body.models).toEqual([
			{
				id: "big",
				name: "Big",
				reasoning: true,
				hidden: false,
				env_unlisted: false,
				is_default: true,
			},
			{
				id: "small",
				name: "Small",
				reasoning: false,
				hidden: true,
				env_unlisted: false,
				is_default: false,
			},
			{
				id: "old",
				name: "old",
				reasoning: false,
				hidden: false,
				env_unlisted: true,
				is_default: false,
			},
		]);
	});

	it("saves the hidden ids and reads them back", async () => {
		const body = await (await PUT(put({ hidden: ["small"] }))).json();
		expect(setMock).toHaveBeenCalledWith("HIDDEN_MODELS", "small");
		expect(body.models.find((m: { id: string }) => m.id === "small").hidden).toBe(true);
	});

	it("refuses hiding the default model, with a clear message", async () => {
		await expect(PUT(put({ hidden: ["big"] }))).rejects.toMatchObject({
			status: 400,
			body: { message: expect.stringContaining("default model") },
		});
		expect(setMock).not.toHaveBeenCalled();
	});

	it("refuses unknown models, bad bodies, non-admins and an environment-only deployment", async () => {
		await expect(PUT(put({ hidden: ["nope"] }))).rejects.toMatchObject({ status: 400 });
		await expect(PUT(put({ hidden: "small" }))).rejects.toMatchObject({ status: 400 });
		state.admin = false;
		await expect(GET(get())).rejects.toMatchObject({ status: 403 });
		state.admin = true;
		state.manager = "false";
		await expect(PUT(put({ hidden: ["small"] }))).rejects.toMatchObject({ status: 409 });
	});
});
