/**
 * A real-WebKit check for the "New agent" dialog, run outside `playwright test`
 * because this host has no local WebKit binary — only a remote Playwright
 * server container reachable at `WEBKIT_WS` speaks the real engine.
 *
 * Not picked up by `playwright test` (testMatch is `*.spec.ts`); run it
 * directly against an already-running hermetic app:
 *
 *   E2E_APP_PORT=5202 E2E_MONGO_PORT=8792 npm run build && node server.js &
 *   node --experimental-strip-types --no-warnings tests/webkit-safari-check.ts
 *
 * Env vars (all optional, defaults match the container/app this was written
 * against):
 *   WEBKIT_WS        ws endpoint of the Playwright server  (ws://172.18.0.6:3000/)
 *   APP_BASE_URL     origin WebKit (inside the docker network) can reach the
 *                    app at — the docker bridge gateway, not 127.0.0.1
 *                    (http://172.18.0.1:5202)
 *   MONGODB_URL      mongo the app itself is using, reachable from this host
 *                    (mongodb://127.0.0.1:8792)
 *   MONGODB_DB_NAME  (chat-ui-e2e)
 *
 * Exits non-zero on the first failed assertion, printing which viewport/step
 * failed; screenshots land in test-results/webkit-safari-*.png regardless of
 * outcome so a failure can be read visually, not just asserted.
 */
import { webkit } from "playwright";
import type { Page, BrowserContext } from "playwright";
import { MongoClient } from "mongodb";
import { randomUUID, createHash } from "node:crypto";
import { strict as assert } from "node:assert";
import superjson from "superjson";

const WEBKIT_WS = process.env.WEBKIT_WS ?? "ws://172.18.0.6:3000/";
const APP_BASE_URL = process.env.APP_BASE_URL ?? "http://172.18.0.1:5202";
const MONGODB_URL = process.env.MONGODB_URL ?? "mongodb://127.0.0.1:8792";
const MONGODB_DB_NAME = process.env.MONGODB_DB_NAME ?? "chat-ui-e2e";
const COOKIE_NAME = process.env.COOKIE_NAME ?? "hf-chat";

const DEVICE = "srv_e2e_device";
const WS = "ws_e2e";
const WORKSPACE_PATH = "/home/ubuntu/workspace";

const superjsonBody = (data: unknown) => superjson.stringify(data);

function sessionIdFromSecret(secret: string): string {
	return createHash("sha256").update(secret).digest("hex");
}

async function seedSession(mongo: MongoClient): Promise<string> {
	const secret = randomUUID();
	const sessionId = sessionIdFromSecret(secret);
	const db = mongo.db(MONGODB_DB_NAME);
	const now = new Date();
	await db.collection("settings").insertOne({
		sessionId,
		welcomeModalSeenAt: now,
		shareConversationsWithModelAuthors: false,
		activeModel: "test-org/test-model",
		createdAt: now,
		updatedAt: now,
	} as never);
	return secret;
}

async function stubCodePanel(page: Page, opts: { createBehavior: "success" | "fail" | "hang" }) {
	const deviceRows: Array<Record<string, unknown>> = [
		{ id: DEVICE, name: "e2e box", status: "paired" },
	];
	await page.route("**/api/v2/code/devices", (route) =>
		route.fulfill({ contentType: "application/json", body: superjsonBody({ devices: deviceRows }) })
	);
	await page.route("**/api/v2/code/v1/workspaces?*", (route) =>
		route.fulfill({
			contentType: "application/json",
			body: superjsonBody({ workspaces: [{ id: WS, name: "repo", path: WORKSPACE_PATH }] }),
		})
	);
	await page.route("**/api/v2/code/v1/agents?*", async (route) => {
		if (route.request().method() !== "POST") {
			return route.fulfill({
				contentType: "application/json",
				body: superjsonBody({ agents: [] }),
			});
		}
		if (opts.createBehavior === "fail") {
			return route.fulfill({
				status: 500,
				contentType: "application/json",
				body: JSON.stringify({ message: "The daemon refused the request." }),
			});
		}
		if (opts.createBehavior === "hang") {
			// Never resolves within the probe's lifetime — holds the dialog in
			// its busy state so a mid-flight screenshot is possible.
			await new Promise(() => {});
			return;
		}
		return route.fulfill({
			contentType: "application/json",
			body: superjsonBody({
				agent: { id: "agent_new", provider: "opencode", posture: "plan", title: "New agent" },
			}),
		});
	});
	await page.route("**/api/v2/code/v1/providers?*", (route) =>
		route.fulfill({
			contentType: "application/json",
			body: superjsonBody({ providers: [{ id: "opencode", available: true }] }),
		})
	);
}

async function openAgentDialog(page: Page) {
	await page.goto(`${APP_BASE_URL}/code?device=${DEVICE}&ws=${WS}`);
	await page.getByRole("button", { name: "Open Agents panel" }).click();
	await page.locator("button[title='Start a coding session in this workspace']:visible").click();
	const dialog = page.getByRole("dialog");
	await dialog.waitFor({ state: "visible" });
	await dialog.getByText("As configured on your daemon.").waitFor({ state: "visible" });
	return dialog;
}

interface Box {
	x: number;
	y: number;
	width: number;
	height: number;
}

function assertInsideViewport(label: string, box: Box, width: number, height: number) {
	assert.ok(box.x >= -0.5, `${label}: x=${box.x} clipped off the left edge`);
	assert.ok(
		box.x + box.width <= width + 0.5,
		`${label}: right edge ${box.x + box.width} exceeds viewport width ${width}`
	);
	assert.ok(box.y >= -0.5, `${label}: y=${box.y} above the top edge`);
	assert.ok(
		box.y + box.height <= height + 0.5,
		`${label}: bottom edge ${box.y + box.height} exceeds viewport height ${height} (footer scrolled out of reach)`
	);
}

async function boxOf(dialog: ReturnType<Page["getByRole"]>, roleName: string) {
	const loc = dialog.getByRole("button", { name: roleName });
	const box = await loc.boundingBox();
	assert.ok(box, `no bounding box for button "${roleName}" — not rendered/visible`);
	return box as Box;
}

interface CheckResult {
	label: string;
	ok: boolean;
	error?: string;
}

const results: CheckResult[] = [];

async function check(label: string, fn: () => Promise<void>) {
	try {
		await fn();
		results.push({ label, ok: true });
		console.log(`  ✓ ${label}`);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		results.push({ label, ok: false, error: message });
		console.log(`  ✗ ${label}: ${message}`);
	}
}

async function runViewport(context: BrowserContext, name: string, width: number, height: number) {
	console.log(`\n=== ${name} (${width}x${height}) ===`);
	const page = await context.newPage();
	await page.setViewportSize({ width, height });

	// Case 1: the create request hangs — the dialog sits in its busy state
	// ("Creating..." button, everything else disabled) for as long as the
	// operator waits on a slow daemon.
	await stubCodePanel(page, { createBehavior: "hang" });
	const dialogBefore = await openAgentDialog(page);
	await page.screenshot({ path: `test-results/webkit-safari-${width}-before.png` });
	await dialogBefore.getByLabel("Title (optional)").fill("Refactor the login flow");
	await dialogBefore.getByRole("button", { name: "Create agent" }).click();
	await page.waitForTimeout(500); // let the busy state settle
	await page.screenshot({ path: `test-results/webkit-safari-${width}-busy.png` });

	await check(`${name}: dialog stays inside the viewport while busy`, async () => {
		const box = await dialogBefore.boundingBox();
		assert.ok(box, "no bounding box for dialog while busy");
		assertInsideViewport("dialog", box as Box, width, height);
	});
	await check(`${name}: footer buttons inside the viewport while busy`, async () => {
		const cancel = await boxOf(dialogBefore, "Cancel");
		assertInsideViewport("Cancel", cancel, width, height);
		const creating = await boxOf(dialogBefore, "Creating…");
		assertInsideViewport("Creating… button", creating, width, height);
	});
	await check(`${name}: computed max-height on the dialog shell is finite`, async () => {
		const maxHeight = await dialogBefore.evaluate((el) => getComputedStyle(el).maxHeight);
		assert.notEqual(maxHeight, "none", "max-height resolved to none — no cap on dialog height");
	});
	await page.close();

	// Case 2: the create request fails — the error banner mounts above the
	// form, growing the dialog's content without changing the modal shell's
	// own sizing rules.
	const page2 = await context.newPage();
	await page2.setViewportSize({ width, height });
	await stubCodePanel(page2, { createBehavior: "fail" });
	const dialogFail = await openAgentDialog(page2);
	await dialogFail.getByRole("button", { name: "Create agent" }).click();
	await dialogFail.getByText("Agent failed").waitFor({ state: "visible" });
	await page2.screenshot({ path: `test-results/webkit-safari-${width}-after-fail.png` });

	await check(`${name}: dialog stays inside the viewport after a failed create`, async () => {
		const box = await dialogFail.boundingBox();
		assert.ok(box, "no bounding box for dialog after failure");
		assertInsideViewport("dialog", box as Box, width, height);
	});
	await check(`${name}: footer buttons inside the viewport after a failed create`, async () => {
		const cancel = await boxOf(dialogFail, "Cancel");
		assertInsideViewport("Cancel", cancel, width, height);
		const create = await boxOf(dialogFail, "Create agent");
		assertInsideViewport("Create agent button", create, width, height);
		// Side by side, not stacked past a wrap that pushes one off-canvas.
		assert.ok(Math.abs(cancel.y - create.y) < 4 || create.x < width, "footer buttons misplaced");
	});
	await check(`${name}: no horizontal overflow after a failed create`, async () => {
		const overflow = await dialogFail.evaluate((el) => el.scrollWidth - el.clientWidth);
		assert.ok(overflow <= 0, `dialog scrollWidth exceeds clientWidth by ${overflow}px`);
	});
	await page2.close();
}

async function main() {
	console.log(`Connecting to WebKit at ${WEBKIT_WS} ...`);
	const browser = await webkit.connect(WEBKIT_WS);
	console.log(`Connected: WebKit ${browser.version()}`);

	const mongo = new MongoClient(MONGODB_URL, { directConnection: true });
	await mongo.connect();
	const secret = await seedSession(mongo);

	const context = await browser.newContext();
	await context.addCookies([
		{ name: COOKIE_NAME, value: secret, url: APP_BASE_URL, httpOnly: true, sameSite: "Lax" },
	]);

	try {
		await runViewport(context, "iPhone-ish", 390, 844);
		await runViewport(context, "the operator's 264px screenshot", 264, 568);
		await runViewport(context, "desktop", 1280, 800);
	} finally {
		await context.close();
		await browser.close();
		await mongo.close();
	}

	const failed = results.filter((r) => !r.ok);
	console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
	if (failed.length > 0) {
		console.log("\nFailed:");
		for (const f of failed) console.log(`  - ${f.label}: ${f.error}`);
		process.exitCode = 1;
	}
}

main().catch((err) => {
	console.error(err);
	process.exitCode = 1;
});
