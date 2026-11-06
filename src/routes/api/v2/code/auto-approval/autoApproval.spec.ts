/**
 * What the composer reads, and the user's own settings routes (ADR 0109): in the code API's
 * superjson shape, never with the instructions or the model name; one user's settings are never
 * another's; the standard-case test never gates a save.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import superjson from "superjson";
import { ObjectId } from "mongodb";

const state = vi.hoisted(() => ({ models: ["judge"] as string[] }));
vi.mock("$lib/server/codeDevices", async (importOriginal) => ({
	...(await importOriginal<typeof import("$lib/server/codeDevices")>()),
	requireCodeAgents: vi.fn(async () => {}),
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
import {
	registerReviewTester,
	saveUserReviewSettings,
	setDeploymentReviewEnabled,
} from "$lib/server/agentReview";
import { GET } from "./+server";
import { GET as GET_SETTINGS, PUT as PUT_SETTINGS } from "./settings/+server";
import { POST as TEST } from "./test/+server";

beforeAll(async () => {
	await ready;
});
afterEach(async () => {
	registerReviewTester(null);
	state.models = ["judge"];
	await collections.agentReviewConfig.deleteMany({});
	await collections.agentReviewUserSettings.deleteMany({});
});

const alice = new ObjectId();
const bob = new ObjectId();
const as = (userId: ObjectId, body?: unknown) =>
	({
		locals: { user: { _id: userId }, token: "t" },
		request: new Request("http://localhost/x", { method: "PUT", body: JSON.stringify(body) }),
	}) as never;
const status = (run: () => Promise<Response>) =>
	run().then(
		(r) => r.status,
		(e: { status?: number }) => e.status
	);
const read = async (userId: ObjectId) =>
	superjson.parse<{ available: boolean; perClass: Record<string, string> }>(
		await (await GET(as(userId))).text()
	);
const mine = {
	enabled: true,
	decisionModelId: "judge",
	threshold: 0.9,
	instructions: "Routine dev work.",
	perClass: { edit: "reviewer" },
};

describe("GET /api/v2/code/auto-approval", () => {
	it("says no reviewer until the admin's switch and the user's own are on, then yes with the user's rows", async () => {
		expect((await read(alice)).available).toBe(false);
		await saveUserReviewSettings(alice, { enabled: true, decisionModelId: "judge" });
		expect((await read(alice)).available).toBe(false);
		await setDeploymentReviewEnabled(true);
		const now = await read(alice);
		expect(now.available).toBe(true);
		expect(now.perClass).toMatchObject({
			command: "reviewer",
			edit: "run",
			secrets: "you",
			loop: "you",
		});
		// Bob never inherits alice's.
		expect((await read(bob)).available).toBe(false);
	});

	it("never carries the instructions or the model", async () => {
		await setDeploymentReviewEnabled(true);
		await saveUserReviewSettings(alice, {
			enabled: true,
			decisionModelId: "judge",
			instructions: "secret policy",
		});
		const text = await (await GET(as(alice))).text();
		expect(text).not.toContain("secret policy");
		expect(text).not.toContain("judge");
	});
});

describe("/api/v2/code/auto-approval/settings", () => {
	it("saves the caller's own and offers the gateway's decision models, never another user's", async () => {
		expect(await status(() => PUT_SETTINGS(as(alice, mine)) as Promise<Response>)).toBe(200);
		const view = (await (await GET_SETTINGS(as(alice))).json()) as {
			settings: { decisionModelId: string; perClass: Record<string, string> };
			decisionModels: string[];
		};
		expect(view.settings).toMatchObject({ decisionModelId: "judge" });
		expect(view.settings.perClass).toMatchObject({ edit: "reviewer", command: "reviewer" });
		expect(view.decisionModels).toEqual(["judge"]);
		const other = (await (await GET_SETTINGS(as(bob))).json()) as {
			settings: { decisionModelId: string | null; enabled: boolean };
		};
		expect(other.settings).toMatchObject({ decisionModelId: null, enabled: false });
	});

	it("refuses a model the user may not use, a threshold below 0.50, loop off you, runs for secrets", async () => {
		const put = (over: object) =>
			status(() => PUT_SETTINGS(as(alice, { ...mine, ...over })) as Promise<Response>);
		expect(await put({ decisionModelId: "other" })).toBe(400);
		expect(await put({ threshold: 0.49 })).toBe(400);
		expect(await put({ perClass: { loop: "reviewer" } })).toBe(400);
		expect(await put({ perClass: { secrets: "run" } })).toBe(400);
		expect(await put({ perClass: { edit: "run", command: "you" } })).toBe(200);
	});

	it("reports the admin's switch so the page can say a reviewer is not switched on", async () => {
		const body = (await (await GET_SETTINGS(as(alice))).json()) as { deploymentEnabled: boolean };
		expect(body.deploymentEnabled).toBe(false);
		await setDeploymentReviewEnabled(true);
		expect(
			((await (await GET_SETTINGS(as(alice))).json()) as { deploymentEnabled: boolean })
				.deploymentEnabled
		).toBe(true);
	});
});

describe("/api/v2/code/auto-approval/test", () => {
	const body = { decisionModelId: "judge", threshold: 0.9, instructions: "Routine." };
	it("answers 501 until the review service registers its runner", async () => {
		expect(await status(() => TEST(as(alice, body)) as Promise<Response>)).toBe(501);
	});

	it("shows a failing report and never blocks a save", async () => {
		registerReviewTester(async () => ({
			passed: false,
			cases: [
				{
					id: "c1",
					label: "rm -rf /",
					expected: "escalate",
					got: "allow",
					probability: 0.97,
					ok: false,
					gating: true,
				},
			],
		}));
		const res = await TEST(as(alice, body));
		expect(res.status).toBe(200);
		expect(((await res.json()) as { passed: boolean }).passed).toBe(false);
		// The same settings save without any passing test.
		expect(await status(() => PUT_SETTINGS(as(alice, mine)) as Promise<Response>)).toBe(200);
	});
});
