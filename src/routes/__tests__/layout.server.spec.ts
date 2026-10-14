/**
 * The layout's /code flags (ADR 0096): `codeAgentsEnabled` and the three
 * switches derived from it are per-person, decided by the same awaited
 * `/v1/me` check the rest of the session gate uses — allowed, denied,
 * not-yet-known (the gateway could not be asked), an older gateway whose body
 * carries no `capabilities` key at all, and a deployment without a gateway,
 * where the env switch alone decides as before.
 *
 * The client never sees the deployment-wide answer from anywhere else: the
 * universal layout load spreads feature-flags (also per-person now) over this
 * data, so both sources must agree, and NavMenu renders the switch from
 * exactly this value.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ObjectId } from "mongodb";
import { collections, ready } from "$lib/server/database";
import { createTestLocals } from "$lib/server/api/__tests__/testHelpers";
import { forgetGatewaySession } from "$lib/server/gatewaySession";
import { load } from "../+layout.server";

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

const GATEWAY_BASE = "http://gateway.invalid/v1";

function gatewayPreset() {
	env.values = { OPENAI_BASE_URL: GATEWAY_BASE, USE_USER_TOKEN: "true" };
}

function stubMe(answer: { status: number; body?: unknown } | { down: true }) {
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL) => {
			const url = new URL(typeof input === "string" ? input : input.toString());
			if (url.href === `${GATEWAY_BASE}/me`) {
				if ("down" in answer) throw new TypeError("fetch failed");
				return new Response(JSON.stringify(answer.body ?? {}), { status: answer.status });
			}
			return new Response("{}", { status: 500 });
		})
	);
}

let insertedUserIds: ObjectId[] = [];
let insertedSessionIds: string[] = [];

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
});

interface LayoutCodeFlags {
	codeAgentsEnabled: boolean;
	codeFilesEnabled: boolean;
	codeTerminalEnabled: boolean;
	codeSchedulesEnabled: boolean;
}

async function layoutFor(locals: App.Locals): Promise<LayoutCodeFlags> {
	const data = await load({ locals } as unknown as Parameters<typeof load>[0]);
	// The load's $types generic degrades to `void` under this bare call, so
	// the flags are read off the plain object it returns.
	return data as unknown as LayoutCodeFlags;
}

describe("the layout's per-person /code flags", () => {
	beforeAll(async () => {
		await ready;
	});

	it("a person the gateway allows: the switch and its derived switches stand", async () => {
		gatewayPreset();
		const { sessionId, body } = await makeSession({ code_agents: true });
		stubMe({ status: 200, body });

		const data = await layoutFor(createTestLocals({ sessionId, token: "tok" }));
		expect(data.codeAgentsEnabled).toBe(true);
		expect(data.codeFilesEnabled).toBe(true);
		forgetGatewaySession(sessionId);
	});

	it("a person the gateway denies: the switch and everything derived from it fold", async () => {
		gatewayPreset();
		const { sessionId, body } = await makeSession({ code_agents: false });
		stubMe({ status: 200, body });

		const data = await layoutFor(createTestLocals({ sessionId, token: "tok" }));
		expect(data.codeAgentsEnabled).toBe(false);
		expect(data.codeFilesEnabled).toBe(false);
		expect(data.codeTerminalEnabled).toBe(false);
		expect(data.codeSchedulesEnabled).toBe(false);
		forgetGatewaySession(sessionId);
	});

	it("not yet known — the gateway cannot be asked: denied until it answers", async () => {
		gatewayPreset();
		const { sessionId } = await makeSession({ code_agents: true });
		stubMe({ down: true });

		const data = await layoutFor(createTestLocals({ sessionId, token: "tok" }));
		expect(data.codeAgentsEnabled).toBe(false);
		expect(data.codeFilesEnabled).toBe(false);
		expect(data.codeSchedulesEnabled).toBe(false);
		forgetGatewaySession(sessionId);
	});

	it("an older gateway (no capabilities key in the body): allowed", async () => {
		gatewayPreset();
		const { sessionId, body } = await makeSession(undefined);
		stubMe({ status: 200, body });

		const data = await layoutFor(createTestLocals({ sessionId, token: "tok" }));
		expect(data.codeAgentsEnabled).toBe(true);
		forgetGatewaySession(sessionId);
	});

	it("a signed-out visitor on a gateway deployment: no switch", async () => {
		gatewayPreset();
		stubMe({ status: 200, body: {} });

		const data = await layoutFor(createTestLocals({ sessionId: "s-visitor", token: undefined }));
		expect(data.codeAgentsEnabled).toBe(false);
	});

	it("without a gateway the env switch alone decides, unchanged", async () => {
		// The suite's env carries CODE_AGENTS_ENABLED=true with no gateway.
		const data = await layoutFor(createTestLocals({ sessionId: "s-generic", token: undefined }));
		expect(data.codeAgentsEnabled).toBe(true);
	});

	it("the first load awaits the session check: a cold cache still gets a fresh answer", async () => {
		// The value must come from the gateway's answer, not from "nothing in
		// the cache yet": a fresh session's first page load asks /v1/me and
		// decides from what it says.
		gatewayPreset();
		const { sessionId, body } = await makeSession({ code_agents: false });
		stubMe({ status: 200, body });

		const data = await layoutFor(createTestLocals({ sessionId, token: "tok" }));
		expect(data.codeAgentsEnabled).toBe(false);
		forgetGatewaySession(sessionId);
	});
});
