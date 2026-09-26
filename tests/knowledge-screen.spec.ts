/**
 * The Knowledge screen's document-reader picker (ADR 0070).
 *
 * The gateway hides the local extractor from every plain `GET /v1/models`
 * listing on purpose (Pystino a940516) — right for a chat model picker, and
 * it left this screen with no way to offer it at all. `?include=ocr`
 * surfaces it again, flagged, and this pins what the screen does with the
 * flag: every reader is listed, there is no "Automatic" entry anywhere, and
 * with nothing chosen the local one is pre-selected and labelled.
 */
import { test, expect, E2E_APP_BASE } from "./fixtures.ts";
import type { Db } from "mongodb";

/**
 * A signed-in administrator, direct in Mongo rather than through a real OIDC
 * dance (`machineHarness.ts`'s `seedUser` is the model, plus the `oauth`
 * token `admin.ts`'s `callerIdentity` needs to ask the gateway `/me` — which
 * `mock-openai.ts` answers `is_admin: true` unconditionally). No
 * `refreshToken`, so `findUser` never attempts a refresh against a token
 * that does not exist.
 */
async function installAdminSession(db: Db, sessionId: string): Promise<void> {
	const now = new Date();
	const { insertedId } = await db.collection("users").insertOne({
		name: "E2E Admin",
		username: "e2e-admin",
		hfUserId: "e2e-admin-sub",
		avatarUrl: undefined,
		createdAt: now,
		updatedAt: now,
	});
	await db.collection("sessions").insertOne({
		sessionId,
		userId: insertedId,
		expiresAt: new Date(now.getTime() + 24 * 3600 * 1000),
		createdAt: now,
		updatedAt: now,
		authTime: now,
		oauth: {
			token: { value: "e2e-admin-token", expiresAt: new Date(now.getTime() + 3600 * 1000) },
		},
	});
	await db.collection("settings").updateOne({ sessionId }, { $set: { userId: insertedId } });
}

test("every reader is listed, no Automatic, the local extractor pre-selected and labelled", async ({
	page,
	db,
	session,
}) => {
	await installAdminSession(db, session.sessionId);
	await page.goto(`${E2E_APP_BASE}/admin/knowledge`);

	// The document-extraction picker.
	const picker = page.getByLabel("Document extraction");
	await expect(picker).toBeVisible();

	// Every reader the fixture offers, upstream and local alike.
	await expect(picker.getByRole("option", { name: "mistral-ocr-4.1" })).toBeAttached();
	const localOption = picker.getByRole("option", {
		name: "Local extractor (markitdown): on this server, text-layer PDFs and Office files",
	});
	await expect(localOption).toBeAttached();

	// No "Automatic" entry anywhere on the screen, for either picker.
	await expect(page.getByText("Automatic", { exact: false })).toHaveCount(0);

	// With nothing chosen, the local extractor is pre-selected — an explicit
	// selection, not a placeholder.
	await expect(picker).toHaveValue("markitdown");
});
