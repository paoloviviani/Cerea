import { describe, expect, it } from "vitest";
import { m } from "$lib/paraglide/messages";
import { runWithLocale } from "$lib/server/requestLocale";

/**
 * hooks.server.ts renders each request inside Paraglide's AsyncLocalStorage
 * with that request's locale. Two requests in flight must not see each
 * other's language, which a global `overwriteGetLocale` would break.
 */
describe("per-request locale", () => {
	const run = (locale: "en" | "en-XA", wait: number) =>
		runWithLocale(locale, "http://x", async () => {
			await new Promise((resolve) => setTimeout(resolve, wait));
			return m["settings.title"]();
		});

	it("keeps concurrent renders apart", async () => {
		const [a, b] = await Promise.all([run("en-XA", 20), run("en", 5)]);
		expect(a).toBe("[Śéťťíńǧś]");
		expect(b).toBe("Settings");
	});

	it("falls back to English outside any request", () => {
		expect(m["settings.title"]()).toBe("Settings");
	});
});
