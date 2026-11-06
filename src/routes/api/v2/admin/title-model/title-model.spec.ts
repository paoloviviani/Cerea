/** The title model's admin route: admin only, validated against the catalogue. */
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
		get ENABLE_CONFIG_MANAGER() {
			return state.manager;
		},
		TASK_MODEL: "",
		TITLE_MODEL: "",
		set: async (k: string, v: string) => {
			setMock(k, v);
			state.saved = v;
		},
	},
}));
vi.mock("$lib/server/models", () => ({
	models: [
		{ id: "reasoner", name: "reasoner", displayName: "Reasoner", supportsReasoning: true },
		{ id: "plain", name: "plain", displayName: "Plain", supportsReasoning: false },
	],
}));

import { GET, PUT } from "./+server";

const get = () => ({ locals: {} }) as unknown as Parameters<typeof GET>[0];
const put = (body: unknown) =>
	({
		locals: {},
		request: new Request("http://localhost/api/v2/admin/title-model", {
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

describe("/api/v2/admin/title-model", () => {
	it("lists the chat models, marking those that reason, with automatic as null", async () => {
		const body = await (await GET(get())).json();
		expect(body.model).toBeNull();
		expect(body.available_models).toEqual([
			{ id: "reasoner", name: "Reasoner", reasoning: true },
			{ id: "plain", name: "Plain", reasoning: false },
		]);
	});

	it("saves a catalogue model and reads it back", async () => {
		const body = await (await PUT(put({ model: "plain" }))).json();
		expect(setMock).toHaveBeenCalledWith("TITLE_MODEL", "plain");
		expect(body.model).toBe("plain");
	});

	it("saves null as automatic", async () => {
		state.saved = "plain";
		const body = await (await PUT(put({ model: null }))).json();
		expect(setMock).toHaveBeenCalledWith("TITLE_MODEL", "");
		expect(body.model).toBeNull();
	});

	it("refuses a model the catalogue does not list", async () => {
		await expect(PUT(put({ model: "nope" }))).rejects.toMatchObject({ status: 400 });
		expect(setMock).not.toHaveBeenCalled();
	});

	it("refuses non-admins and an environment-only deployment", async () => {
		state.admin = false;
		await expect(GET(get())).rejects.toMatchObject({ status: 403 });
		state.admin = true;
		state.manager = "false";
		await expect(PUT(put({ model: "plain" }))).rejects.toMatchObject({ status: 409 });
	});
});
