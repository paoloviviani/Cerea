/** The user's own review log (ADR 0107): scoped by the session, never by the query. */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ObjectId } from "mongodb";

vi.mock("$lib/server/config", async (importOriginal) => {
	const actual = await importOriginal<typeof import("$lib/server/config")>();
	return {
		...actual,
		config: new Proxy(actual.config, {
			get: (t, k) => (k === "CODE_AGENTS_ENABLED" ? "true" : Reflect.get(t, k)),
		}),
	};
});

import { collections, ready } from "$lib/server/database";
import { appendReviewLog } from "$lib/server/agentReview";
import { GET } from "./+server";

const alice = new ObjectId();
const bob = new ObjectId();

beforeAll(async () => {
	await ready;
});
afterEach(async () => {
	await collections.agentReviewLog.deleteMany({});
});

const add = (userId: ObjectId, over: Record<string, unknown> = {}) =>
	appendReviewLog({
		userId,
		deviceId: "dev-" + userId.toString(),
		machine: "m-" + userId.toString(),
		sessionId: "s",
		class: "command",
		summary: "npm test",
		probability: 0.97,
		outcome: "allowed",
		reason: "routine",
		applied: true,
		modelId: "judge",
		...over,
	});

const call = (user: ObjectId | null, qs = "") =>
	GET({
		locals: user ? { user: { _id: user }, sessionId: "x" } : {},
		url: new URL("http://x/api/v2/code/review-log" + qs),
	} as never);

describe("GET /api/v2/code/review-log", () => {
	it("answers 401 without a signed-in user", async () => {
		await expect(call(null)).rejects.toMatchObject({ status: 401 });
		await expect(
			GET({
				locals: { sessionId: "anon" },
				url: new URL("http://x/api/v2/code/review-log"),
			} as never)
		).rejects.toMatchObject({ status: 401 });
	});

	it("returns only the caller's entries", async () => {
		await add(alice, { summary: "alice cmd" });
		await add(bob, { summary: "bob cmd" });
		const a = await (await call(alice)).json();
		expect(a.entries.map((e: { summary: string }) => e.summary)).toEqual(["alice cmd"]);
		const b = await (await call(bob)).json();
		expect(b.entries.map((e: { summary: string }) => e.summary)).toEqual(["bob cmd"]);
	});

	it("ignores a client-supplied user and cannot reach another user's machine", async () => {
		await add(bob, { summary: "bob cmd" });
		const viaUser = await (await call(alice, `?userId=${bob}`)).json();
		expect(viaUser.entries).toEqual([]);
		const viaMachine = await (await call(alice, `?machine=dev-${bob}`)).json();
		expect(viaMachine.entries).toEqual([]);
	});

	it("filters by machine, outcome and kind within the caller's own entries", async () => {
		await add(alice, { summary: "a1" });
		await add(alice, { summary: "a2", outcome: "escalated", class: "outside" });
		await add(alice, { summary: "a3", deviceId: "other-box" });
		await add(bob, { summary: "b1", outcome: "escalated", class: "outside" });
		const sums = async (qs: string) =>
			(await (await call(alice, qs)).json()).entries
				.map((e: { summary: string }) => e.summary)
				.sort();
		expect(await sums("?outcome=escalated")).toEqual(["a2"]);
		expect(await sums("?class=outside")).toEqual(["a2"]);
		expect(await sums("?machine=other-box")).toEqual(["a3"]);
		await expect(call(alice, "?outcome=nope")).rejects.toMatchObject({ status: 400 });
	});
});
