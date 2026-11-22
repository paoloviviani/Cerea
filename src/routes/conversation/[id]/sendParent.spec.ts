/**
 * A send whose parent message the server does not hold (a tab that sends in the
 * instant after a turn ends still has the ids it minted for its optimistic
 * messages, until its post-turn refresh swaps in the server's) is a 409 the
 * client can act on, never the 500 with the generic toast it used to be.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ObjectId } from "mongodb";

vi.mock("$lib/server/models", () => ({
	defaultModel: { id: "m" },
	models: [],
	validateModel: () => ({ safeParse: () => ({ success: true }) }),
}));
vi.mock("$lib/server/hiddenModels", () => ({ isUnlistedForUsers: () => false }));
vi.mock("$lib/server/customModels", () => ({
	conversationOwnerFilter: () => ({}),
	isSelectableModel: async () => true,
	resolveConversationModel: async () => ({
		model: { id: "m", preprompt: "", getEndpoint: async () => ({}) },
	}),
}));
vi.mock("$lib/server/visibleModels", () => ({
	isSelectableCatalogueId: () => true,
	modelsFor: async () => [],
}));

const uploadFile = vi.hoisted(() => vi.fn(async () => ({ name: "n", type: "hash", value: "h" })));
vi.mock("$lib/server/files/uploadFile", async (orig) => ({
	...(await orig<object>()),
	uploadFile,
}));

import { collections, ready } from "$lib/server/database";
import { cleanupTestData } from "$lib/server/api/__tests__/testHelpers";
import { PARENT_NOT_FOUND_MESSAGE, MESSAGE_ID_IN_USE_MESSAGE } from "$lib/utils/sendRefusals";
import { POST } from "./+server";

beforeAll(async () => {
	await ready;
}, 30000);
afterEach(async () => {
	await cleanupTestData();
	// The turn records the specs below seed: other specs read these collections whole.
	await Promise.all([
		collections.generations.deleteMany({}),
		collections.generationEvents.deleteMany({}),
		collections.turnStates.deleteMany({}),
		collections.parkedCalls.deleteMany({}),
	]);
});

const t = new Date();
const base = { createdAt: t, updatedAt: t };
const U = "11111111-1111-4111-8111-111111111111";
const A = "22222222-2222-4222-8222-222222222222";

async function chat(sessionId: string) {
	const _id = new ObjectId();
	await collections.conversations.insertOne({
		_id,
		title: "New Chat",
		rootMessageId: U,
		model: "m",
		messages: [
			{ ...base, id: U, from: "user", content: "hi", ancestors: [], children: [A] },
			{ ...base, id: A, from: "assistant", content: "hello", ancestors: [U], children: [] },
		],
		createdAt: t,
		updatedAt: t,
		sessionId,
	} as never);
	return _id.toString();
}

const send = (id: string, sessionId: string, data: Record<string, unknown>, files: File[] = []) => {
	const form = new FormData();
	form.append("data", JSON.stringify(data));
	for (const file of files) form.append("files", file);
	return POST({
		locals: { sessionId },
		params: { id },
		getClientAddress: () => "127.0.0.1",
		request: new Request("http://localhost/conversation/" + id, { method: "POST", body: form }),
	} as never);
};

describe("sending under a parent the server does not hold", () => {
	it("answers 409 with the sync message, and stores nothing", async () => {
		const id = await chat("s1");
		const unknownParent = "33333333-3333-4333-8333-333333333333";
		await expect(send(id, "s1", { inputs: "next", id: unknownParent })).rejects.toMatchObject({
			status: 409,
			body: { message: PARENT_NOT_FOUND_MESSAGE },
		});
		const stored = await collections.conversations.findOne({ _id: new ObjectId(id) });
		expect(stored?.messages).toHaveLength(2);
	});

	it("answers 400, not 500, when a non-first send names no parent", async () => {
		const id = await chat("s2");
		await expect(send(id, "s2", { inputs: "next" })).rejects.toMatchObject({ status: 400 });
	});

	it("answers 409 for a retry or edit of a message the server does not hold", async () => {
		const id = await chat("s3");
		const unknown = "44444444-4444-4444-8444-444444444444";
		await expect(send(id, "s3", { id: unknown, is_retry: true })).rejects.toMatchObject({
			status: 409,
		});
		await expect(
			send(id, "s3", { id: unknown, is_retry: true, inputs: "edited" })
		).rejects.toMatchObject({ status: 409 });
	});

	it("refuses before uploading, transcribing or counting anything", async () => {
		const id = await chat("s4");
		uploadFile.mockClear();
		const file = new File([Buffer.from("hello")], "base64;a.txt", { type: "text/plain" });
		await expect(
			send(id, "s4", { inputs: "next", id: "55555555-5555-4555-8555-555555555555" }, [file])
		).rejects.toMatchObject({ status: 409 });
		expect(uploadFile).not.toHaveBeenCalled();
		expect(await collections.messageEvents.countDocuments({})).toBe(0);
	});
});

describe("ids the tab proposes for the messages a send creates (C156)", () => {
	const NU = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
	const NA = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
	const stored = async (id: string) =>
		(await collections.conversations.findOne({ _id: new ObjectId(id) }))?.messages ?? [];
	/**
	 * Lets the turn the accepted send started finish (it has no model to talk to).
	 * The endpoint's stream carries strings, which `response.text()` rejects on the
	 * first chunk, so it would return while the turn still ran and its closing save
	 * (the whole messages array) landed over the next send's write. Reading the
	 * stream itself waits for the close, which comes after that save.
	 */
	const settle = async (response: Response) => {
		const reader = response.body?.getReader();
		if (!reader) return;
		while (!(await reader.read()).done);
	};

	it("stores exactly the proposed ids for a normal send", async () => {
		const id = await chat("p1");
		await settle(
			await send(id, "p1", { inputs: "next", id: A, userMessageId: NU, assistantMessageId: NA })
		);
		const messages = await stored(id);
		expect(messages.map((message) => message.id)).toEqual([U, A, NU, NA]);
		expect(messages.find((message) => message.id === A)?.children).toEqual([NU]);
		expect(messages.find((message) => message.id === NU)?.children).toEqual([NA]);
		expect(messages.find((message) => message.id === NA)?.ancestors).toEqual([U, A, NU]);
	});

	it("flags every assistant message it creates with the scoped turn tag, retry and edit too", async () => {
		const id = await chat("p9");
		await settle(
			await send(id, "p9", { inputs: "next", id: A, userMessageId: NU, assistantMessageId: NA })
		);
		await settle(await send(id, "p9", { id: NA, is_retry: true }));
		await settle(await send(id, "p9", { inputs: "edited", id: NU, is_retry: true }));
		const created = (await stored(id)).filter((message) => ![U, A].includes(message.id));
		const assistants = created.filter((message) => message.from === "assistant");
		expect(assistants).toHaveLength(3);
		expect(assistants.every((message) => message.turnTagVersion === 2)).toBe(true);
		// The answer that was already stored stays as it was: no flag, so it may read the legacy tag.
		expect((await stored(id)).find((message) => message.id === A)?.turnTagVersion).toBeUndefined();
	});

	it("mints its own ids when none are proposed", async () => {
		const id = await chat("p2");
		await settle(await send(id, "p2", { inputs: "next", id: A }));
		const messages = await stored(id);
		expect(messages).toHaveLength(4);
		expect(messages.slice(2).every((message) => message.id !== NU && message.id !== NA)).toBe(true);
	});

	it("uses the proposed ids for an edit and for a retry", async () => {
		const id = await chat("p3");
		// A second turn first: the root message cannot be edited.
		await settle(
			await send(id, "p3", { inputs: "next", id: A, userMessageId: NU, assistantMessageId: NA })
		);
		const editedUser = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
		const editedAssistant = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
		await settle(
			await send(id, "p3", {
				inputs: "edited",
				id: NU,
				is_retry: true,
				userMessageId: editedUser,
				assistantMessageId: editedAssistant,
			})
		);
		let messages = await stored(id);
		expect(messages.find((message) => message.id === editedUser)?.ancestors).toEqual([U, A]);
		expect(messages.find((message) => message.id === editedAssistant)?.ancestors).toEqual([
			U,
			A,
			editedUser,
		]);
		const retried = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
		await settle(await send(id, "p3", { id: NA, is_retry: true, assistantMessageId: retried }));
		messages = await stored(id);
		expect(messages.find((message) => message.id === retried)?.ancestors).toEqual([U, A, NU]);
	});

	it("answers 400 for a malformed id, and for user and assistant ids that are the same", async () => {
		const id = await chat("p4");
		for (const bad of ["not-a-uuid", "11111111-1111-1111-8111-111111111111", ""]) {
			await expect(
				send(id, "p4", { inputs: "next", id: A, userMessageId: bad })
			).rejects.toMatchObject({ status: 400 });
		}
		await expect(
			send(id, "p4", { inputs: "next", id: A, userMessageId: NU, assistantMessageId: NU })
		).rejects.toMatchObject({ status: 400 });
		expect(await stored(id)).toHaveLength(2);
	});

	it("answers 409 for an id already in the conversation, before storing, uploading or counting", async () => {
		const id = await chat("p5");
		uploadFile.mockClear();
		const file = new File([Buffer.from("hello")], "base64;a.txt", { type: "text/plain" });
		for (const data of [
			{ inputs: "next", id: A, userMessageId: U, assistantMessageId: NA },
			{ inputs: "next", id: A, userMessageId: NU, assistantMessageId: A },
		]) {
			await expect(send(id, "p5", data, [file])).rejects.toMatchObject({
				status: 409,
				body: { message: MESSAGE_ID_IN_USE_MESSAGE },
			});
		}
		const messages = await stored(id);
		expect(messages).toHaveLength(2);
		expect(messages[0].content).toBe("hi");
		expect(messages[0].children).toEqual([A]);
		expect(uploadFile).not.toHaveBeenCalled();
		expect(await collections.messageEvents.countDocuments({})).toBe(0);
	});

	it("scopes uniqueness to the conversation: another chat's id is no conflict and attaches nowhere", async () => {
		const first = await chat("p6");
		const second = await chat("p6");
		await settle(
			await send(first, "p6", { inputs: "next", id: A, userMessageId: NU, assistantMessageId: NA })
		);
		// The same ids in the other chat: accepted, since that chat does not hold them.
		await settle(
			await send(second, "p6", {
				inputs: "next",
				id: A,
				userMessageId: NU,
				assistantMessageId: NA,
			})
		);
		expect((await stored(second)).map((message) => message.id)).toEqual([U, A, NU, NA]);
		// A message of one chat named as the parent in the other is not found there.
		await expect(
			send(second, "p6", { inputs: "x", id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" })
		).rejects.toMatchObject({ status: 409 });
	});

	it("answers 409 for an id that still owns turn records, and stores nothing", async () => {
		const id = await chat("p7");
		const conversationId = new ObjectId(id);
		const ghosts = [
			"ffffffff-ffff-4fff-8fff-ffffffffff01",
			"ffffffff-ffff-4fff-8fff-ffffffffff02",
			"ffffffff-ffff-4fff-8fff-ffffffffff03",
			"ffffffff-ffff-4fff-8fff-ffffffffff04",
		];
		await collections.generations.insertOne({
			conversationId,
			messageId: ghosts[0],
			generationId: crypto.randomUUID(),
		} as never);
		await collections.generationEvents.insertOne({
			conversationId,
			messageId: ghosts[1],
			generationId: crypto.randomUUID(),
			seq: 0,
		} as never);
		await collections.turnStates.insertOne({ conversationId, messageId: ghosts[2] } as never);
		await collections.parkedCalls.insertOne({
			conversationId,
			messageId: ghosts[3],
			parkedCallId: crypto.randomUUID(),
		} as never);
		for (const ghost of ghosts) {
			await expect(
				send(id, "p7", { inputs: "next", id: A, userMessageId: NU, assistantMessageId: ghost })
			).rejects.toMatchObject({ status: 409, body: { message: MESSAGE_ID_IN_USE_MESSAGE } });
		}
		expect(await stored(id)).toHaveLength(2);
		// The same id in a conversation that has no such records is fine.
		const clean = await chat("p7");
		await settle(
			await send(clean, "p7", {
				inputs: "next",
				id: A,
				userMessageId: NU,
				assistantMessageId: ghosts[0],
			})
		);
		expect((await stored(clean)).map((message) => message.id)).toContain(ghosts[0]);
	});

	it("ignores proposed ids when it resumes a parked message", async () => {
		const id = await chat("p8");
		const elicitationId = crypto.randomUUID();
		await collections.mcpElicitations.insertOne({
			elicitationId,
			conversationId: new ObjectId(id),
			pending: { messageId: A, kind: "question" },
		} as never);
		// U names a message the conversation holds: as a new id it would be a 409.
		await settle(
			await send(id, "p8", {
				resumeElicitationId: elicitationId,
				id: A,
				userMessageId: U,
				assistantMessageId: NA,
			})
		);
		const messages = await stored(id);
		expect(messages.map((message) => message.id)).toEqual([U, A]);
		await collections.mcpElicitations.deleteOne({ elicitationId });
	});
});
