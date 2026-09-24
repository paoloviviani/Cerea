/**
 * Removing a device's pairing from the sidebar — the trash button on a
 * paired row, and the reject button on a pending one — must send a real
 * DELETE to `/api/v2/code/devices?id=...` and drop the row from the tree.
 * This had never been exercised by any spec: `listDevices` returned every
 * row regardless of `status`, so a revoked device kept rendering exactly
 * like a live one and the action looked like it did nothing. Runs under
 * `E2E_APP_BASE` too (set it to `/chat` in the environment) — live serves
 * Cerea behind that base path.
 */
import { test, expect, E2E_APP_BASE } from "./fixtures";
import { ObjectId } from "mongodb";
import { seedUser } from "./machineHarness";
import type { Db } from "mongodb";

async function seedDevice(
	db: Db,
	userId: ObjectId,
	overrides: Record<string, unknown> = {}
): Promise<ObjectId> {
	const deviceId = new ObjectId();
	const now = new Date();
	await db.collection("codeDevices").insertOne({
		_id: deviceId,
		userId,
		machineId: `srv_e2e_${deviceId.toHexString()}`,
		name: "real e2e box",
		status: "paired",
		sub: "e2e-sub",
		iss: "https://issuer.example.org",
		backends: [],
		policy: { autoAccept: "denied", workspaceRoots: [], allowFreeModels: false },
		credentialState: "ok",
		createdAt: now,
		updatedAt: now,
		pairedAt: now,
		...overrides,
	} as never);
	return deviceId;
}

test("removing a paired device sends a real DELETE and the row goes away", async ({
	page,
	db,
	session,
}) => {
	const userId = await seedUser(db, session.sessionId, "e2e-sub");
	const deviceId = await seedDevice(db, userId);

	const deletes: number[] = [];
	page.on("requestfinished", async (req) => {
		if (req.method() === "DELETE" && req.url().includes("/api/v2/code/devices")) {
			deletes.push((await req.response())?.status() ?? 0);
		}
	});

	await page.goto(`${E2E_APP_BASE}/code`);
	await page.getByRole("button", { name: "Agents", exact: true }).click();
	await expect(page.getByText("real e2e box")).toBeVisible();

	await page.getByTitle("Remove this pairing").click();
	await expect(page.getByText("real e2e box")).toHaveCount(0, { timeout: 10_000 });

	expect(deletes, "no DELETE reached the server").toEqual([200]);
	const row = await db.collection("codeDevices").findOne({ _id: deviceId });
	expect(row?.status).toBe("revoked");
});

test("rejecting a pending device sends a real DELETE and the row goes away", async ({
	page,
	db,
	session,
}) => {
	const userId = await seedUser(db, session.sessionId, "e2e-sub");
	const deviceId = await seedDevice(db, userId, {
		status: "pending",
		credentialState: undefined,
		pairedAt: undefined,
	});

	const deletes: number[] = [];
	page.on("requestfinished", async (req) => {
		if (req.method() === "DELETE" && req.url().includes("/api/v2/code/devices")) {
			deletes.push((await req.response())?.status() ?? 0);
		}
	});

	await page.goto(`${E2E_APP_BASE}/code`);
	await page.getByRole("button", { name: "Agents", exact: true }).click();
	await expect(page.getByText("real e2e box")).toBeVisible();

	await page.getByTitle("Reject this machine").click();
	await expect(page.getByText("real e2e box")).toHaveCount(0, { timeout: 10_000 });

	expect(deletes, "no DELETE reached the server").toEqual([200]);
	const row = await db.collection("codeDevices").findOne({ _id: deviceId });
	expect(row?.status).toBe("revoked");
});
