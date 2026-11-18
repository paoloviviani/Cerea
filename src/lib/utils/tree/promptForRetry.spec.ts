import { describe, expect, it } from "vitest";
import type { OpenAI } from "openai";
import { addChildren } from "./addChildren";
import { addSibling } from "./addSibling";
import { buildSubtree } from "./buildSubtree";
import { promptForRetry } from "./promptForRetry";
import { prepareMessagesWithFiles } from "$lib/server/textGeneration/utils/prepareFiles";
import { endOnUserTurn, CONTINUE_PROMPT } from "$lib/server/textGeneration/utils/endOnUserTurn";
import type { EndpointMessage } from "$lib/server/endpoints/endpoints";
import type { makeImageProcessor } from "$lib/server/endpoints/images";
import {
	MessageToolUpdateType,
	MessageUpdateStatus,
	MessageUpdateType,
	type MessageUpdate,
} from "$lib/types/MessageUpdate";
import type { Tree } from "./tree";

type Node = EndpointMessage & { id: string; ancestors?: string[]; children?: string[] };
const imageProcessor = (() => {
	throw new Error("unused");
}) as unknown as ReturnType<typeof makeImageProcessor>;

const PARTIAL = "partial-alpha-text";
const failedUpdates: MessageUpdate[] = [
	{
		type: MessageUpdateType.Tool,
		subtype: MessageToolUpdateType.Call,
		uuid: "u1",
		call: { name: "execute_code", parameters: { code: "print('ran-before-failure')" } },
	},
	{ type: MessageUpdateType.Status, status: MessageUpdateStatus.Error, message: "quota exceeded" },
];

/** A system root, the user's question, and an assistant turn that failed with partial output. */
function failedConversation() {
	const conv = {
		messages: [] as Node[],
		rootMessageId: undefined as string | undefined,
	} as Tree<Node>;
	const root = addChildren(conv, { from: "system", content: "" } as Node, undefined);
	conv.rootMessageId = root;
	const user = addChildren(conv, { from: "user", content: "question one" } as Node, root);
	const failed = addChildren(
		conv,
		{ from: "assistant", content: PARTIAL, updates: failedUpdates } as Node,
		user
	);
	return { conv, user, failed };
}

const send = (messages: unknown[]) =>
	prepareMessagesWithFiles(messages as EndpointMessage[], imageProcessor, false, {
		replayToolHistory: true,
	});

describe("a failed turn, then Retry", () => {
	it("is answered from the branch without the failed attempt, and ends on the user turn", async () => {
		const { conv, failed } = failedConversation();
		const sibling = addSibling(conv, { from: "assistant", content: "" } as Node, failed);
		const prompt = promptForRetry(conv, failed);
		const out = endOnUserTurn(await send(prompt));
		const text = JSON.stringify(out);
		expect(text).not.toContain(PARTIAL);
		expect(text).not.toContain("ran-before-failure");
		expect(out.at(-1)).toMatchObject({ role: "user", content: "question one" });
		// The new answer is a sibling, on the same branch point.
		expect(conv.messages.find((m) => m.id === sibling)?.ancestors).toEqual(
			conv.messages.find((m) => m.id === failed)?.ancestors
		);
	});
});

describe("a failed turn, then Continue", () => {
	it("keeps the partial output and ends on a user continue turn", async () => {
		const { conv, failed } = failedConversation();
		const cont = addChildren(conv, { from: "user", content: CONTINUE_PROMPT } as Node, failed);
		const out = endOnUserTurn(await send(buildSubtree(conv, cont)));
		const text = JSON.stringify(out);
		expect(text).toContain(PARTIAL);
		expect(text).toContain("ran-before-failure");
		const last = out.at(-1) as OpenAI.Chat.Completions.ChatCompletionMessageParam;
		expect(last).toMatchObject({ role: "user", content: CONTINUE_PROMPT });
		expect(out.at(-2)?.role).not.toBe("user");
	});

	it("with a text-only partial, the assistant message directly precedes the continue turn", async () => {
		const conv = {
			messages: [] as Node[],
			rootMessageId: undefined as string | undefined,
		} as Tree<Node>;
		conv.rootMessageId = addChildren(conv, { from: "system", content: "" } as Node, undefined);
		const user = addChildren(conv, { from: "user", content: "q" } as Node, conv.rootMessageId);
		const failed = addChildren(
			conv,
			{ from: "assistant", content: "only text", updates: [] } as unknown as Node,
			user
		);
		const cont = addChildren(conv, { from: "user", content: CONTINUE_PROMPT } as Node, failed);
		const out = await send(buildSubtree(conv, cont));
		expect(out.slice(-2).map((m) => m.role)).toEqual(["assistant", "user"]);
		expect(out.at(-2)?.content).toBe("only text");
	});
});
