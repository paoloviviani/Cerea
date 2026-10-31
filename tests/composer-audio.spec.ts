/**
 * Audio in the composer, end to end, against the mock gateway: an attached audio
 * file is transcribed once at upload (the mock's `/v1/audio/transcriptions`, with
 * the user's token) and the model's request carries the transcript; the chip
 * opens a panel with the player and the transcript; and dictation with the
 * transcription model records, sends the recording through the gateway route and
 * puts the text in the message box.
 *
 * Signed in with a seeded session, as `scanned-pdf.spec` does: a session-only
 * visitor has no gateway credential to transcribe with.
 */
import {
	test,
	expect,
	E2E_APP_BASE,
	waitForHydration,
	type MockOpenAIControl,
} from "./fixtures.ts";
import { MOCK_TRANSCRIPT } from "./mock-openai.ts";
import type { Db } from "mongodb";

async function signIn(db: Db, sessionId: string): Promise<void> {
	// No stored transcription choice: the first model of the catalogue decides.
	await db.collection("knowledgeConfig").deleteMany({});
	const now = new Date();
	const { insertedId } = await db.collection("users").insertOne({
		name: "E2E Listener",
		username: "e2e-listener",
		hfUserId: "e2e-listener-sub",
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
			token: { value: "e2e-listener-token", expiresAt: new Date(now.getTime() + 3600 * 1000) },
		},
	});
	await db
		.collection("settings")
		.updateOne({ sessionId }, { $set: { userId: insertedId, activeModel: "test-org/test-model" } });
}

/** A real, tiny mono WAV (half a second of silence). */
function wav(): Buffer {
	const data = Buffer.alloc(8000);
	const header = Buffer.alloc(44);
	header.write("RIFF", 0);
	header.writeUInt32LE(36 + data.length, 4);
	header.write("WAVEfmt ", 8);
	header.writeUInt32LE(16, 16);
	header.writeUInt16LE(1, 20);
	header.writeUInt16LE(1, 22);
	header.writeUInt32LE(8000, 24);
	header.writeUInt32LE(16000, 28);
	header.writeUInt16LE(2, 32);
	header.writeUInt16LE(16, 34);
	header.write("data", 36);
	header.writeUInt32LE(data.length, 40);
	return Buffer.concat([header, data]);
}

type Recorded = Awaited<ReturnType<MockOpenAIControl["requests"]>>[number];
const transcriptions = (requests: Recorded[]) =>
	requests.filter((r) => r.path === "/v1/audio/transcriptions");

test("an attached audio file is transcribed once and the model reads the transcript", async ({
	page,
	db,
	session,
	mockOpenAI,
}) => {
	await signIn(db, session.sessionId);
	await mockOpenAI.setDefaultScenario("plainText");
	await page.goto(`${E2E_APP_BASE}/`);
	await waitForHydration(page);

	await page.getByLabel("Upload file").setInputFiles({
		name: "standup.wav",
		mimeType: "audio/wav",
		buffer: wav(),
	});
	// The composer's chip: the name with an audio badge.
	await expect(page.getByText("standup.wav")).toBeVisible();
	await expect(page.getByTestId("audio-badge")).toBeVisible();

	await page.getByPlaceholder("Ask anything").fill("what was said?");
	await page.getByRole("button", { name: "Send message" }).click();
	await page.waitForURL(/\/conversation\/[a-f0-9]{24}/);
	await expect(page.locator('[data-message-role="assistant"]').last()).toContainText(
		"Hello from the mock server."
	);

	const requests = await mockOpenAI.requests();
	// One transcription, as the signed-in user, by the catalogue's first model.
	expect(transcriptions(requests)).toHaveLength(1);
	expect(transcriptions(requests)[0].body).toMatchObject({
		model: "mock-whisper",
		authorization: "Bearer e2e-listener-token",
	});
	// The model's request carries the transcript, labelled with the file.
	const chat = requests.filter((r) => r.path === "/v1/chat/completions").at(-1);
	const sent = JSON.stringify(chat?.body);
	expect(sent).toContain(MOCK_TRANSCRIPT);
	expect(sent).toContain("standup.wav");

	// The chip in the conversation carries the duration the gateway reported,
	// and opens the player with the transcript.
	await expect(page.getByTestId("audio-duration")).toHaveText("0:07");
	await page.getByTestId("audio-chip").click();
	await expect(page.getByTestId("audio-transcript")).toHaveText(MOCK_TRANSCRIPT);
	await expect(page.locator("audio[controls]")).toHaveAttribute("src", /\/output\/[a-f0-9]{64}$/);

	// The player can seek: the stored file answers a Range with a 206.
	const src = (await page.locator("audio[controls]").getAttribute("src")) ?? "";
	const ranged = await page.request.get(src, { headers: { range: "bytes=0-9" } });
	expect(ranged.status()).toBe(206);
	expect(ranged.headers()["content-range"]).toMatch(/^bytes 0-9\/\d+$/);
	expect(ranged.headers()["accept-ranges"]).toBe("bytes");
	expect((await ranged.body()).length).toBe(10);

	// A second question is not another transcription.
	await page.getByRole("button", { name: "Close" }).click();
	await expect(page.getByTestId("audio-panel")).toBeHidden();
	await page.getByPlaceholder("Ask anything").fill("and then?");
	await page.getByRole("button", { name: "Send message" }).click();
	await expect(page.locator('[data-message-role="assistant"]')).toHaveCount(2);
	expect(transcriptions(await mockOpenAI.requests())).toHaveLength(1);
});

test("dictation by the transcription model puts the transcript in the message box", async ({
	page,
	db,
	session,
	mockOpenAI,
}) => {
	await signIn(db, session.sessionId);
	// A real, silent MediaStream, so the real MediaRecorder has something to record
	// without a microphone.
	await page.addInitScript(() => {
		Object.defineProperty(navigator, "mediaDevices", {
			configurable: true,
			value: {
				getUserMedia: async () => {
					// A quiet tone: a context with nothing playing into it records no chunks.
					const context = new AudioContext();
					await context.resume();
					const tone = context.createOscillator();
					const gain = context.createGain();
					gain.gain.value = 0.001;
					const destination = context.createMediaStreamDestination();
					tone.connect(gain).connect(destination);
					tone.start();
					return destination.stream;
				},
			},
		});
	});
	await page.goto(`${E2E_APP_BASE}/`);
	await waitForHydration(page);

	await page.getByRole("button", { name: "Start voice recording" }).click();
	// The timer counts while recording.
	await expect(page.getByTestId("recording-timer")).toBeVisible();
	await expect(page.getByTestId("recording-timer")).not.toHaveText("0:00");
	await page.getByRole("button", { name: "Confirm and transcribe" }).click();

	await expect(page.getByPlaceholder("Ask anything")).toHaveValue(MOCK_TRANSCRIPT);
	const heard = transcriptions(await mockOpenAI.requests());
	expect(heard).toHaveLength(1);
	expect(heard[0].body).toMatchObject({ authorization: "Bearer e2e-listener-token" });
});
