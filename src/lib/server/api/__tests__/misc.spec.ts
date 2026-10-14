import { vi } from "vitest";

// The PyPI kill-switch is read through the config proxy; mock it the same way
// executeCodeTool.spec.ts mocks CHAT_CODE_TOOL_ENABLED, so it's controllable
// per test while everything else still resolves through the real config.
const configState = vi.hoisted(() => ({
	pyodidePyPiDisabled: false,
	usageEnabled: undefined as boolean | undefined,
	knowledgeEnabled: undefined as boolean | undefined,
	openaiBaseUrl: undefined as string | undefined,
	consoleEnabled: undefined as boolean | undefined,
	// The gateway preset (a per-person user token): off unless a test turns
	// it on, alongside `openaiBaseUrl`.
	useUserToken: undefined as boolean | undefined,
	codeAgentsEnabled: undefined as boolean | undefined,
}));

vi.mock("$lib/server/config", async (importOriginal) => {
	const actual = await importOriginal<typeof import("$lib/server/config")>();
	return {
		...actual,
		get config() {
			return new Proxy(actual.config, {
				get(target, prop, receiver) {
					if (prop === "CHAT_PYODIDE_PYPI_DISABLED") {
						return configState.pyodidePyPiDisabled ? "true" : "";
					}
					if (prop === "CHAT_USAGE_ENABLED" && configState.usageEnabled !== undefined) {
						return configState.usageEnabled ? "true" : "";
					}
					if (prop === "CHAT_KNOWLEDGE_ENABLED" && configState.knowledgeEnabled !== undefined) {
						return configState.knowledgeEnabled ? "true" : "false";
					}
					if (prop === "OPENAI_BASE_URL" && configState.openaiBaseUrl !== undefined) {
						return configState.openaiBaseUrl;
					}
					if (prop === "CHAT_CONSOLE_ENABLED" && configState.consoleEnabled !== undefined) {
						return configState.consoleEnabled ? "true" : "";
					}
					if (prop === "USE_USER_TOKEN" && configState.useUserToken !== undefined) {
						return configState.useUserToken ? "true" : "false";
					}
					if (prop === "CODE_AGENTS_ENABLED" && configState.codeAgentsEnabled !== undefined) {
						return configState.codeAgentsEnabled ? "true" : "false";
					}
					return Reflect.get(target, prop, receiver);
				},
			});
		},
	};
});

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import superjson from "superjson";
import { collections, ready } from "$lib/server/database";
import { createTestLocals, createTestUser, cleanupTestData } from "./testHelpers";
import { testRequest } from "$lib/server/__tests__/testRequest";
import { GET as featureFlagsGET } from "../../../../routes/api/v2/feature-flags/+server";
import { GET as publicConfigGET } from "../../../../routes/api/v2/public-config/+server";
import type { FeatureFlags } from "$lib/server/api/types";

async function parseResponse<T = unknown>(res: Response): Promise<T> {
	return superjson.parse(await res.text()) as T;
}

describe("GET /api/v2/feature-flags", () => {
	beforeEach(async () => {
		await ready;
		await cleanupTestData();
	}, 20000);

	it("returns correct shape with expected fields", async () => {
		const locals = createTestLocals();

		const res = await testRequest(featureFlagsGET, { path: "/api/v2/feature-flags", locals });
		const data = await parseResponse<FeatureFlags>(res);

		expect(data).toHaveProperty("enableAssistants");
		expect(data).toHaveProperty("loginEnabled");
		expect(data).toHaveProperty("isAdmin");
		expect(data).toHaveProperty("transcriptionEnabled");
		expect(data).toHaveProperty("taskModelId");
		expect(data).toHaveProperty("knowledgeEnabled");
		expect(typeof data.enableAssistants).toBe("boolean");
		expect(typeof data.loginEnabled).toBe("boolean");
		expect(typeof data.isAdmin).toBe("boolean");
		expect(typeof data.transcriptionEnabled).toBe("boolean");
		expect(data.taskModelId === null || typeof data.taskModelId === "string").toBe(true);
	});

	it("reflects isAdmin from locals for non-admin user", async () => {
		const locals = createTestLocals({ isAdmin: false });

		const res = await testRequest(featureFlagsGET, { path: "/api/v2/feature-flags", locals });
		const data = await parseResponse<FeatureFlags>(res);

		expect(data.isAdmin).toBe(false);
	});

	it("reflects isAdmin from locals for admin user", async () => {
		const { locals } = await createTestUser();
		locals.isAdmin = true;

		const res = await testRequest(featureFlagsGET, { path: "/api/v2/feature-flags", locals });
		const data = await parseResponse<FeatureFlags>(res);

		expect(data.isAdmin).toBe(true);
	});

	it("derives isAdmin from the persisted user under real cookie auth", async () => {
		const { user, cookie } = await createTestUser();
		await collections.users.updateOne({ _id: user._id }, { $set: { isAdmin: true } });

		const res = await testRequest(featureFlagsGET, {
			path: "/api/v2/feature-flags",
			headers: { cookie },
		});
		const data = await parseResponse<FeatureFlags>(res);

		expect(data.isAdmin).toBe(true);
	});

	afterEach(() => {
		configState.pyodidePyPiDisabled = false;
		configState.usageEnabled = undefined;
		configState.knowledgeEnabled = undefined;
		configState.openaiBaseUrl = undefined;
		configState.consoleEnabled = undefined;
	});

	it("allows the PyPI opt-in setting by default", async () => {
		const locals = createTestLocals();
		const res = await testRequest(featureFlagsGET, { path: "/api/v2/feature-flags", locals });
		const data = await parseResponse<FeatureFlags>(res);
		expect(data.pyodidePyPiInstallAllowed).toBe(true);
	});

	it("reports the setting unavailable when the admin kill-switch is set", async () => {
		configState.pyodidePyPiDisabled = true;
		const locals = createTestLocals();
		const res = await testRequest(featureFlagsGET, { path: "/api/v2/feature-flags", locals });
		const data = await parseResponse<FeatureFlags>(res);
		expect(data.pyodidePyPiInstallAllowed).toBe(false);
	});

	it("hides the usage tab (usageEnabled: false) when CHAT_USAGE_ENABLED is unset", async () => {
		configState.usageEnabled = false;
		configState.openaiBaseUrl = "https://gateway.example/v1";
		const res = await testRequest(featureFlagsGET, {
			path: "/api/v2/feature-flags",
			locals: createTestLocals(),
		});
		const data = await parseResponse<FeatureFlags>(res);
		expect(data.usageEnabled).toBe(false);
	});

	it("hides the usage tab even with the flag on when no gateway is configured", async () => {
		configState.usageEnabled = true;
		configState.openaiBaseUrl = "";
		const res = await testRequest(featureFlagsGET, {
			path: "/api/v2/feature-flags",
			locals: createTestLocals(),
		});
		const data = await parseResponse<FeatureFlags>(res);
		expect(data.usageEnabled).toBe(false);
	});

	it("shows the usage tab when the flag is on and a gateway is configured", async () => {
		configState.usageEnabled = true;
		configState.openaiBaseUrl = "https://gateway.example/v1";
		const res = await testRequest(featureFlagsGET, {
			path: "/api/v2/feature-flags",
			locals: createTestLocals(),
		});
		const data = await parseResponse<FeatureFlags>(res);
		expect(data.usageEnabled).toBe(true);
	});

	it("shows the knowledge surface by default (CHAT_KNOWLEDGE_ENABLED unset)", async () => {
		const res = await testRequest(featureFlagsGET, {
			path: "/api/v2/feature-flags",
			locals: createTestLocals(),
		});
		const data = await parseResponse<FeatureFlags>(res);
		expect(data.knowledgeEnabled).toBe(true);
	});

	it("hides the knowledge surface when CHAT_KNOWLEDGE_ENABLED is false", async () => {
		configState.knowledgeEnabled = false;
		const res = await testRequest(featureFlagsGET, {
			path: "/api/v2/feature-flags",
			locals: createTestLocals(),
		});
		const data = await parseResponse<FeatureFlags>(res);
		expect(data.knowledgeEnabled).toBe(false);
	});

	it("links the console when CHAT_CONSOLE_ENABLED is true (gateway profiles)", async () => {
		configState.consoleEnabled = true;
		const res = await testRequest(featureFlagsGET, {
			path: "/api/v2/feature-flags",
			locals: createTestLocals(),
		});
		const data = await parseResponse<FeatureFlags>(res);
		expect(data.consoleEnabled).toBe(true);
	});

	it("shows no console link when CHAT_CONSOLE_ENABLED is unset (standalone profiles)", async () => {
		configState.consoleEnabled = false;
		const res = await testRequest(featureFlagsGET, {
			path: "/api/v2/feature-flags",
			locals: createTestLocals(),
		});
		const data = await parseResponse<FeatureFlags>(res);
		expect(data.consoleEnabled).toBe(false);
	});

	it("serves CORS headers on /api/** when the request carries no Origin", async () => {
		const res = await testRequest(featureFlagsGET, {
			path: "/api/v2/feature-flags",
			locals: createTestLocals(),
		});

		expect(res.headers.get("access-control-allow-origin")).toBe("*");
		expect(res.headers.get("access-control-allow-methods")).toBe(
			"GET, POST, PUT, PATCH, DELETE, OPTIONS"
		);
		expect(res.headers.get("access-control-allow-headers")).toBe("Content-Type, Authorization");
	});
});

/**
 * `codeAgentsEnabled` is the client's only source for the Chats | Agents
 * switch (the universal layout load spreads feature-flags over its data), so
 * this flag decides whether a person sees the switch at all. It answers per
 * person (ADR 0096): the gateway's `capabilities.code_agents` for the
 * caller's own token, deny until the gateway says true, the deployment switch
 * alone where there is no gateway. A deployment-wide answer here is the bug
 * that showed every owner's chat-only test user the switch.
 */
describe("GET /api/v2/feature-flags answers codeAgentsEnabled per person", () => {
	const GATEWAY_BASE = "http://gateway.invalid/v1";

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

	/** A signed-in gateway person: a real session row carrying an oauth token,
	 * a user the stubbed `/v1/me` answers for, and that answer's
	 * `capabilities` (`undefined` sends no capabilities key at all). */
	async function gatewayPerson(capabilities?: unknown) {
		const person = await createTestUser();
		const gatewayUserId = `gw-${person.user._id.toString()}`;
		await collections.users.updateOne({ _id: person.user._id }, { $set: { gatewayUserId } });
		const token = `tok-${person.session.sessionId}`;
		await collections.sessions.updateOne(
			{ sessionId: person.session.sessionId },
			{
				$set: {
					oauth: { token: { value: token, expiresAt: new Date(Date.now() + 3_600_000) } },
				},
			}
		);
		const body = {
			id: gatewayUserId,
			is_admin: false,
			groups: [],
			sessions_valid_after: null,
			merged_at: null,
			...(capabilities === undefined ? {} : { capabilities }),
		};
		return { locals: createTestLocals({ sessionId: person.session.sessionId, token }), body };
	}

	async function flagsFor(locals: App.Locals): Promise<FeatureFlags> {
		const res = await testRequest(featureFlagsGET, { path: "/api/v2/feature-flags", locals });
		return parseResponse<FeatureFlags>(res);
	}

	beforeEach(async () => {
		await ready;
	});

	afterEach(async () => {
		configState.openaiBaseUrl = undefined;
		configState.useUserToken = undefined;
		configState.codeAgentsEnabled = undefined;
		vi.unstubAllGlobals();
		await cleanupTestData();
	});

	it("a person the gateway denies gets false, on a deployment whose switch is on", async () => {
		configState.openaiBaseUrl = GATEWAY_BASE;
		configState.useUserToken = true;
		const { locals, body } = await gatewayPerson({ code_agents: false });
		stubMe({ status: 200, body });

		expect(await flagsFor(locals)).toMatchObject({ codeAgentsEnabled: false });
	});

	it("a person the gateway allows gets true", async () => {
		configState.openaiBaseUrl = GATEWAY_BASE;
		configState.useUserToken = true;
		const { locals, body } = await gatewayPerson({ code_agents: true });
		stubMe({ status: 200, body });

		expect(await flagsFor(locals)).toMatchObject({ codeAgentsEnabled: true });
	});

	it("a gateway that cannot be asked: false until it answers", async () => {
		configState.openaiBaseUrl = GATEWAY_BASE;
		configState.useUserToken = true;
		const { locals } = await gatewayPerson({ code_agents: true });
		stubMe({ down: true });

		expect(await flagsFor(locals)).toMatchObject({ codeAgentsEnabled: false });
	});

	it("an older gateway (no capabilities key in the body) still reads as allowed", async () => {
		configState.openaiBaseUrl = GATEWAY_BASE;
		configState.useUserToken = true;
		const { locals, body } = await gatewayPerson(undefined);
		stubMe({ status: 200, body });

		expect(await flagsFor(locals)).toMatchObject({ codeAgentsEnabled: true });
	});

	it("a caller with no token on a gateway deployment: false", async () => {
		configState.openaiBaseUrl = GATEWAY_BASE;
		configState.useUserToken = true;
		stubMe({ status: 200, body: {} });

		expect(await flagsFor(createTestLocals())).toMatchObject({ codeAgentsEnabled: false });
	});

	it("without a gateway the deployment switch alone decides, as before", async () => {
		// No OPENAI_BASE_URL: the generic preset. The suite's switch is on,
		// and nobody is asked or refused for it.
		expect(await flagsFor(createTestLocals())).toMatchObject({ codeAgentsEnabled: true });
	});

	it("the deployment switch off is off for everyone, even a person the gateway allows", async () => {
		configState.codeAgentsEnabled = false;
		configState.openaiBaseUrl = GATEWAY_BASE;
		configState.useUserToken = true;
		const { locals, body } = await gatewayPerson({ code_agents: true });
		stubMe({ status: 200, body });

		expect(await flagsFor(locals)).toMatchObject({ codeAgentsEnabled: false });
	});
});

const publicConfigRequest = () =>
	testRequest(publicConfigGET, { path: "/api/v2/public-config", locals: createTestLocals() });

describe("GET /api/v2/public-config", () => {
	it("exposes only PUBLIC_-prefixed keys", async () => {
		const res = await publicConfigRequest();
		const data = await parseResponse<Record<string, unknown>>(res);

		const keys = Object.keys(data);
		expect(keys.length).toBeGreaterThan(0);

		const leaked = keys.filter((key) => !key.startsWith("PUBLIC_"));
		expect(leaked).toEqual([]);
	});

	it("never leaks server-only secrets", async () => {
		const res = await publicConfigRequest();
		const data = await parseResponse<Record<string, unknown>>(res);

		for (const secret of [
			"OPENAI_API_KEY",
			"HF_TOKEN",
			"MONGODB_URL",
			"OPENID_CLIENT_SECRET",
			"ADMIN_API_SECRET",
			"ADMIN_TOKEN",
			"EXA_API_KEY",
		]) {
			expect(data).not.toHaveProperty(secret);
		}

		const suspicious = Object.entries(data).filter(
			([, value]) => typeof value === "string" && /^(hf_|sk-)/.test(value)
		);
		expect(suspicious).toEqual([]);
	});

	it("serves known public config with a private cache header", async () => {
		const res = await publicConfigRequest();
		const data = await parseResponse<Record<string, unknown>>(res);

		expect(data).toHaveProperty("PUBLIC_APP_NAME");
		expect(typeof data.PUBLIC_APP_NAME).toBe("string");

		expect(res.headers.get("Cache-Control")).toBe("private, max-age=60");
	});
});
