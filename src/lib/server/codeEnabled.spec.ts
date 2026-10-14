/**
 * `codeAgentsAllowedFor`: the per-person layer over the `CODE_AGENTS_ENABLED`
 * deployment switch (ADR 0096).
 *
 * The switch is the outer gate and always wins; on a gateway preset the
 * person's `/v1/me` `capabilities.code_agents` decides, read through the
 * session's existing `/v1/me` cache (no call per request). With a gateway the
 * decision is deny until the gateway's own answer says `code_agents: true`:
 * no token, an answer the gateway did not give (unreachable, refused, ended)
 * and a capabilities block that does not grant the flag all read as denied.
 * The one allowance is an older gateway, told apart by its own answer: a body
 * that carries no `capabilities` key at all never heard of capabilities, and
 * reads as allowed. Without a gateway the switch alone decides, as before.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ObjectId } from "mongodb";
import { collections, ready } from "$lib/server/database";
import { createTestLocals } from "$lib/server/api/__tests__/testHelpers";
import { forgetGatewaySession } from "$lib/server/gatewaySession";

const env = vi.hoisted(() => ({ values: {} as Record<string, string> }));
vi.mock("$lib/server/config", async (original) => {
	const actual = await original<typeof import("$lib/server/config")>();
	return {
		...actual,
		config: new Proxy(actual.config, {
			get: (target, p: string | symbol) =>
				typeof p === "string" && p in env.values ? env.values[p] : Reflect.get(target, p),
		}),
	};
});

const { codeAgentsAllowedFor } = await import("./codeEnabled");

const GATEWAY_BASE = "http://gateway.invalid/v1";

function gatewayPreset() {
	env.values = { OPENAI_BASE_URL: GATEWAY_BASE, USE_USER_TOKEN: "true" };
}

function stubMe(answer: { status: number; body?: unknown } | { down: true }) {
	let calls = 0;
	const stub = (async (input: RequestInfo | URL) => {
		const url = new URL(typeof input === "string" ? input : input.toString());
		if (url.href === `${GATEWAY_BASE}/me`) {
			calls++;
			if ("down" in answer) throw new TypeError("fetch failed");
			return new Response(JSON.stringify(answer.body ?? {}), { status: answer.status });
		}
		return new Response("{}", { status: 500 });
	}) as typeof fetch;
	vi.stubGlobal("fetch", stub);
	return { calls: () => calls };
}

let insertedUserIds: ObjectId[] = [];
let insertedSessionIds: string[] = [];

/** A signed-in gateway person. `capabilities` is what the stubbed `/v1/me`
 * body carries verbatim: `undefined` sends no key at all (an older gateway),
 * `null` sends the key with a null value, and an object without a usable
 * `code_agents` boolean is a gateway that speaks capabilities but grants
 * nothing. */
async function makeSession(capabilities?: unknown) {
	const gatewayUserId = `gw-${new ObjectId().toString()}`;
	const userId = new ObjectId();
	insertedUserIds.push(userId);
	await collections.users.insertOne({
		_id: userId,
		createdAt: new Date(),
		updatedAt: new Date(),
		name: "n",
		hfUserId: new ObjectId().toString(),
		gatewayUserId,
	} as never);
	const sessionId = `s-${new ObjectId().toString()}`;
	insertedSessionIds.push(sessionId);
	await collections.sessions.insertOne({
		_id: new ObjectId(),
		sessionId,
		userId,
		createdAt: new Date(),
		updatedAt: new Date(),
		expiresAt: new Date(Date.now() + 3_600_000),
	} as never);
	const body = {
		id: gatewayUserId,
		is_admin: false,
		groups: [],
		sessions_valid_after: null,
		merged_at: null,
		...(capabilities === undefined ? {} : { capabilities }),
	};
	return { sessionId, body };
}

afterEach(async () => {
	await collections.users.deleteMany({ _id: { $in: insertedUserIds } });
	await collections.sessions.deleteMany({ sessionId: { $in: insertedSessionIds } });
	insertedUserIds = [];
	insertedSessionIds = [];
	env.values = {};
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("codeAgentsAllowedFor", () => {
	beforeAll(async () => {
		await ready;
	});

	it("off is off for everyone — no gateway call, whatever the person holds", async () => {
		env.values = {
			CODE_AGENTS_ENABLED: "false",
			OPENAI_BASE_URL: GATEWAY_BASE,
			USE_USER_TOKEN: "true",
		};
		const { sessionId, body } = await makeSession({ code_agents: true });
		const fetch = stubMe({ status: 200, body });
		const locals = createTestLocals({ sessionId, token: "tok" });

		expect(await codeAgentsAllowedFor(locals)).toBe(false);
		expect(fetch.calls()).toBe(0);
		forgetGatewaySession(sessionId);
	});

	it("env on with no gateway: the switch alone decides, as today", async () => {
		// The suite-wide test env carries CODE_AGENTS_ENABLED=true with no
		// USE_USER_TOKEN — the generic preset. Nothing is asked.
		const locals = createTestLocals({ sessionId: "s-generic", token: undefined });
		expect(await codeAgentsAllowedFor(locals)).toBe(true);
	});

	it("env on with a gateway and an allowed answer: allowed", async () => {
		gatewayPreset();
		const { sessionId, body } = await makeSession({ code_agents: true });
		stubMe({ status: 200, body });

		expect(await codeAgentsAllowedFor(createTestLocals({ sessionId, token: "tok" }))).toBe(true);
		forgetGatewaySession(sessionId);
	});

	it("env on with a gateway and a denied answer: refused", async () => {
		gatewayPreset();
		const { sessionId, body } = await makeSession({ code_agents: false });
		stubMe({ status: 200, body });

		expect(await codeAgentsAllowedFor(createTestLocals({ sessionId, token: "tok" }))).toBe(false);
		forgetGatewaySession(sessionId);
	});

	it("no capabilities key at all: allowed — an older gateway is not a refusal", async () => {
		// The reliable signal is the body itself: an older gateway answers
		// without a `capabilities` key, which reads as permission (ADR 0096),
		// never as "the answer has not arrived yet" — the check is awaited, so
		// a missing answer cannot reach this decision.
		gatewayPreset();
		const { sessionId, body } = await makeSession(undefined);
		stubMe({ status: 200, body });

		expect(await codeAgentsAllowedFor(createTestLocals({ sessionId, token: "tok" }))).toBe(true);
		forgetGatewaySession(sessionId);
	});

	it("a capabilities block that does not grant code_agents: refused", async () => {
		// A gateway that speaks capabilities but stays silent about
		// code_agents — `capabilities: {}`, or only `api_keys` — is a current
		// gateway declining to say true. It must never read as the
		// older-gateway allowance, or every denial would evaporate.
		gatewayPreset();
		for (const capabilities of [{}, { api_keys: true }, null]) {
			const { sessionId, body } = await makeSession(capabilities);
			stubMe({ status: 200, body });

			expect(await codeAgentsAllowedFor(createTestLocals({ sessionId, token: "tok" }))).toBe(false);
			forgetGatewaySession(sessionId);
		}
	});

	it("no token: refused — nobody without a gateway answer is shown the switch", async () => {
		gatewayPreset();
		const fetch = stubMe({ status: 200, body: {} });
		const locals = createTestLocals({ sessionId: "s-anon", token: undefined });

		expect(await codeAgentsAllowedFor(locals)).toBe(false);
		expect(fetch.calls()).toBe(0);
	});

	it("an unreachable gateway: refused — the surface stays hidden until the gateway answers", async () => {
		// Chats keep the bounded fail-open (the 503 layer's own judgement);
		// the capability gate does not borrow it, because "cannot ask" is not
		// "allowed" for a surface the gateway is meant to ration.
		gatewayPreset();
		const { sessionId } = await makeSession({ code_agents: true });
		stubMe({ down: true });

		expect(await codeAgentsAllowedFor(createTestLocals({ sessionId, token: "tok" }))).toBe(false);
		forgetGatewaySession(sessionId);
	});

	it("an answer the gateway refused (401): refused", async () => {
		gatewayPreset();
		const { sessionId } = await makeSession({ code_agents: true });
		stubMe({ status: 401 });

		expect(await codeAgentsAllowedFor(createTestLocals({ sessionId, token: "tok" }))).toBe(false);
		forgetGatewaySession(sessionId);
	});

	it("reads the session's cached /v1/me, not a call per request", async () => {
		gatewayPreset();
		const { sessionId, body } = await makeSession({ code_agents: false });
		const fetch = stubMe({ status: 200, body });
		const locals = createTestLocals({ sessionId, token: "tok" });

		expect(await codeAgentsAllowedFor(locals)).toBe(false);
		expect(await codeAgentsAllowedFor(locals)).toBe(false);
		expect(fetch.calls()).toBe(1);
		forgetGatewaySession(sessionId);
	});
});

/**
 * A gateway that cannot be asked right now is not a refusal: the decision
 * rides the session's last *valid* answer for at most five minutes (the same
 * grace the machine link's fail-open uses, `machineAuth.ts`), so one blip
 * does not hide /code from everyone for the length of the /v1/me cache.
 * Only when there is no valid answer — first contact, or the grace has run
 * out — does it deny. The clock is faked because the fallback only engages
 * past the check's own 60-second cache: before that a re-check never asks.
 */
describe("codeAgentsAllowedFor through a gateway blip", () => {
	beforeAll(async () => {
		await ready;
	});

	function fakedClock() {
		vi.useFakeTimers({ toFake: ["Date"] });
	}

	it("unreachable within five minutes of a valid allowed answer: still allowed", async () => {
		fakedClock();
		gatewayPreset();
		const { sessionId, body } = await makeSession({ code_agents: true });
		stubMe({ status: 200, body });
		const locals = createTestLocals({ sessionId, token: "tok" });
		expect(await codeAgentsAllowedFor(locals)).toBe(true);

		vi.setSystemTime(Date.now() + 61_000); // past the /v1/me cache, inside the grace
		stubMe({ down: true });
		expect(await codeAgentsAllowedFor(locals)).toBe(true);
		forgetGatewaySession(sessionId);
	});

	it("unreachable more than five minutes after the last valid answer: denied", async () => {
		fakedClock();
		gatewayPreset();
		const { sessionId, body } = await makeSession({ code_agents: true });
		stubMe({ status: 200, body });
		const locals = createTestLocals({ sessionId, token: "tok" });
		expect(await codeAgentsAllowedFor(locals)).toBe(true);

		vi.setSystemTime(Date.now() + 61_000);
		stubMe({ down: true });
		expect(await codeAgentsAllowedFor(locals)).toBe(true);
		vi.setSystemTime(Date.now() + 5 * 60_000); // past the grace since the last valid answer
		expect(await codeAgentsAllowedFor(locals)).toBe(false);
		forgetGatewaySession(sessionId);
	});

	it("an unreachable fallback carries the person's own answer: a denial stays a denial", async () => {
		fakedClock();
		gatewayPreset();
		const { sessionId, body } = await makeSession({ code_agents: false });
		stubMe({ status: 200, body });
		const locals = createTestLocals({ sessionId, token: "tok" });
		expect(await codeAgentsAllowedFor(locals)).toBe(false);

		vi.setSystemTime(Date.now() + 61_000);
		stubMe({ down: true });
		// The last valid answer said false; a blip must not turn that into a
		// maybe, let alone a yes.
		expect(await codeAgentsAllowedFor(locals)).toBe(false);
		forgetGatewaySession(sessionId);
	});

	it("valid then refused: denied at once, and the blip after it rides nothing", async () => {
		fakedClock();
		gatewayPreset();
		const { sessionId, body } = await makeSession({ code_agents: true });
		stubMe({ status: 200, body });
		const locals = createTestLocals({ sessionId, token: "tok" });
		expect(await codeAgentsAllowedFor(locals)).toBe(true);

		vi.setSystemTime(Date.now() + 61_000);
		stubMe({ status: 401 });
		expect(await codeAgentsAllowedFor(locals)).toBe(false);

		// The gateway goes quiet right after refusing: within the grace of
		// its last answer, but the refusal was its newest word about this
		// session, so there is no older valid answer to ride.
		vi.setSystemTime(Date.now() + 61_000);
		stubMe({ down: true });
		expect(await codeAgentsAllowedFor(locals)).toBe(false);
		forgetGatewaySession(sessionId);
	});

	it("never valid — unreachable from the first check: denied", async () => {
		gatewayPreset();
		const { sessionId } = await makeSession({ code_agents: true });
		stubMe({ down: true });

		expect(await codeAgentsAllowedFor(createTestLocals({ sessionId, token: "tok" }))).toBe(false);
		forgetGatewaySession(sessionId);
	});
});
