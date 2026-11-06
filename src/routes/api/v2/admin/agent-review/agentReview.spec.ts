/** The admin route for agent auto-approval (ADR 0109): admin-only, one switch, the log. */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ admin: true }));
vi.mock("$lib/server/admin", () => ({
	requireAdmin: vi.fn(async () => {
		if (!state.admin) throw Object.assign(new Error("forbidden"), { status: 403 });
		return { email: "admin@example.org", isAdmin: true };
	}),
}));
vi.mock("$lib/server/logger", () => ({
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { collections, ready } from "$lib/server/database";
import { GET, PUT } from "./+server";
import { GET as LOG } from "./log/+server";

beforeAll(async () => {
	await ready;
});
beforeEach(() => {
	state.admin = true;
});
afterEach(async () => {
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

describe("admin only", () => {
	it("refuses every route to a non-admin", async () => {
		state.admin = false;
		expect(await status(() => GET(ev() as never) as Promise<Response>)).toBe(403);
		expect(await status(() => PUT(ev({ enabled: true }) as never) as Promise<Response>)).toBe(403);
		expect(await status(() => LOG(ev() as never) as Promise<Response>)).toBe(403);
	});
});

describe("the switch", () => {
	it("reads off by default and turns on and off", async () => {
		expect(await (await GET(ev() as never)).json()).toEqual({
			enabled: false,
			killSwitchOn: false,
		});
		expect((await PUT(ev({ enabled: true }) as never)).status).toBe(200);
		expect(await (await GET(ev() as never)).json()).toMatchObject({ enabled: true });
		await PUT(ev({ enabled: false }) as never);
		expect(await (await GET(ev() as never)).json()).toMatchObject({ enabled: false });
	});

	it("takes only the switch: no model, threshold, instructions or rows", async () => {
		expect(await status(() => PUT(ev({}) as never) as Promise<Response>)).toBe(400);
		const body = await (
			await PUT(
				ev({ enabled: true, decisionModelId: "x", threshold: 0.9, instructions: "y" }) as never
			)
		).json();
		expect(Object.keys(body).sort()).toEqual(["enabled", "killSwitchOn"]);
		const stored = await collections.agentReviewConfig.findOne({});
		expect(stored?.decisionModelId ?? null).toBeNull();
	});

	it("keeps the earlier deployment-level settings, which seed users on first read", async () => {
		await collections.agentReviewConfig.insertOne({
			enabled: false,
			decisionModelId: "old-judge",
			threshold: 0.9,
		} as never);
		await PUT(ev({ enabled: true }) as never);
		expect(await collections.agentReviewConfig.findOne({})).toMatchObject({
			enabled: true,
			decisionModelId: "old-judge",
			threshold: 0.9,
		});
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
