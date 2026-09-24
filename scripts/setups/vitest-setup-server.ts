// Connector credentials are sealed with this (ADR 0064), and the suite should
// not depend on whoever runs it having exported one. A fixed throwaway value:
// the tests assert that sealing round-trips and rejects tampering, not that
// any particular key is secret.
process.env.CHAT_SECRET_KEY ||= "vitest-only-connector-sealing-key";

import { vi, afterAll } from "vitest";
import dotenv from "dotenv";
import { resolve } from "path";
import fs from "fs";
import { MongoMemoryServer } from "mongodb-memory-server";
import { MODELS_FIXTURE, TEST_OPENAI_BASE_URL } from "../../src/lib/server/__fixtures__/models";

let mongoServer: MongoMemoryServer;
// Load the .env file
const envPath = resolve(__dirname, "../../.env");
dotenv.config({ path: envPath });

// Read the .env file content
const envContent = fs.readFileSync(envPath, "utf-8");

// Parse the .env content
const envVars = dotenv.parse(envContent);

// Separate public and private variables
const publicEnv = {};
const privateEnv = {};

for (const [key, value] of Object.entries(envVars)) {
	if (key.startsWith("PUBLIC_")) {
		publicEnv[key] = value;
	} else {
		privateEnv[key] = value;
	}
}

// The OAuth redirect URI for MCP connectors is built from this, and there is
// no request to infer it from, so a connector test without it fails on the
// origin rather than on what it is testing. `.env` ships it empty; the value
// here is a placeholder because what the tests assert is that the redirect URI
// is *ours* and constant, never which host it names.
publicEnv["PUBLIC_ORIGIN"] ||= "https://vitest.invalid";

/*
 * Serve the model registry from a fixture instead of the network.
 *
 * `src/lib/server/models.ts` runs `await buildModels()` at module scope, guarded only by
 * `building` — which is false under Vitest. Any spec that transitively imports it therefore
 * used to hit the live upstream. This intercept keeps the real `buildModels()` code path
 * intact (fetch -> zod parse -> capability derivation -> override merge) while removing the
 * third-party dependency. Everything else falls through to the real `fetch`, so specs that
 * genuinely exercise the network (e.g. the SSRF/DNS suites) are unaffected.
 *
 * This must be installed before any module-scope `fetch` runs, which is why it lives in the
 * setup file body rather than in a `beforeAll`.
 */
const realFetch = globalThis.fetch;
const MODELS_URL = `${TEST_OPENAI_BASE_URL}/models`;

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
	const url = input instanceof Request ? input.url : String(input);

	if (url === MODELS_URL) {
		return new Response(JSON.stringify(MODELS_FIXTURE), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	}

	return realFetch(input, init);
}) as typeof fetch;

vi.mock("$env/dynamic/public", () => ({
	env: publicEnv,
}));

// The machine link's local JWT validation (`machineAuth.ts`) reads its
// issuer/audience/client id through `config.ts`, which snapshots this mocked
// env once per worker — a spec cannot override it at runtime (setting
// `config.X` throws in test mode, and `process.env` isn't read live here
// either), so `machineAuth.spec.ts`'s local discovery/JWKS server binds this
// exact fixed port and these exact values rather than random ones.
const TEST_CODE_MACHINE_ISSUER = "http://127.0.0.1:18999";
const TEST_CODE_MACHINE_AUDIENCE = "pystino-api";
const TEST_CODE_MACHINE_CLIENT_ID = "opencode-enrollment";
// `.env` ships this off (it needs a machine actually dialling in, ADR 0089); every `/code` server spec needs it on, or `requireCodeAgents`
// 404s before the handler under test ever runs.
const TEST_CODE_AGENTS_ENABLED = "true";

vi.mock("$env/dynamic/private", async () => {
	// A CPU without AVX cannot run the memory server's binary (MongoDB 5.0+
	// requires it), and neither can a locked-down CI. `TEST_MONGODB_URL` opts
	// the whole server suite onto an already-running disposable Mongo instead —
	// one the caller owns, never a deployment's database: tests reset collections.
	if (process.env.TEST_MONGODB_URL) {
		return {
			env: {
				...privateEnv,
				MONGODB_URL: process.env.TEST_MONGODB_URL,
				// Pin the model registry at the intercepted fixture host. Must stay in sync with
				// the intercept above.
				OPENAI_BASE_URL: TEST_OPENAI_BASE_URL,
				CODE_MACHINE_ISSUER: TEST_CODE_MACHINE_ISSUER,
				CODE_MACHINE_AUDIENCE: TEST_CODE_MACHINE_AUDIENCE,
				CODE_MACHINE_CLIENT_ID: TEST_CODE_MACHINE_CLIENT_ID,
				CODE_AGENTS_ENABLED: TEST_CODE_AGENTS_ENABLED,
			},
		};
	}

	mongoServer = await MongoMemoryServer.create();

	return {
		env: {
			...privateEnv,
			MONGODB_URL: mongoServer.getUri(),
			// Pin the model registry at the intercepted fixture host. Must stay in sync with
			// the intercept above.
			OPENAI_BASE_URL: TEST_OPENAI_BASE_URL,
			CODE_MACHINE_ISSUER: TEST_CODE_MACHINE_ISSUER,
			CODE_MACHINE_AUDIENCE: TEST_CODE_MACHINE_AUDIENCE,
			CODE_MACHINE_CLIENT_ID: TEST_CODE_MACHINE_CLIENT_ID,
			CODE_AGENTS_ENABLED: TEST_CODE_AGENTS_ENABLED,
		},
	};
});

afterAll(async () => {
	globalThis.fetch = realFetch;

	if (mongoServer) {
		await mongoServer.stop();
	}
});
