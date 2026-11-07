/**
 * The stack's page renderer, stood in by a local Chromium on Playwright's
 * launch-server protocol (the kit's `fetch` profile runs the same protocol in a
 * box). The app reaches it through PLAYWRIGHT_WS_ENDPOINT, which turns on the
 * server-side vector PDF for slides.
 */
import { chromium } from "playwright";

import { MOCK_RENDERER_PORT } from "./mock-renderer-port.ts";

const server = await chromium.launchServer({
	host: "127.0.0.1",
	port: MOCK_RENDERER_PORT,
	// Served at the root like the kit's renderer, so the endpoint is just host and port
	wsPath: "/",
});
console.log(`mock renderer listening on ${server.wsEndpoint()}`);
const stop = () => void server.close().finally(() => process.exit(0));
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
