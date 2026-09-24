/**
 * Hermetic e2e stack — no API keys, no external services, no network.
 *
 * The `webServer` array below is the startup order, and it is load-bearing: the app throws at
 * boot without `${OPENAI_BASE_URL}/models` and `process.exit(1)`s without Mongo, so both must be
 * listening first. `globalSetup` cannot do this — the runner builds `webServer` tasks before
 * global-setup tasks.
 *
 * Addresses are always IP literals, never `localhost`: `ssrfSafeFetch` blocks `localhost` (it
 * resolves to `::1`) but allows literals, since undici only runs its SSRF `lookup` hook for
 * hostnames needing DNS.
 *
 * Serial because one app and one database are shared and the `db` fixture wipes between tests.
 * Raising `PLAYWRIGHT_WORKERS` also means scoping scenarios per conversation and rethinking the
 * wipe.
 */
import { existsSync } from "node:fs";
import { defineConfig, devices } from "playwright/test";
import {
	E2E_APP_BASE,
	E2E_APP_ORIGIN,
	E2E_APP_PORT,
	E2E_APP_URL,
	E2E_DB_NAME,
	E2E_GALOPIN_DIST_DIR,
	E2E_MONGO_PORT,
	E2E_MONGO_URL,
	MOCK_MCP_ORIGIN,
	MOCK_OIDC_ISSUER,
	MOCK_OPENAI_BASE_URL,
	MOCK_OPENAI_ORIGIN,
} from "./tests/fixtures.ts";

/** Node < 22.18 needs the flag; on newer versions it is accepted and inert. */
const NODE_TS = "node --experimental-strip-types --no-warnings";

const isCI = Boolean(process.env.CI);

export default defineConfig({
	testDir: "./tests",
	testMatch: /.*\.spec\.ts/,
	outputDir: "./test-results",

	fullyParallel: false,
	workers: Number(process.env.PLAYWRIGHT_WORKERS ?? 1),
	forbidOnly: isCI,
	retries: isCI ? 2 : 0,

	timeout: 60_000,
	expect: { timeout: 15_000 },

	reporter: isCI
		? [["list"], ["html", { outputFolder: "playwright-report", open: "never" }]]
		: [["list"]],

	use: {
		// The origin only, never `E2E_APP_URL` (which folds in `E2E_APP_BASE`):
		// `page.goto`/`page.request` resolve a leading `/path` as absolute,
		// discarding whatever path a `baseURL` carries, so a base-path spec
		// splices `E2E_APP_BASE` onto its own navigation string instead (see
		// `tests/fixtures.ts`). A `baseURL` with a path would just be dead
		// weight here, never actually applied.
		baseURL: E2E_APP_ORIGIN,
		trace: "on-first-retry",
		screenshot: "only-on-failure",
		video: "retain-on-failure",
	},

	projects: [
		{ name: "chromium", use: { ...devices["Desktop Chrome"] } },
		// Not optional — the worst regression cluster in this repo is Safari-specific scroll and
		// layout behaviour.
		{ name: "webkit", use: { ...devices["Desktop Safari"] } },
	],

	webServer: [
		{
			// Database first — the app exits if it cannot connect.
			command: `${NODE_TS} tests/fixtures.ts`,
			port: E2E_MONGO_PORT,
			reuseExistingServer: !isCI,
			timeout: 120_000,
			stdout: "pipe",
			stderr: "pipe",
		},
		{
			// Then the LLM upstream — the app throws at boot without /v1/models.
			command: `${NODE_TS} tests/mock-openai.ts`,
			url: `${MOCK_OPENAI_ORIGIN}/__control/health`,
			reuseExistingServer: !isCI,
			timeout: 30_000,
			stdout: "pipe",
			stderr: "pipe",
		},
		{
			// The issuer of machine tokens: the agent's WSS bearer is validated against its JWKS.
			command: `${NODE_TS} tests/mock-oidc.ts`,
			url: `${MOCK_OIDC_ISSUER}/__control/health`,
			reuseExistingServer: !isCI,
			timeout: 30_000,
			stdout: "pipe",
			stderr: "pipe",
		},
		{
			command: `${NODE_TS} tests/mock-mcp.ts`,
			url: `${MOCK_MCP_ORIGIN}/health`,
			reuseExistingServer: !isCI,
			timeout: 30_000,
			stdout: "pipe",
			stderr: "pipe",
		},
		{
			// The app last, through `server.js` — the same entry point production uses, rather than
			// `vite preview`. Two reasons: it exercises the polka compression config that keeps
			// `application/jsonl` unbuffered, and it loads no vite/svelte config, so the
			// `dotenv.config({ override: true })` in svelte.config.js cannot replace the hermetic
			// values below with whatever a developer has in `.env.local`.
			// E2E_SKIP_BUILD=1 serves an existing `build/` as is. On a small box the
			// production build (~2 GB) plus the stack it tests can exceed memory, so
			// build once alone (`npm run build`), then run specs against it.
			command:
				process.env.E2E_SKIP_BUILD === "1" && existsSync("build/handler.js")
					? "node server.js"
					: "npm run build && node server.js",
			// `/healthcheck` rather than the bare root: under `E2E_APP_BASE` a
			// request outside the base 404s, which Playwright's readiness probe
			// treats as "not up yet" forever. `/healthcheck` is base-relative and
			// exempt from auth (`hooks/handle.ts`), so it answers 200 either way.
			url: `${E2E_APP_URL}/healthcheck`,
			reuseExistingServer: !isCI,
			timeout: Number(process.env.E2E_WEBSERVER_TIMEOUT_MS ?? 600_000),
			// Request logging at info level buries the test results; errors still reach stderr.
			stdout: "ignore",
			stderr: "pipe",
			env: {
				HOST: "127.0.0.1",
				PORT: String(E2E_APP_PORT),
				LOG_LEVEL: "warn",
				OPENAI_BASE_URL: MOCK_OPENAI_BASE_URL,
				OPENAI_API_KEY: "e2e-test-key",
				MONGODB_URL: E2E_MONGO_URL,
				MONGODB_DB_NAME: E2E_DB_NAME,
				MONGODB_DIRECT_CONNECTION: "true",
				// The compile-time base path (svelte.config.js): unset unless
				// `E2E_APP_BASE` is given, which only matters for the build step
				// (`E2E_SKIP_BUILD=1` runs use a `build/` already compiled with it).
				APP_BASE: E2E_APP_BASE,
				// Bare origin, deliberately never `E2E_APP_URL`: live's compose sets
				// `PUBLIC_ORIGIN` bare too and only `ORIGIN` (adapter-node's own,
				// unused here — no proxy sits in front of this webServer, so the
				// Host header the browser sends is already correct) carries the
				// base path suffix.
				PUBLIC_ORIGIN: E2E_APP_ORIGIN,
				PUBLIC_APP_ASSETS: "chatui",
				COOKIE_NAME: "hf-chat",
				// A production build defaults `secure` to true and the app re-sets the session
				// cookie on every POST. Playwright's APIRequestContext enforces `Secure` strictly
				// over plain HTTP, so without this every `request.post` lands on a new session.
				COOKIE_SECURE: "false",
				COOKIE_SAMESITE: "lax",
				// Deterministic surface: no DB-driven config, no router, no ambient MCP servers.
				ENABLE_CONFIG_MANAGER: "false",
				MCP_SERVERS: "[]",
				// Artifact surfaces for the tool-based artifacts spec: the tool
				// model gets the `artifact` tool (tools + artifacts), the tags
				// model keeps inline `<artifact>` tags (artifacts without
				// tools). Every other spec's model is untouched.
				MODELS: JSON.stringify([
					{ id: "test-org/artifact-tool", supportsArtifacts: true },
					{ id: "test-org/artifact-tags", supportsArtifacts: true },
				]),
				// Without this the SSRF guard drops every loopback MCP URL a spec passes.
				MCP_ALLOW_INSECURE_URLS: "true",
				// Scaled down together (production is 60000 / 90000 / 10000) so a reaper
				// test sees a dead run finalized within its lifetime, while a live run
				// heartbeating every second stays comfortably under the 5s stale threshold.
				GENERATION_REAP_INTERVAL_MS: "1000",
				GENERATION_REAP_AFTER_MS: "5000",
				GENERATION_HEARTBEAT_MS: "1000",
				LLM_ROUTER_ROUTES_PATH: "",
				LLM_ROUTER_ARCH_BASE_URL: "",
				// The /code surface's own tests mount it; the flag is the same
				// gate production sets (the route 404s without it).
				CODE_AGENTS_ENABLED: "true",
				// The machine pairing endpoint validates its bearer against the
				// issuer; the e2e stack has none, so point discovery at a port
				// nothing listens on — the failure is instant and local, which
				// is what the endpoint's 401 spec asserts on. The pairing
				// dialog's printed --issuer also reads this value (via the
				// feature-flags endpoint), which is why it is deliberately not
				// PUBLIC_ORIGIN-shaped: a spec asserting on the printed command
				// then catches a regression back to a hardcoded origin-derived
				// issuer.
				OPENID_PROVIDER_URL: "http://127.0.0.1:9/authelia",
				// Machine tokens come from the mock issuer; the browser login stays unconfigured.
				CODE_MACHINE_ISSUER: MOCK_OIDC_ISSUER,
				// galopin's public downloads (`{base}/galopin/*`), filled by galopin-dist.spec.ts.
				GALOPIN_DIST_DIR: E2E_GALOPIN_DIST_DIR,
				ALLOW_IFRAME: "true",
				NODE_ENV: "production",
			},
		},
	],
});
