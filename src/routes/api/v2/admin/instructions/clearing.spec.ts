/**
 * Clearing the instructions must stick, even when the environment also sets
 * them. This runs the real ConfigManager (switched on), because the bug lived in
 * it: `get` treats a saved "" as unset and falls back to the environment, so an
 * administrator who cleared the text got the environment's text back.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$env/dynamic/private", () => ({
	env: {
		ENABLE_CONFIG_MANAGER: "true",
		ADMIN_INSTRUCTIONS: "ENV TEXT",
		ADMIN_INSTRUCTIONS_VISIBLE: "false",
	},
}));
vi.mock("$lib/server/admin", () => ({
	requireAdmin: vi.fn(async () => ({ email: "admin@example.org", isAdmin: true })),
}));
vi.mock("$lib/server/logger", () => ({
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { config } from "$lib/server/config";
import { GET, PUT } from "./+server";
import { adminInstructionsBlock, withAdminInstructions } from "$lib/server/adminInstructions";

const get = () => ({ locals: { token: "t" } }) as unknown as Parameters<typeof GET>[0];
const put = (body: unknown) =>
	({
		locals: { token: "t" },
		request: new Request("http://localhost/api/v2/admin/instructions", {
			method: "PUT",
			body: JSON.stringify(body),
		}),
	}) as unknown as Parameters<typeof PUT>[0];

beforeEach(() => {
	// The manager is off under test; switch it on for these cases.
	vi.stubEnv("MODE", "production");
});
afterEach(async () => {
	await config.delete("ADMIN_INSTRUCTIONS");
	await config.delete("ADMIN_INSTRUCTIONS_VISIBLE");
	vi.unstubAllEnvs();
});

describe("clearing the administrator's instructions with an environment default", () => {
	it("uses the environment's text until something is saved", async () => {
		expect(config.ConfigManagerEnabled).toBe(true);
		expect((await (await GET(get())).json()).instructions).toBe("ENV TEXT");
		expect(adminInstructionsBlock()).toContain("ENV TEXT");
	});

	it("keeps it cleared once saved empty: gone from the next turn's prompt and from GET", async () => {
		await PUT(put({ instructions: "", visible: true }));

		expect((await (await GET(get())).json()).instructions).toBe("");
		expect(adminInstructionsBlock()).toBe("");
		expect(withAdminInstructions("base")).toBe("base");
	});

	it("keeps a saved visibility over the environment's", async () => {
		expect((await (await GET(get())).json()).visible).toBe(false);
		await PUT(put({ instructions: "Rules", visible: true }));
		expect((await (await GET(get())).json()).visible).toBe(true);
	});
});
