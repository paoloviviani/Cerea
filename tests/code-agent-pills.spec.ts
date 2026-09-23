/**
 * The composer's mode and model pills, hermetically: the /code endpoints are
 * stubbed at the network layer, so the client code paths are the real ones.
 *
 * What is pinned here: the pills render inside the prompt box labelled from
 * the agent snapshot; opening one lists the daemon's live options (modes =
 * paseo's permission vocabulary, models = the provider's list); selecting
 * calls the forwarder's mode/model switch; and the pill only claims the new
 * value after the refreshed snapshot says so — the apply never trusts its
 * own request.
 */
import { test, expect } from "./fixtures";
import superjson from "superjson";

const DEVICE = "srv_e2e_device";
const WS = "ws_e2e";
const AGENT = "agent_e2e";

const superjsonBody = (data: unknown) => superjson.stringify(data);

const MODES = [
	{ id: "plan", label: "Plan", description: "Proposes; asks before it writes." },
	{ id: "build", label: "Build", description: "May edit files." },
];

const MODELS = [
	{ id: "pystino/coder-large", label: "Coder Large", isDefault: true },
	{ id: "pystino/coder-flash", label: "Coder Flash" },
];

/** The switch bodies the stub recorded, per test. */
let modeBodies: unknown[] = [];
let modelBodies: unknown[] = [];

test.beforeEach(async ({ page }) => {
	modeBodies = [];
	modelBodies = [];

	// The devices list the sidebar asks for (paired, so the tree renders).
	await page.route("**/api/v2/code/devices", (route) =>
		route.fulfill({
			contentType: "application/json",
			body: superjsonBody({
				devices: [{ id: DEVICE, name: "e2e box", status: "paired" }],
			}),
		})
	);

	// The agent snapshot — mutable, so a switch's refetch answers with the
	// state the daemon would report after applying it.
	let agent = {
		id: AGENT,
		title: "e2e agent",
		provider: "opencode",
		state: "idle",
		cwd: "/repo",
		workspaceId: WS,
		modeId: "plan",
		modelId: "pystino/coder-large",
	};
	await page.route(`**/api/v2/code/v1/agents/${AGENT}?*`, (route) =>
		route.fulfill({
			contentType: "application/json",
			body: superjsonBody({ agent, features: [], cwd: "/repo" }),
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
	await page.route("**/api/v2/code/v1/agents?*", (route) =>
		route.fulfill({ contentType: "application/json", body: superjsonBody({ agents: [] }) })
	);

	// The two live option lists the pills read.
	await page.route("**/api/v2/code/v1/providers/opencode/modes?*", (route) =>
		route.fulfill({ contentType: "application/json", body: superjsonBody({ modes: MODES }) })
	);
	await page.route("**/api/v2/code/v1/providers/opencode/models?*", (route) =>
		route.fulfill({ contentType: "application/json", body: superjsonBody({ models: MODELS }) })
	);

	// The switches: record the body, then answer as the daemon would, so the
	// refetch the apply triggers reports the applied state.
	await page.route(`**/api/v2/code/v1/agents/${AGENT}/mode?*`, async (route) => {
		const body = route.request().postDataJSON() as { modeId: string };
		modeBodies.push(body);
		agent = { ...agent, modeId: body.modeId };
		await route.fulfill({
			contentType: "application/json",
			body: superjsonBody({ ok: true, notice: null }),
		});
	});
	await page.route(`**/api/v2/code/v1/agents/${AGENT}/model?*`, async (route) => {
		const body = route.request().postDataJSON() as { modelId: string };
		modelBodies.push(body);
		agent = { ...agent, modelId: body.modelId };
		await route.fulfill({
			contentType: "application/json",
			body: superjsonBody({ ok: true }),
		});
	});

	await page.route(`**/api/v2/code/agents/${AGENT}/stream?*`, (route) =>
		route.fulfill({ status: 200, contentType: "text/event-stream", body: "" })
	);
});

test("the pills show the snapshot's values and apply a mode switch live", async ({ page }) => {
	await page.goto(`/code?device=${DEVICE}&ws=${WS}&agent=${AGENT}`);

	// Both pills render inside the prompt box, labelled from the snapshot.
	const modePill = page.getByRole("button", { name: "Plan" });
	await expect(modePill).toBeVisible();
	await expect(page.getByRole("button", { name: "Coder Large" })).toBeVisible();

	// The mode menu lists the daemon's modes.
	await modePill.click();
	const menu = page.getByRole("menu");
	await expect(menu).toBeVisible();
	await expect(menu.getByRole("menuitem", { name: "Plan" })).toBeVisible();
	await expect(menu.getByRole("menuitem", { name: "Build" })).toBeVisible();

	// Selecting Build calls the switch…
	await menu.getByRole("menuitem", { name: "Build" }).click();
	expect(modeBodies).toEqual([{ modeId: "build" }]);

	// …and the pill only claims it once the refreshed snapshot agrees.
	await expect(page.getByRole("button", { name: "Build" })).toBeVisible();
	await expect(page.getByRole("button", { name: "Plan" })).toHaveCount(0);
});

test("the model pill lists the provider's models and applies a switch", async ({ page }) => {
	await page.goto(`/code?device=${DEVICE}&ws=${WS}&agent=${AGENT}`);

	await page.getByRole("button", { name: "Coder Large" }).click();
	const menu = page.getByRole("menu");
	await expect(menu).toBeVisible();
	await expect(menu.getByRole("menuitem", { name: "Coder Flash" })).toBeVisible();

	await menu.getByRole("menuitem", { name: "Coder Flash" }).click();
	expect(modelBodies).toEqual([{ modelId: "pystino/coder-flash" }]);

	await expect(page.getByRole("button", { name: "Coder Flash" })).toBeVisible();
	await expect(page.getByRole("button", { name: "Coder Large" })).toHaveCount(0);
});
