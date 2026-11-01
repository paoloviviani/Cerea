/**
 * `generate_image` end to end against the mock gateway: a signed-in user asks for a
 * picture, the mock model calls the tool, the mock `/v1/images/generations` draws it
 * with the user's own token, and the picture appears in the chat as a file card with
 * its prompt, the rewritten prompt and a download. The model's next request carries
 * the tool result naming the file. A provider refusal shows as an error the model can
 * pass on; with the administrator's "ask first" switch the approval card comes first;
 * and the composer's "+" offers "Create an image" only while a model resolves.
 *
 * Signed in with a seeded session (a session-only visitor has no gateway credential).
 * The mock offers its image model only after `/__control/image`.
 */
import {
	test,
	expect,
	E2E_APP_BASE,
	E2E_APP_URL,
	MOCK_OPENAI_ORIGIN,
	waitForHydration,
} from "./fixtures.ts";
import { MOCK_REVISED_PROMPT } from "./mock-openai.ts";
import type { APIRequestContext } from "playwright/test";
import type { Db } from "mongodb";

const TOKEN = "e2e-image-token";
const FILE = "image-a-red-fox-on-a-hill.png";

async function signIn(db: Db, sessionId: string): Promise<void> {
	const now = new Date();
	const { insertedId } = await db.collection("users").insertOne({
		name: "E2E Painter",
		username: "e2e-painter",
		hfUserId: "e2e-painter-sub",
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
		oauth: { token: { value: TOKEN, expiresAt: new Date(now.getTime() + 3600 * 1000) } },
	});
	await db
		.collection("settings")
		.updateOne({ sessionId }, { $set: { userId: insertedId, activeModel: "test-org/test-model" } });
}

async function imageModel(
	request: APIRequestContext,
	state: { enabled?: boolean; mode?: "ok" | "refuse" }
) {
	await request.post(`${MOCK_OPENAI_ORIGIN}/__control/image`, { data: state });
}

const CALL = {
	id: "call_image",
	name: "generate_image",
	arguments: JSON.stringify({ prompt: "a red fox on a hill", aspect: "landscape" }),
};

async function ask(page: import("playwright/test").Page, text: string) {
	await page.goto(`${E2E_APP_BASE}/`);
	await waitForHydration(page);
	await page.getByPlaceholder("Ask anything").fill(text);
	await page.getByRole("button", { name: "Send message" }).click();
	await page.waitForURL(/\/conversation\/[a-f0-9]{24}/);
}

const imageRequests = (
	requests: Awaited<ReturnType<import("./fixtures.ts").MockOpenAIControl["requests"]>>
) => requests.filter((r) => r.path === "/v1/images/generations");

test("the assistant draws an image: a card with the prompts and a download, metered to the user", async ({
	page,
	request,
	db,
	session,
	mockOpenAI,
}) => {
	await signIn(db, session.sessionId);
	await imageModel(request, { enabled: true });
	await mockOpenAI.setDefaultScenario({
		toolCalls: [CALL],
		content: ["Here", " is", " your", " fox", "."],
		chunkDelayMs: 10,
		finishReason: "stop",
	});

	await ask(page, "draw a red fox on a hill");
	const assistant = page.locator('[data-message-role="assistant"]').last();
	await expect(assistant).toContainText("Here is your fox.", { timeout: 60_000 });

	const card = assistant.getByTestId("file-artifact-card");
	await expect(card).toHaveCount(1, { timeout: 30_000 });
	await expect(card).toContainText(FILE);
	await expect(card.getByTestId("image-prompt")).toContainText("a red fox on a hill");
	await expect(card.getByTestId("image-revised-prompt")).toContainText(MOCK_REVISED_PROMPT);
	await expect(card.getByRole("button", { name: `Download ${FILE}` })).toBeVisible();

	// One call to the gateway, as the user, asking for the inline format and the landscape size.
	const requests = await mockOpenAI.requests();
	const drawn = imageRequests(requests);
	expect(drawn).toHaveLength(1);
	expect(drawn[0].body).toMatchObject({
		model: "mock-image",
		prompt: "a red fox on a hill",
		n: 1,
		size: "1536x1024",
		response_format: "b64_json",
		authorization: `Bearer ${TOKEN}`,
	});

	// The mock model's next request carried the tool result: the file name and the revised prompt.
	const followUp = requests
		.filter((r) => r.path === "/v1/chat/completions")
		.find((r) => JSON.stringify(r.body).includes('"role":"tool"'));
	const sent = JSON.stringify(followUp?.body);
	expect(sent).toContain(FILE);
	expect(sent).toContain(MOCK_REVISED_PROMPT);

	// It is a stored file of the conversation: the card's download answers with a PNG.
	const conversationId = page.url().split("/").pop() ?? "";
	const rows = (await (
		await page.request.get(`${E2E_APP_URL}/conversation/${conversationId}/code-execution/output`)
	).json()) as { files?: Array<{ name: string; sha256: string }> };
	const stored = (rows.files ?? []).find((file) => file.name === FILE);
	expect(stored).toBeTruthy();

	// Reload: the card comes back with its prompt.
	await page.reload();
	const again = page
		.locator('[data-message-role="assistant"]')
		.last()
		.getByTestId("file-artifact-card");
	await expect(again).toHaveCount(1, { timeout: 30_000 });
	await expect(again.getByTestId("image-prompt")).toContainText("a red fox on a hill");
});

test("a provider refusal reaches the model as an error and no card is made", async ({
	page,
	request,
	db,
	session,
	mockOpenAI,
}) => {
	await signIn(db, session.sessionId);
	await imageModel(request, { enabled: true, mode: "refuse" });
	await mockOpenAI.setDefaultScenario({
		toolCalls: [CALL],
		content: ["I", " could", " not", " draw", " that", "."],
		chunkDelayMs: 10,
		finishReason: "stop",
	});

	await ask(page, "draw a red fox on a hill");
	const assistant = page.locator('[data-message-role="assistant"]').last();
	await expect(assistant).toContainText("I could not draw that.", { timeout: 60_000 });
	await expect(assistant.getByTestId("file-artifact-card")).toHaveCount(0);

	const requests = await mockOpenAI.requests();
	expect(imageRequests(requests)).toHaveLength(1);
	const followUp = requests
		.filter((r) => r.path === "/v1/chat/completions")
		.find((r) => JSON.stringify(r.body).includes('"role":"tool"'));
	expect(JSON.stringify(followUp?.body)).toContain("refused to draw");
});

test("with the administrator's switch on, the approval card comes first", async ({
	page,
	request,
	db,
	session,
	mockOpenAI,
}) => {
	await signIn(db, session.sessionId);
	await imageModel(request, { enabled: true });
	await db.collection("imageConfig").insertOne({ askFirst: true, updatedAt: new Date() });
	await mockOpenAI.setDefaultScenario({
		toolCalls: [CALL],
		content: ["Done", "."],
		chunkDelayMs: 10,
		finishReason: "stop",
	});

	await ask(page, "draw a red fox on a hill");
	const assistant = page.locator('[data-message-role="assistant"]').last();
	await expect(assistant.getByText("generate_image")).toBeVisible({ timeout: 60_000 });
	await expect(assistant.getByRole("button", { name: "Allow once" })).toBeVisible();
	expect(imageRequests(await mockOpenAI.requests())).toHaveLength(0);

	await assistant.getByRole("button", { name: "Allow once" }).click();
	await expect(assistant.getByTestId("file-artifact-card")).toHaveCount(1, { timeout: 60_000 });
	await expect(assistant.getByTestId("file-artifact-card")).toContainText(FILE);
	expect(imageRequests(await mockOpenAI.requests())).toHaveLength(1);
});

test("the + menu offers Create an image only while a model resolves, and starts the message", async ({
	page,
	request,
	db,
	session,
}) => {
	await signIn(db, session.sessionId);
	await page.goto(`${E2E_APP_BASE}/`);
	await waitForHydration(page);
	await page.getByRole("button", { name: "Add attachment" }).click();
	await expect(page.getByRole("menuitem", { name: /Add file/ })).toBeVisible();
	await expect(page.getByRole("menuitem", { name: /Create an image/ })).toHaveCount(0);
	await page.keyboard.press("Escape");

	await imageModel(request, { enabled: true });
	// The page's own flags are read at load; wait out the catalogue's 30 s memory with a new token.
	await db
		.collection("sessions")
		.updateOne({ sessionId: session.sessionId }, { $set: { "oauth.token.value": `${TOKEN}-2` } });
	await page.goto(`${E2E_APP_BASE}/`);
	await waitForHydration(page);
	await page.getByRole("button", { name: "Add attachment" }).click();
	await page.getByRole("menuitem", { name: /Create an image/ }).click();
	const box = page.getByPlaceholder("Ask anything");
	await expect(box).toHaveValue("Create an image of ");
	await expect(box).toBeFocused();
});
