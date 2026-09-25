/**
 * Attachments, end to end.
 *
 * Chat: a picked file becomes a chip, is sent, and still opens after a reload
 * from chat's own page-relative route (`conversation/[id]/output/[sha]`) —
 * the path `UploadedFile` derives when no `fileBaseUrl` is given, which the
 * owner-keyed store's seam must leave untouched. A long paste still becomes
 * a clipboard chip through the extracted paste rule.
 *
 * `/code`: the owner-keyed store's routes over real HTTP — upload, list by
 * message, download-only serving, another session's refusal, and the revoke
 * path's cleanup.
 */
import { test, expect, installSession, E2E_APP_URL, E2E_APP_BASE } from "./fixtures";
import { randomUUID as deviceIdSeed } from "node:crypto";
import { seedUser } from "./machineHarness";
import { ObjectId } from "mongodb";
import superjson from "superjson";

const NOTE = "attachment body that must survive a reload";

test("a picked file is sent and still opens from chat's route after a reload", async ({
	page,
	mockOpenAI,
}) => {
	await mockOpenAI.setDefaultScenario("plainText");
	await page.goto(`${E2E_APP_BASE}/`);

	await page.getByLabel("Upload file").setInputFiles({
		name: "notes.txt",
		mimeType: "text/plain",
		buffer: Buffer.from(NOTE),
	});
	// The composer's chip strip (ComposerFileChips).
	await expect(page.getByText("notes.txt")).toBeVisible();

	await page.getByPlaceholder("Ask anything").fill("read my notes");
	await page.getByRole("button", { name: "Send message" }).click();
	await page.waitForURL(/\/conversation\/[a-f0-9]{24}/);
	const conversationId = page.url().split("/").pop() ?? "";
	await expect(page.locator('[data-message-role="assistant"]').last()).toContainText(
		"Hello from the mock server."
	);

	await page.reload();
	const served = page.waitForResponse((res) =>
		res.url().includes(`/conversation/${conversationId}/output/`)
	);
	await page.getByText("notes.txt").first().click();
	const response = await served;
	expect(response.status()).toBe(200);
	expect(response.headers()["content-disposition"]).toMatch(/^attachment;/);
	await expect(page.getByText(NOTE)).toBeVisible();
});

test("a long paste becomes a clipboard chip", async ({ page, browserName }) => {
	test.skip(browserName !== "chromium", "WebKit ignores clipboardData on synthetic paste events");
	await page.goto(`${E2E_APP_BASE}/`);
	const composer = page.getByPlaceholder("Ask anything");
	await composer.click();
	await composer.evaluate((el) => {
		const data = new DataTransfer();
		data.setData("text", "x".repeat(5000));
		el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true }));
	});
	await expect(page.getByText("Pasted Content")).toBeVisible();
	await expect(page.getByText("Clipboard source")).toBeVisible();
	await expect(composer).toHaveValue("");
});

test.describe("/code attachment routes", () => {
	const PNG = Buffer.from(
		"89504e470d0a1a0a0000000d4948445200000001000000010806000000" +
			"1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082",
		"hex"
	);

	test("upload, list, serve, refuse another session, and clean up on revoke", async ({
		page,
		db,
		session,
		browser,
	}) => {
		// The /code surface needs a signed-in user (C6), and devices are user-owned.
		const userId = await seedUser(db, session.sessionId, `e2e-${deviceIdSeed()}`);
		const deviceId = new ObjectId();
		await db.collection("codeDevices").insertOne({
			_id: deviceId,
			userId,
			machineId: deviceIdSeed(),
			name: "e2e box",
			status: "paired",
			createdAt: new Date(),
			updatedAt: new Date(),
		});
		const key = `code:${deviceId.toHexString()}:ses_e2e`;
		const base = `${E2E_APP_URL}/api/v2/code/attachments/${encodeURIComponent(key)}`;

		const uploaded = await page.request.post(base, {
			// Without `origin` the CSRF guard rejects the multipart body.
			headers: { origin: E2E_APP_URL },
			multipart: {
				messageId: "msg-e2e",
				files: { name: "shot.png", mimeType: "image/png", buffer: PNG },
			},
		});
		expect(uploaded.status()).toBe(200);
		const { files } = superjson.parse<{ files: Array<{ value: string; name: string }> }>(
			await uploaded.text()
		);
		expect(files).toHaveLength(1);
		expect(files[0].name).toBe("shot.png");

		const listed = await page.request.get(`${base}?messageId=msg-e2e`);
		expect(superjson.parse<{ files: unknown[] }>(await listed.text()).files).toEqual(files);

		const bytes = await page.request.get(`${base}/${files[0].value}`);
		expect(bytes.status()).toBe(200);
		expect(bytes.headers()["content-type"]).toBe("image/png");
		expect(bytes.headers()["content-disposition"]).toMatch(/^attachment;/);
		expect(bytes.headers()["content-security-policy"]).toContain("sandbox");
		expect(Buffer.from(await bytes.body())).toEqual(PNG);

		// The browser can render it as an image even though navigating downloads it.
		await page.goto(`${E2E_APP_BASE}/`);
		const width = await page.evaluate(async (src) => {
			const img = new Image();
			img.src = src;
			await img.decode();
			return img.naturalWidth;
		}, `${base}/${files[0].value}`);
		expect(width).toBe(1);

		// Another signed-in person: the device is not theirs, so it does not exist for them.
		const stranger = await browser.newContext();
		const strangerSession = await installSession(stranger);
		await seedUser(db, strangerSession.sessionId, `stranger-${deviceIdSeed()}`);
		for (const url of [`${base}?messageId=msg-e2e`, `${base}/${files[0].value}`]) {
			expect((await stranger.request.get(url)).status()).toBe(404);
		}
		await stranger.close();

		const revoked = await page.request.delete(
			`${E2E_APP_URL}/api/v2/code/devices?id=${deviceId.toHexString()}`,
			{ headers: { origin: E2E_APP_URL } }
		);
		expect(revoked.status()).toBe(200);
		expect(
			await db.collection("files.files").countDocuments({ "metadata.conversation": key })
		).toBe(0);
	});
});
