import { sveltekit } from "@sveltejs/kit/vite";
import tailwindcss from "@tailwindcss/vite";
import Icons from "unplugin-icons/vite";
import { promises } from "fs";
import { defineConfig } from "vitest/config";
import { config } from "dotenv";
import { readFileSync } from "fs";

config({ path: "./.env.local" });
config({ path: "./.env" });

// used to load fonts server side for thumbnail generation
function loadTTFAsArrayBuffer() {
	return {
		name: "load-ttf-as-array-buffer",
		async transform(_src, id) {
			if (id.endsWith(".ttf")) {
				return `export default new Uint8Array([
			${new Uint8Array(await promises.readFile(id))}
		  ]).buffer`;
			}
		},
	};
}

// `vite dev`'s own http server never sees `server.js` (that file only runs
// the production build's adapter-node output), so the machine link's
// WebSocket upgrade needs the same wiring here — the app still registers its
// upgrade function on the well-known global symbol from `initServer()`
// (SvelteKit's `init` hook runs under `vite dev` too), so this plugin only
// has to forward the raw http.Server's `upgrade` event to it.
function machineLinkDevUpgrade() {
	const MACHINE_UPGRADE = Symbol.for("cerea.machineUpgrade");
	// Vite's own HMR websocket shares this same http.Server and its own
	// `upgrade` listener — every listener sees every upgrade request, so
	// this one must only ever act on its own path and otherwise do
	// nothing, never `socket.destroy()`, or it would take down HMR's
	// upgrade too. The "destroy anything else" rule belongs to production's
	// `server.js`, which has no other websocket sharing its server.
	return {
		name: "machine-link-dev-upgrade",
		configureServer(server) {
			server.httpServer?.on("upgrade", (req, socket, head) => {
				if (new URL(req.url ?? "/", "http://internal").pathname !== "/api/v2/code/machine") return;
				const upgradeHandler = (globalThis as Record<symbol, unknown>)[MACHINE_UPGRADE];
				if (typeof upgradeHandler === "function") {
					(upgradeHandler as (req: unknown, socket: unknown, head: unknown) => void)(
						req,
						socket,
						head
					);
				} else {
					socket.destroy();
				}
			});
		},
	};
}
/**
 * Everything the client tests import from node_modules. Left to discovery, Vite finds these
 * while the first test files are already running, re-bundles, and reloads the page under
 * them: under load that surfaced as a mock factory failing to resolve, or a run that never
 * produced a result. Listing them makes the cold start bundle once, before any test.
 */
const clientTestDeps = [
	"svelte",
	"svelte/animate",
	"svelte/attachments",
	"svelte/easing",
	"svelte/internal",
	"svelte/internal/client",
	"svelte/internal/disclose-version",
	"svelte/internal/flags/async",
	"svelte/internal/flags/legacy",
	"svelte/internal/flags/tracing",
	"svelte/legacy",
	"svelte/motion",
	"svelte/reactivity",
	"svelte/reactivity/window",
	"svelte/store",
	"svelte/transition",
	"svelte/events",
	"@codemirror/language",
	"@codemirror/language-data",
	"@codemirror/state",
	"@codemirror/view",
	"@xterm/addon-fit",
	"@xterm/addon-unicode11",
	"@xterm/addon-web-links",
	"@xterm/xterm",
	"bits-ui",
	"bson-objectid",
	"devalue",
	"docx-preview",
	"esm-env",
	"fflate",
	"highlight.js/lib/core",
	"highlight.js/lib/languages/bash",
	"highlight.js/lib/languages/c",
	"highlight.js/lib/languages/cpp",
	"highlight.js/lib/languages/csharp",
	"highlight.js/lib/languages/css",
	"highlight.js/lib/languages/go",
	"highlight.js/lib/languages/java",
	"highlight.js/lib/languages/javascript",
	"highlight.js/lib/languages/json",
	"highlight.js/lib/languages/markdown",
	"highlight.js/lib/languages/plaintext",
	"highlight.js/lib/languages/python",
	"highlight.js/lib/languages/rust",
	"highlight.js/lib/languages/scss",
	"highlight.js/lib/languages/shell",
	"highlight.js/lib/languages/sql",
	"highlight.js/lib/languages/typescript",
	"highlight.js/lib/languages/xml",
	"highlight.js/lib/languages/yaml",
	"htmlparser2",
	"isomorphic-dompurify",
	"json5",
	"katex",
	"katex/dist/contrib/mhchem.mjs",
	"marked",
	"pptx-glimpse",
	"remend",
	"superjson",
	"web-haptics",
	"zod",
];

export default defineConfig({
	define: {
		// The release version, from package.json at build time: the runtime env of
		// the image does not carry it (PUBLIC_VERSION is only set under `npm run`).
		__APP_VERSION__: JSON.stringify(
			JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")).version
		),
	},
	plugins: [
		tailwindcss(),
		sveltekit(),
		Icons({
			compiler: "svelte",
		}),
		loadTTFAsArrayBuffer(),
		machineLinkDevUpgrade(),
	],
	// Allow external access via ngrok tunnel host
	server: {
		port: process.env.PORT ? parseInt(process.env.PORT) : 5173,
		// Allow any ngrok-free.app subdomain (dynamic tunnels)
		// See Vite server.allowedHosts: string[] | true
		// Using leading dot matches subdomains per Vite's host check logic
		allowedHosts: ["huggingface.ngrok.io"],
	},
	optimizeDeps: {
		include: ["uuid", "sharp", "clsx"],
	},
	test: {
		coverage: {
			provider: "v8",
			// Report-only: no thresholds until a baseline exists. Once one does, thresholds
			// should only ever ratchet upward.
			reporter: ["text-summary", "html", "json-summary"],
			reportsDirectory: "./coverage",
			include: ["src/**/*.{ts,svelte}"],
			exclude: [
				"src/**/*.{test,spec}.{js,ts}",
				"src/**/__tests__/**",
				"src/**/__fixtures__/**",
				"src/**/*.d.ts",
				// Type-only modules compile away to nothing meaningful.
				"src/lib/types/**",
			],
		},
		workspace: [
			{
				// Client-side tests (Svelte components + anything needing real layout/DOM).
				// Runs a real Chromium via Playwright, so `npx playwright install chromium`
				// is a prerequisite. Selected with `--project=client`.
				extends: "./vite.config.ts",
				optimizeDeps: { include: clientTestDeps },
				test: {
					name: "client",
					environment: "browser",
					browser: {
						enabled: true,
						provider: "playwright",
						instances: [{ browser: "chromium", headless: true }],
					},
					include: ["src/**/*.svelte.{test,spec}.{js,ts}"],
					exclude: ["src/lib/server/**", "src/**/*.ssr.{test,spec}.{js,ts}"],
					setupFiles: ["./scripts/setups/vitest-setup-client.ts"],
				},
			},
			{
				// SSR tests (Server-side rendering)
				extends: "./vite.config.ts",
				test: {
					name: "ssr",
					environment: "node",
					include: ["src/**/*.ssr.{test,spec}.{js,ts}"],
				},
			},
			{
				// Server-side tests (Node.js utilities)
				extends: "./vite.config.ts",
				test: {
					name: "server",
					environment: "node",
					include: ["src/**/*.{test,spec}.{js,ts}"],
					exclude: ["src/**/*.svelte.{test,spec}.{js,ts}", "src/**/*.ssr.{test,spec}.{js,ts}"],
					setupFiles: ["./scripts/setups/vitest-setup-server.ts"],
					testTimeout: 30000,
					hookTimeout: 30000,
				},
			},
		],
	},
});
