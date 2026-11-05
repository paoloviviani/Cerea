/** The admin routes for agent auto-approval: admin-only, the save gate, the test endpoint's 501. */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ admin: true, models: ["judge"] as string[] }));
vi.mock("$lib/server/admin", () => ({
	requireAdmin: vi.fn(async () => {
		if (!state.admin) throw Object.assign(new Error("forbidden"), { status: 403 });
		return { email: "admin@example.org", isAdmin: true };
	}),
}));
vi.mock("$lib/server/logger", () => ({
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("$lib/server/agentReviewModels", () => ({
	probeDecisionModels: vi.fn(async () => ({
		models: state.models,
		reachable: true,
		configured: true,
	})),
}));

import { collections, ready } from "$lib/server/database";
import { registerReviewTester, settingsFingerprint, normalize } from "$lib/server/agentReview";
import { GET, PUT } from "./+server";
import { POST as TEST } from "./test/+server";
import { GET as LOG } from "./log/+server";

beforeAll(async () => {
	await ready;
});
beforeEach(() => {
	state.admin = true;
	state.models = ["judge"];
});
afterEach(async () => {
	registerReviewTester(null);
	await collections.agentReviewConfig.deleteMany({});
});

const ev = (body?: unknown, url = "http://localhost/x") =>
	({
		locals: { token: "t" },
		url: new URL(url),
		request: new Request(url, { method: "POST", body: JSON.stringify(body) }),
	}) as never;
const status = (run: () => Promise<Response>) =>
	run().then(
		(r) => r.status,
		(e: { status?: number }) => e.status
	);
const settings = {
	enabled: true,
	decisionModelId: "judge",
	threshold: 0.9,
	instructions: "Routine dev work.",
	maxPerHourPerMachine: 300,
};

describe("admin only", () => {
	it("refuses every route to a non-admin", async () => {
		state.admin = false;
		expect(await status(() => GET(ev() as never) as Promise<Response>)).toBe(403);
		expect(await status(() => PUT(ev(settings) as never) as Promise<Response>)).toBe(403);
		expect(await status(() => TEST(ev({}) as never) as Promise<Response>)).toBe(403);
		expect(await status(() => LOG(ev() as never) as Promise<Response>)).toBe(403);
	});
});

describe("the test endpoint", () => {
	it("answers 501 until the review service registers its runner", async () => {
		expect(
			await status(
				() =>
					TEST(
						ev({ decisionModelId: "judge", threshold: 0.9, instructions: "" }) as never
					) as Promise<Response>
			)
		).toBe(501);
	});
});

describe("PUT", () => {
	it("saves without a test while none exists, and refuses a threshold below 0.50", async () => {
		expect(await status(() => PUT(ev(settings) as never) as Promise<Response>)).toBe(200);
		expect(
			await status(() => PUT(ev({ ...settings, threshold: 0.49 }) as never) as Promise<Response>)
		).toBe(400);
	});

	it("refuses a model the catalogue does not list", async () => {
		expect(
			await status(
				() => PUT(ev({ ...settings, decisionModelId: "other" }) as never) as Promise<Response>
			)
		).toBe(400);
	});

	it("with a test available, needs a passing test for changed values, then saves", async () => {
		let pass = false;
		registerReviewTester(async () => ({ passed: pass, cases: [] }));
		expect(await status(() => PUT(ev(settings) as never) as Promise<Response>)).toBe(409);
		const run = () =>
			ev({ decisionModelId: "judge", threshold: 0.9, instructions: "Routine dev work." });
		expect((await TEST(run() as never)).status).toBe(200);
		expect(await status(() => PUT(ev(settings) as never) as Promise<Response>)).toBe(409);
		pass = true;
		expect((await TEST(run() as never)).status).toBe(200);
		expect(await status(() => PUT(ev(settings) as never) as Promise<Response>)).toBe(200);
		// Different instructions need a new test; a change to a row alone does not.
		expect(
			await status(
				() => PUT(ev({ ...settings, instructions: "Other." }) as never) as Promise<Response>
			)
		).toBe(409);
		expect(
			await status(
				() => PUT(ev({ ...settings, perClass: { edit: "you" } }) as never) as Promise<Response>
			)
		).toBe(200);
		const row = await collections.agentReviewConfig.findOne({});
		expect(row?.testedFingerprint).toBe(settingsFingerprint(normalize(settings)));
	});

	it("never offers the fingerprint back, and keeps loop on you", async () => {
		await PUT(ev(settings) as never);
		const body = (await (await GET(ev() as never)).json()) as {
			settings: Record<string, unknown> & { perClass: Record<string, string> };
		};
		expect(body.settings.testedFingerprint).toBeUndefined();
		expect(body.settings.perClass.loop).toBe("you");
		expect(
			await status(
				() => PUT(ev({ ...settings, perClass: { loop: "reviewer" } }) as never) as Promise<Response>
			)
		).toBe(400);
	});
});

describe("the log route", () => {
	it("refuses an unknown class or outcome", async () => {
		expect(
			await status(
				() => LOG(ev(undefined, "http://localhost/x?class=nope") as never) as Promise<Response>
			)
		).toBe(400);
		expect(
			await status(
				() => LOG(ev(undefined, "http://localhost/x?outcome=nope") as never) as Promise<Response>
			)
		).toBe(400);
		expect(
			(await LOG(ev(undefined, "http://localhost/x?class=command&outcome=allowed") as never)).status
		).toBe(200);
	});
});
