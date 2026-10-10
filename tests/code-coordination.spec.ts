/**
 * The Permissions dialog's coordination switches, against a hermetic
 * FakeMachine that speaks the grant op (session.grantCoordination): toggling
 * a switch records the whole new set on the machine, and clearing it
 * clears the grant. The fake is the machine; its `model.coordination` map
 * is the assertion, read from this process.
 */
import { randomUUID } from "node:crypto";
import type { Page } from "playwright/test";
import { test, expect, E2E_APP_BASE, E2E_APP_URL, MOCK_OIDC_ISSUER } from "./fixtures";
import { seedUser } from "./machineHarness";
import { FakeMachine } from "./fake-machine";

async function connectFakeMachine(sub: string, name: string): Promise<FakeMachine> {
	const res = await fetch(`${MOCK_OIDC_ISSUER}/__control/mint`, {
		method: "POST",
		body: JSON.stringify({ sub }),
	});
	const { access_token: token } = (await res.json()) as { access_token: string };
	const fake = new FakeMachine(
		`${E2E_APP_URL.replace(/^http/, "ws")}/api/v2/code/machine`,
		{
			authorization: `Bearer ${token}`,
			"x-pystino-machine-id": randomUUID(),
			"x-pystino-machine-name": name,
		},
		{ policy: { workspaceRoots: [], allowFreeModels: false } }
	);
	await fake.hello();
	return fake;
}

async function pairAndStartSession(page: Page, name: string) {
	await page.goto(`${E2E_APP_BASE}/code`);
	await page.getByRole("button", { name: "Agents", exact: true }).click();
	await expect(page.getByText(name)).toBeVisible({ timeout: 15_000 });
	await page.getByRole("button", { name: "Confirm this machine" }).click();
	await page.getByRole("button", { name: "Add a workspace to this device" }).click();
	await page.getByLabel("Directory on the machine").fill("/repo");
	await page.getByLabel("Title (optional)").fill("repo");
	await page.getByRole("dialog").getByRole("button", { name: "Add workspace" }).click();
	await expect(page.getByText("repo", { exact: true })).toBeVisible();
	await page.getByRole("button", { name: "Start a coding session in this workspace" }).click();
	await page.getByRole("button", { name: "Build" }).click();
	await page.getByRole("button", { name: "Create agent" }).click();
	await expect(page.getByRole("dialog")).toHaveCount(0);
}

test.describe("the Permissions dialog's coordination switches", () => {
	let fake: FakeMachine | null = null;

	test.afterEach(async ({ page }) => {
		fake?.close();
		fake = null;
		await page.close().catch(() => {});
	});

	test("toggling records the whole new set on the machine; clearing clears it", async ({
		page,
		db,
		session,
	}) => {
		const sub = `e2e-${randomUUID()}`;
		await seedUser(db, session.sessionId, sub);
		const name = `coord-${randomUUID().slice(0, 6)}`;
		fake = await connectFakeMachine(sub, name);
		await pairAndStartSession(page, name);

		const machine = fake;
		const created = machine.model.sessions.at(-1);
		if (!created) throw new Error("the pair flow created no session");
		const sessionId = created.id;

		await page.getByRole("button", { name: "Permission details for this session" }).click();
		const options = page.getByTestId("coordination-options");
		await expect(options).toBeVisible();
		const message = options.getByText("Can find, read and message other sessions");
		const spawn = options.getByText("Can start new sessions");
		await expect(message).toBeVisible();
		await expect(spawn).toBeVisible();

		await message.click();
		const trio = ["session_list", "session_read", "session_send"];
		await expect
			.poll(() => machine.model.coordination.get(sessionId), { timeout: 15_000 })
			.toEqual(trio);

		await spawn.click();
		await expect
			.poll(() => machine.model.coordination.get(sessionId), { timeout: 15_000 })
			.toEqual([...trio, "session_spawn"]);

		await message.click();
		await expect
			.poll(() => machine.model.coordination.get(sessionId), { timeout: 15_000 })
			.toEqual(["session_spawn"]);

		await spawn.click();
		await expect
			.poll(() => machine.model.coordination.get(sessionId), { timeout: 15_000 })
			.toBeUndefined();
	});
});
