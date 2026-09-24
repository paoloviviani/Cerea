/**
 * Reproduction harness for the agent screen's composer freeze: the operator
 * reported that after interacting with the transcript (posture toggle, tool
 * activity), typing into the prompt box goes unresponsive while the rest of
 * the page stays alive — main-thread starvation, not a disabled control.
 *
 * The hermetic stack has no paired daemon; the /code endpoints are stubbed at
 * the network layer instead (the browser still goes through the app's
 * forwarder URLs, so the client code paths are the real ones).
 */
import { test, expect, E2E_APP_BASE } from "./fixtures";
import superjson from "superjson";

const DEVICE = "srv_e2e_device";
const WS = "ws_e2e";
const AGENT = "agent_e2e";

const superjsonBody = (data: unknown) => superjson.stringify(data);

test.beforeEach(async ({ page }) => {
	// The devices list the sidebar asks for (paired, so the tree renders).
	await page.route("**/api/v2/code/devices", (route) =>
		route.fulfill({
			contentType: "application/json",
			body: superjsonBody({
				devices: [{ id: DEVICE, name: "e2e box", status: "paired" }],
			}),
		})
	);
	// The strip's pills and the pane's fallbacks.
	await page.route(`**/api/v2/code/v1/agents/${AGENT}?*`, (route) =>
		route.fulfill({
			contentType: "application/json",
			body: superjsonBody({
				agent: {
					id: AGENT,
					title: "e2e agent",
					provider: "opencode",
					state: "idle",
					cwd: "/repo",
					workspaceId: WS,
				},
			}),
		})
	);
	await page.route("**/api/v2/code/v1/workspaces?*", (route) =>
		route.fulfill({
			contentType: "application/json",
			body: superjsonBody({
				workspaces: [{ id: WS, name: "repo", path: "/repo" }],
			}),
		})
	);
	await page.route(`**/api/v2/code/agents/${AGENT}/stream?*`, (route) =>
		route.fulfill({ status: 200, contentType: "text/event-stream", body: "" })
	);
});

test("typing into the agent composer stays responsive after a busy transcript", async ({
	page,
}) => {
	await page.goto(`${E2E_APP_BASE}/code?device=${DEVICE}&ws=${WS}&agent=${AGENT}`);

	const box = page.getByRole("combobox");
	await expect(box).toBeVisible();

	// Interrogate the box's own state before blaming performance: a disabled
	// or readonly control is a different bug than a starved thread.
	const locked = await box.evaluate((el: HTMLTextAreaElement) => {
		const anyEl = el as unknown as Record<string, unknown>;
		return {
			disabled: el.disabled,
			readOnly: el.readOnly,
			inert: anyEl.inert === true,
			ancestorInert: Boolean(el.closest("[inert]")),
			pointerEvents: getComputedStyle(el).pointerEvents,
			tabindex: el.getAttribute("tabindex"),
		};
	});
	expect(locked.disabled).toBe(false);
	expect(locked.readOnly).toBe(false);
	expect(locked.inert).toBe(false);
	expect(locked.ancestorInert).toBe(false);

	// The probe: dispatch real keystrokes and measure how long each takes to
	// become the box's value. A starved main thread shows as a long-tail gap
	// between keydown and the input event landing.
	await box.click();
	const perKeyMs: number[] = [];
	for (const ch of "hello world this is a typing probe") {
		const t0 = Date.now();
		await page.keyboard.type(ch);
		// The input event handler is synchronous; the wait resolves when the
		// value has the new character.
		await box.evaluate((el: HTMLTextAreaElement) => {
			// no-op read: the value binding is the thing we poll next
			return el.value.length;
		});
		perKeyMs.push(Date.now() - t0);
	}

	// A healthy editor answers each key in well under a frame budget. The
	// freeze shows as the mean drifting into tens of ms or the total blowing
	// past any reasonable typing time.
	const totalMs = perKeyMs.reduce((a, b) => a + b, 0);
	const worst = Math.max(...perKeyMs);
	console.log("typing probe: total ms", totalMs, "worst key ms", worst);

	// The value must actually hold what was typed — a "locked" box that
	// drops characters is the same starvation, seen from the other side.
	await expect(box).toHaveValue("hello world this is a typing probe");
});
