import { beforeEach, describe, expect, it, vi } from "vitest";

const { state } = vi.hoisted(() => ({
	state: {
		order: [] as string[],
		values: {} as Record<string, string>,
		managerOn: "true",
		admin: true,
	},
}));

vi.mock("$lib/server/admin", () => ({
	requireAdmin: vi.fn(async () => {
		if (!state.admin) throw Object.assign(new Error("forbidden"), { status: 403 });
		return { email: "admin@example.org", isAdmin: true };
	}),
}));
vi.mock("$lib/server/logger", () => ({
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
// The config store keeps the value `set` saved and answers reads from it, as
// the real manager's in-memory copy does: a save is what the next read sees.
vi.mock("$lib/server/config", () => ({
	config: new Proxy({} as Record<string, unknown>, {
		get(_target, key: string) {
			if (key === "set") {
				return async (name: string, value: string) => {
					state.order.push(name);
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
import {
	ADMIN_INSTRUCTIONS_CLOSE,
	ADMIN_INSTRUCTIONS_MAX,
	ADMIN_INSTRUCTIONS_OPEN,
	visibleAdminInstructions,
	withAdminInstructions,
} from "$lib/server/adminInstructions";

const get = () => ({ locals: { token: "t" } }) as unknown as Parameters<typeof GET>[0];
const put = (body: unknown) =>
	({
		locals: { token: "t" },
		request: new Request("http://localhost/api/v2/admin/instructions", {
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
	state.order = [];
	state.managerOn = "true";
	state.admin = true;
});

const block = (text: string) => `${ADMIN_INSTRUCTIONS_OPEN}\n${text}\n${ADMIN_INSTRUCTIONS_CLOSE}`;

describe("the administrator's instructions API", () => {
	it("is empty and visible when nothing was ever saved", async () => {
		expect(await (await GET(get())).json()).toEqual({
			instructions: "",
			visible: true,
			max: ADMIN_INSTRUCTIONS_MAX,
			configurable: true,
		});
	});

	it("refuses a non-administrator, on read and on save, and saves nothing", async () => {
		state.admin = false;
		expect(await status(() => GET(get()) as Promise<Response>)).toBe(403);
		expect(
			await status(() => PUT(put({ instructions: "x", visible: true })) as Promise<Response>)
		).toBe(403);
		expect(state.values).toEqual({});
	});

	it("saves the trimmed text and the switch", async () => {
		const body = await (await PUT(put({ instructions: "  Be brief.  ", visible: false }))).json();
		expect(body).toEqual({ instructions: "Be brief.", visible: false });
		expect(state.values.ADMIN_INSTRUCTIONS).toBe("Be brief.");
		expect(state.values.ADMIN_INSTRUCTIONS_VISIBLE).toBe("false");
	});

	it("enforces the cap: the limit is accepted, one more is refused", async () => {
		const limit = "a".repeat(ADMIN_INSTRUCTIONS_MAX);
		expect((await PUT(put({ instructions: limit, visible: true }))).status).toBe(200);
		expect(
			await status(
				() => PUT(put({ instructions: limit + "a", visible: true })) as Promise<Response>
			)
		).toBe(400);
		// The refused save left the saved text alone.
		expect(state.values.ADMIN_INSTRUCTIONS).toBe(limit);
	});

	it("refuses a malformed body", async () => {
		expect(await status(() => PUT(put({ instructions: 5 })) as Promise<Response>)).toBe(400);
	});

	it("refuses to save when the deployment keeps its configuration in the environment", async () => {
		state.managerOn = "false";
		expect(
			await status(() => PUT(put({ instructions: "x", visible: true })) as Promise<Response>)
		).toBe(409);
	});

	it("takes effect at once: the next turn's prompt uses the new text, and clearing removes it", async () => {
		expect(withAdminInstructions("base")).toBe("base");
		await PUT(put({ instructions: "First rules", visible: true }));
		expect(withAdminInstructions("base")).toBe(`${block("First rules")}\n\nbase`);
		await PUT(put({ instructions: "Second rules", visible: true }));
		expect(withAdminInstructions("base")).toBe(`${block("Second rules")}\n\nbase`);
		await PUT(put({ instructions: "", visible: true }));
		expect(withAdminInstructions("base")).toBe("base");
	});

	it("hides the text from users' settings when the switch is off, though it still applies", async () => {
		await PUT(put({ instructions: "Rules", visible: true }));
		expect(visibleAdminInstructions()).toEqual({ adminInstructions: "Rules" });
		await PUT(put({ instructions: "Rules", visible: false }));
		expect(visibleAdminInstructions()).toEqual({});
		expect(withAdminInstructions("base")).toBe(`${block("Rules")}\n\nbase`);
	});

	it("writes visibility before the text, so a failed second write can never leave new text visible", async () => {
		await PUT(put({ instructions: "New secret rules", visible: false }));
		expect(state.order).toEqual(["ADMIN_INSTRUCTIONS_VISIBLE", "ADMIN_INSTRUCTIONS"]);
	});
});
