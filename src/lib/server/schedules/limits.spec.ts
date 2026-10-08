import { describe, expect, it, vi } from "vitest";

const env = vi.hoisted(() => ({ values: {} as Record<string, string | undefined> }));
vi.mock("$lib/server/config", () => ({
	config: new Proxy({}, { get: (_t, key: string) => env.values[key] ?? "" }),
}));

import { DEFAULT_MAX_SCHEDULES_PER_USER, maxSchedulesPerUser, schedulesEnabled } from "./limits";

describe("CHAT_SCHEDULES_ENABLED, the kill switch", () => {
	it("is on when unset or empty, so a deployment gets it with /code", () => {
		env.values = {};
		expect(schedulesEnabled()).toBe(true);
		env.values = { CHAT_SCHEDULES_ENABLED: "" };
		expect(schedulesEnabled()).toBe(true);
	});

	it("is off only for exactly 'false'", () => {
		env.values = { CHAT_SCHEDULES_ENABLED: "false" };
		expect(schedulesEnabled()).toBe(false);
		env.values = { CHAT_SCHEDULES_ENABLED: "true" };
		expect(schedulesEnabled()).toBe(true);
		env.values = { CHAT_SCHEDULES_ENABLED: "0" };
		expect(schedulesEnabled()).toBe(true);
	});
});

describe("CHAT_SCHEDULES_MAX_PER_USER", () => {
	it("defaults to 20", () => {
		env.values = {};
		expect(maxSchedulesPerUser()).toBe(DEFAULT_MAX_SCHEDULES_PER_USER);
		expect(DEFAULT_MAX_SCHEDULES_PER_USER).toBe(20);
	});

	it("takes a positive number and ignores nonsense", () => {
		env.values = { CHAT_SCHEDULES_MAX_PER_USER: "5" };
		expect(maxSchedulesPerUser()).toBe(5);
		for (const bad of ["0", "-3", "many", "1.5x"]) {
			env.values = { CHAT_SCHEDULES_MAX_PER_USER: bad };
			expect(maxSchedulesPerUser(), bad).toBe(20);
		}
	});
});
