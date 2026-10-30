/**
 * The per-person /code gate (ADR 0096), through the real `handle` hook: a
 * person whose gateway answer says `code_agents: false` gets the panel as
 * hidden (404, the same shape as the switch being off) on the device list,
 * the pairing confirm, the schedules and the /code page — while their chat
 * keeps working. An allowed person, and a person on an older gateway with no
 * `capabilities` field, pass.
 *
 * The gateway preset is faked per-test through the config proxy (the suite
 * runs the generic preset), with a stubbed `/v1/me`; sessions carry a real
 * oauth token and fresh `authTime` so the only thing wrong is the
 * capability.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ObjectId } from "mongodb";
import superjson from "superjson";
import { collections, ready } from "$lib/server/database";
import { cleanupTestData, createTestUser } from "$lib/server/api/__tests__/testHelpers";
import { testRequest } from "$lib/server/__tests__/testRequest";
import { forgetGatewaySession } from "$lib/server/gatewaySession";
import { GET as devicesGET, PATCH as devicesPATCH } from "../devices/+server";
import { GET as schedulesGET, POST as schedulesPOST } from "../schedules/+server";
import { GET as scheduleGET } from "../schedules/[id]/+server";
import { GET as conversationsGET } from "../../conversations/+server";
import { load as codeLoad } from "../../../../code/+page.server";

const env = vi.hoisted(() => ({ preset: false }));
vi.mock("$lib/server/config", async (original) => {
	const actual = await original<typeof import("$lib/server/config")>();
	return {
		...actual,
		config: new Proxy(actual.config, {
			get: (target, p: string | symbol) => {
				if (env.preset && typeof p === "string") {
					if (p === "OPENAI_BASE_URL") return "http://gateway.invalid/v1";
					if (p === "USE_USER_TOKEN") return "true";
				}
				return Reflect.get(target, p);
			},
		}),
	};
});

const GATEWAY_BASE = "http://gateway.invalid/v1";

type Handler = Parameters<typeof testRequest>[0];

async function call(
	handler: Handler,
	path: string,
	cookie: string,
	options: { method?: string; json?: unknown; params?: Record<string, string> } = {}
) {
	const res = await testRequest(handler, {
		method: options.method ?? "GET",
		path,
		headers: {
			"content-type": "application/json",
			cookie,
		},
		...(options.json !== undefined ? { body: JSON.stringify(options.json) } : {}),
		...(options.params ? { params: options.params } : {}),
	});
	const text = await res.text();
	let data: Record<string, unknown> = {};
	try {
		data = superjson.parse(text) as Record<string, unknown>;
	} catch {
		data = { raw: text };
	}
	return { status: res.status, data, text };
}

/** A signed-in gateway person: a real session with an oauth token and fresh
 * `authTime` (past the /code stale-sign-in guard), a `gatewayUserId` the
 * stubbed `/v1/me` answers with, and that answer's capabilities. */
async function gatewayPerson(codeAgents: boolean | null) {
	const person = await createTestUser();
	const gatewayUserId = `gw-${person.user._id.toString()}`;
	await collections.users.updateOne({ _id: person.user._id }, { $set: { gatewayUserId } });
	const token = `tok-${person.session.sessionId}`;
	await collections.sessions.updateOne(
		{ sessionId: person.session.sessionId },
		{
			$set: {
				authTime: new Date(),
				oauth: {
					token: { value: token, expiresAt: new Date(Date.now() + 3_600_000) },
				},
			},
		}
	);
	const body = {
		id: gatewayUserId,
		is_admin: false,
		groups: [],
		sessions_valid_after: null,
		merged_at: null,
		...(codeAgents === null ? {} : { capabilities: { code_agents: codeAgents } }),
	};
	vi.stubGlobal("fetch", (async (input: RequestInfo | URL) => {
		const url = new URL(typeof input === "string" ? input : input.toString());
		if (url.href === `${GATEWAY_BASE}/me`) {
			return new Response(JSON.stringify(body), { status: 200 });
		}
		return new Response("{}", { status: 500 });
	}) as typeof fetch);
	return { person, token };
}

beforeAll(async () => {
	await ready;
});

afterEach(async () => {
	env.preset = false;
	vi.unstubAllGlobals();
	await cleanupTestData();
});

describe("a chat-only person's /code", () => {
	it("refuses the device list with 404, naming the account (not the deployment)", async () => {
		env.preset = true;
		const { person } = await gatewayPerson(false);

		const res = await call(devicesGET, "/api/v2/code/devices", person.cookie);

		expect(res.status).toBe(404);
		expect(res.text).toContain("not available for your account");
		forgetGatewaySession(person.session.sessionId);
	});

	it("refuses the pairing confirm with 404", async () => {
		env.preset = true;
		const { person } = await gatewayPerson(false);
		// A real pending row: without the gate this confirm would succeed,
		// so the 404 below is the gate's, not a missing row's.
		const deviceId = new ObjectId();
		await collections.codeDevices.insertOne({
			_id: deviceId,
			userId: person.user._id,
			machineId: new ObjectId().toString(),
			name: "build box",
			status: "pending",
			sub: "sub",
			iss: "http://fake-issuer.invalid",
			createdAt: new Date(),
			updatedAt: new Date(),
		} as never);

		const res = await call(
			devicesPATCH,
			`/api/v2/code/devices?id=${deviceId.toString()}`,
			person.cookie,
			{ method: "PATCH", json: { action: "confirm" } }
		);

		expect(res.status).toBe(404);
		expect(res.text).toContain("not available for your account");
		forgetGatewaySession(person.session.sessionId);
	});

	it("shows the /code schedules only their chat ones: agent schedules are not theirs to see or make", async () => {
		env.preset = true;
		const { person } = await gatewayPerson(false);
		const now = new Date();
		const row = (kind: "agent" | "chat") => ({
			_id: new ObjectId(),
			userId: person.user._id,
			kind,
			name: `a ${kind} schedule`,
			target: {},
			prompt: "p",
			recurrence: { type: "daily", at: "09:00" },
			timezone: "UTC",
			anchorAt: now,
			enabled: false,
			nextRunAt: null,
			consecutiveFailures: 0,
			firedCount: 0,
			createdAt: now,
			updatedAt: now,
		});
		const agent = row("agent");
		await collections.schedules.insertMany([agent, row("chat")] as never);

		const list = await call(schedulesGET, "/api/v2/code/schedules", person.cookie);
		expect(list.status).toBe(200);
		expect((list.data.schedules as { name: string }[]).map((x) => x.name)).toEqual([
			"a chat schedule",
		]);

		const one = await call(
			scheduleGET,
			`/api/v2/code/schedules/${agent._id.toString()}`,
			person.cookie,
			{ params: { id: agent._id.toString() } }
		);
		expect(one.status).toBe(404);

		const made = await call(schedulesPOST, "/api/v2/code/schedules", person.cookie, {
			method: "POST",
			json: {
				name: "n",
				prompt: "p",
				recurrence: { type: "daily", at: "09:00" },
				timezone: "UTC",
				target: {},
			},
		});
		expect(made.status).toBe(404);
		forgetGatewaySession(person.session.sessionId);
	});

	it("refuses the /code page with 404", async () => {
		env.preset = true;
		const { person, token } = await gatewayPerson(false);

		// The page load reads the same gate as the sidebar row that hides it.
		const locals = { sessionId: person.session.sessionId, token };
		await expect(
			codeLoad({ locals } as unknown as Parameters<typeof codeLoad>[0])
		).rejects.toMatchObject({ status: 404 });
		forgetGatewaySession(person.session.sessionId);
	});

	it("leaves the same person's chat working", async () => {
		env.preset = true;
		const { person } = await gatewayPerson(false);

		const res = await call(conversationsGET as Handler, "/api/v2/conversations", person.cookie);

		expect(res.status).toBe(200);
		forgetGatewaySession(person.session.sessionId);
	});
});

describe("a person the capability allows", () => {
	it("reaches the device list", async () => {
		env.preset = true;
		const { person } = await gatewayPerson(true);

		const res = await call(devicesGET, "/api/v2/code/devices", person.cookie);

		expect(res.status).toBe(200);
		forgetGatewaySession(person.session.sessionId);
	});

	it("on an older gateway with no capabilities field, passes (absent is allowed)", async () => {
		env.preset = true;
		const { person } = await gatewayPerson(null);

		const res = await call(devicesGET, "/api/v2/code/devices", person.cookie);

		expect(res.status).toBe(200);
		forgetGatewaySession(person.session.sessionId);
	});
});
