/**
 * Config for the docs screenshots: the e2e stack of ../../playwright.config.ts (mock gateway,
 * mock issuer, fake machines, its own MongoDB), with this folder as the test directory.
 */
import { fileURLToPath } from "node:url";
import { defineConfig } from "playwright/test";
import base from "../../playwright.config.ts";

export default defineConfig({
	...base,
	testDir: ".",
	testMatch: /shots\.spec\.ts/,
	outputDir: "../../test-results/docs-screenshots",
	timeout: 180_000,
	// The base config's commands are relative to the repository root.
	webServer: (Array.isArray(base.webServer) ? base.webServer : []).map((server) => ({
		...server,
		cwd: fileURLToPath(new URL("../..", import.meta.url)),
		// Only the app itself (it is the one with a MODELS list) gets a product name and a model
		// name that reads like a real deployment's.
		env:
			server.env?.MODELS === undefined
				? server.env
				: {
						...server.env,
						PUBLIC_APP_NAME: "Cerea",
						MODELS: JSON.stringify([
							...JSON.parse(server.env.MODELS),
							{ id: "test-org/test-model", displayName: "GPT-OSS 120B" },
							{
								id: "test-org/artifact-tool",
								displayName: "GPT-OSS 120B",
								supportsArtifacts: true,
							},
						]),
					},
	})),
	projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
