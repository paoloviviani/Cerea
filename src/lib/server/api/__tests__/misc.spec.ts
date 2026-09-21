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
			"PARQUET_EXPORT_HF_TOKEN",
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
