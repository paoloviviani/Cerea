import { describe, it, expect, vi, beforeEach } from "vitest";
import superjson from "superjson";
import { ready } from "$lib/server/database";
import { createTestLocals } from "./testHelpers";
import { testRequest } from "$lib/server/__tests__/testRequest";
import type { UsageProvider, UsageReport } from "$lib/server/usage/types";

const providersState = vi.hoisted(() => ({ providers: [] as UsageProvider[] }));

vi.mock("$lib/server/usage/registry", () => ({
	get usageProviders() {
		return providersState.providers;
	},
}));

const { GET } = await import("../../../../routes/api/v2/usage/+server");

async function parseResponse<T = unknown>(res: Response): Promise<T> {
	return superjson.parse(await res.text()) as T;
}

function provider(overrides: Partial<UsageProvider> & { id: string }): UsageProvider {
	return {
		getReport: async () => ({ sections: [] }),
		...overrides,
	};
}

describe("GET /api/v2/usage", () => {
	beforeEach(async () => {
		await ready;
		providersState.providers = [];
	});

	it("requires a session", async () => {
		const res = await testRequest(GET, {
			path: "/api/v2/usage",
			locals: createTestLocals({ sessionId: undefined, user: undefined }),
		});
		expect(res.status).toBe(401);
	});

	it("returns empty sections when no provider is enabled — the no-Pystino shape", async () => {
		const getReport = vi.fn();
		providersState.providers = [provider({ id: "disabled", isEnabled: () => false, getReport })];

		const res = await testRequest(GET, { path: "/api/v2/usage", locals: createTestLocals() });
		const data = await parseResponse<UsageReport>(res);

		expect(data.sections).toEqual([]);
		expect(getReport).not.toHaveBeenCalled();
	});

	it("runs a provider with no isEnabled at all — the default is enabled", async () => {
		const report: UsageReport = { sections: [{ title: "Stats", entries: [] }] };
		providersState.providers = [provider({ id: "always-on", getReport: async () => report })];

		const res = await testRequest(GET, { path: "/api/v2/usage", locals: createTestLocals() });
		const data = await parseResponse<UsageReport>(res);

		expect(data.sections).toEqual(report.sections);
	});

	it("composes sections from multiple enabled providers in order", async () => {
		providersState.providers = [
			provider({
				id: "a",
				getReport: async () => ({ sections: [{ title: "A", entries: [] }] }),
			}),
			provider({
				id: "b",
				getReport: async () => ({ sections: [{ title: "B", entries: [] }] }),
			}),
		];

		const res = await testRequest(GET, { path: "/api/v2/usage", locals: createTestLocals() });
		const data = await parseResponse<UsageReport>(res);

		expect(data.sections.map((s) => s.title)).toEqual(["A", "B"]);
	});

	it("turns a provider that throws into an 'unavailable' section instead of failing the request", async () => {
		providersState.providers = [
			provider({
				id: "broken",
				getReport: async () => {
					throw new Error("boom");
				},
			}),
			provider({
				id: "fine",
				getReport: async () => ({ sections: [{ title: "Fine", entries: [] }] }),
			}),
		];

		const res = await testRequest(GET, { path: "/api/v2/usage", locals: createTestLocals() });
		expect(res.status).toBe(200);
		const data = await parseResponse<UsageReport>(res);

		expect(data.sections).toHaveLength(2);
		expect(data.sections[0]).toMatchObject({ title: "broken", entries: [] });
		expect(data.sections[0].error).toBeTruthy();
		expect(data.sections[1]).toEqual({ title: "Fine", entries: [] });
	});
});
