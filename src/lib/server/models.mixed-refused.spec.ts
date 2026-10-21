/** A mix refuses the boot: importing models.ts (which builds the catalogue) throws before any request. */
import { describe, expect, it, vi } from "vitest";

vi.mock("$env/dynamic/public", () => ({ env: { PUBLIC_ORIGIN: "https://vitest.invalid" } }));
vi.mock("$env/dynamic/private", () => ({
	env: {
		MONGODB_URL: process.env.TEST_MONGODB_URL,
		OPENAI_BASE_URL: "http://mixed.test.invalid/v1",
		USE_USER_TOKEN: "true",
		OPENAI_API_KEY: "sk-shared",
	},
}));

describe("boot with personal tokens and a shared key", () => {
	it("refuses before fetching a catalogue", async () => {
		const fetched = vi.spyOn(globalThis, "fetch");
		await expect(import("./models")).rejects.toThrow(
			/OPENAI_API_KEY is set while USE_USER_TOKEN=true/
		);
		expect(fetched.mock.calls.some(([u]) => String(u).includes("mixed.test.invalid"))).toBe(false);
		fetched.mockRestore();
	});
});
