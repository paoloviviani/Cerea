/**
 * `codeAgentsAllowedFor`: the per-person layer over the `CODE_AGENTS_ENABLED`
 * deployment switch (ADR 0096).
 *
 * The switch is the outer gate and always wins; on a gateway preset the
 * person's `/v1/me` `capabilities.code_agents` decides, read through the
 * session's existing `/v1/me` cache (no call per request); without a gateway
 * the switch alone decides, as before. Absent — an older gateway with no
 * field, or a gateway that cannot be asked right now — reads as allowed,
 * never as a refusal.
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

async function makeSession(capabilities: { code_agents: boolean } | null) {
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
		...(capabilities === null ? {} : { capabilities }),
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

	it("env on with a gateway and no capabilities field: allowed (an older gateway is not a refusal)", async () => {
		gatewayPreset();
		const { sessionId, body } = await makeSession(null);
		stubMe({ status: 200, body });

		expect(await codeAgentsAllowedFor(createTestLocals({ sessionId, token: "tok" }))).toBe(true);
		forgetGatewaySession(sessionId);
	});

	it("env on with an unreachable gateway: allowed (the 503 layer decides, not the capability)", async () => {
		gatewayPreset();
		const { sessionId } = await makeSession({ code_agents: false });
		stubMe({ down: true });

		expect(await codeAgentsAllowedFor(createTestLocals({ sessionId, token: "tok" }))).toBe(true);
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
