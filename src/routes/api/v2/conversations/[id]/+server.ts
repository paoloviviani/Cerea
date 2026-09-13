import { error, type RequestHandler } from "@sveltejs/kit";
import { superjsonResponse } from "$lib/server/api/utils/superjsonResponse";
import { requireAuth } from "$lib/server/api/utils/requireAuth";
import { resolveConversation } from "$lib/server/api/utils/resolveConversation";
import { collections } from "$lib/server/database";
import { authCondition } from "$lib/server/auth";
import { ObjectId } from "mongodb";
import { validModelIdSchema } from "$lib/server/models";
import { resolveForConversation } from "$lib/server/agents";
import { applyConversationSettings } from "$lib/server/conversationSettings";
import { setMlBudgetTotal } from "$lib/server/mlBudget/budget";
import { usdToMicroUsd } from "$lib/utils/mlBudget";
import type { TurnStateSnapshot } from "$lib/types/TurnState";

export const GET: RequestHandler = async ({ locals, params, url }) => {
	requireAuth(locals);

	const conversation = await resolveConversation(
		params.id ?? "",
		locals,
		url.searchParams.get("fromShare")
	);

	// The last assistant message's authoritative liveness, alongside the
	// snapshot it describes. `serverNow` lets the client correct clock skew so
	// a waiting turn's countdown renders true remaining time on load.
	const lastAssistant = [...conversation.messages]
		.reverse()
		.find((message) => message.from === "assistant");
	// Share views resolve with a string id; ObjectId accepts both forms.
	const turnStateDoc = lastAssistant
		? await collections.turnStates
				.findOne({ conversationId: new ObjectId(conversation._id), messageId: lastAssistant.id })
				.catch(() => null)
		: null;
	const turnState: TurnStateSnapshot | undefined = turnStateDoc
		? {
				messageId: turnStateDoc.messageId,
				status: turnStateDoc.status,
				serverNow: Date.now(),
				...(turnStateDoc.waitUntil ? { until: turnStateDoc.waitUntil.getTime() } : {}),
				...(turnStateDoc.waitReason ? { reason: turnStateDoc.waitReason } : {}),
				...(turnStateDoc.error ? { error: turnStateDoc.error } : {}),
			}
		: undefined;

	return superjsonResponse({
		messages: conversation.messages,
		title: conversation.title,
		model: conversation.model,
		preprompt: conversation.preprompt,
		rootMessageId: conversation.rootMessageId,
		id: conversation._id.toString(),
		updatedAt: conversation.updatedAt,
		modelId: conversation.model,
		shared: conversation.shared,
		deployedSpaces: "deployedSpaces" in conversation ? conversation.deployedSpaces : undefined,
		mlAssistant: "mlAssistant" in conversation ? conversation.mlAssistant : undefined,
		mlBudget: "mlBudget" in conversation ? conversation.mlBudget : undefined,
		plan: "plan" in conversation ? conversation.plan : undefined,
		turnState,
	});
};

export const DELETE: RequestHandler = async ({ locals, params }) => {
	requireAuth(locals);

	const id = params.id ?? "";
	if (!ObjectId.isValid(id)) {
		error(400, "Invalid conversation ID");
	}
	const res = await collections.conversations.deleteOne({
		_id: new ObjectId(id),
		...authCondition(locals),
	});

	if (res.deletedCount === 0) {
		error(404, "Conversation not found");
	}

	return superjsonResponse({ success: true });
};

export const PATCH: RequestHandler = async ({ locals, params, request }) => {
	requireAuth(locals);

	const body = await request.json();
	const title = body?.title as string | undefined;
	const model = body?.model as string | undefined;
	const agentIdInput = body?.agentId as string | undefined;
	const mlBudgetTotalUsd = body?.mlBudgetTotalUsd as number | undefined;

	if (title !== undefined) {
		if (typeof title !== "string" || title.length === 0 || title.length > 100) {
			error(400, "Title must be a string between 1 and 100 characters");
		}
	}

	if (model !== undefined && !validModelIdSchema.safeParse(model).success) {
		error(400, "Invalid model ID");
	}

	// The wrapper arrives by id and must belong to the caller. The
	// conversation keeps a plain model — the agent's underlying one — and
	// holds the wrapper by id; a plain model choice clears it. The agent's
	// prompt is snapshotted into the conversation at the same moment, so the
	// conversation reads as a plain one from here on.
	let nextAgentId: ObjectId | undefined;
	let wrappedModel: string | undefined;
	let wrappedPrompt: string | undefined;
	if (agentIdInput !== undefined) {
		const user = locals.user;
		if (!user) error(401, "Login required");
		if (!ObjectId.isValid(agentIdInput)) error(400, "No such agent");
		const agent = await resolveForConversation(new ObjectId(agentIdInput), user._id);
		if (!agent) error(400, "No such agent");
		nextAgentId = agent._id;
		wrappedModel = agent.model;
		wrappedPrompt = agent.system_prompt;
	}

	if (mlBudgetTotalUsd !== undefined) {
		if (
			typeof mlBudgetTotalUsd !== "number" ||
			!Number.isFinite(mlBudgetTotalUsd) ||
			mlBudgetTotalUsd < 0 ||
			mlBudgetTotalUsd > 10_000
		) {
			// Zero is allowed: it pauses spend on the conversation while keeping the
			// ledger's spend and open holds intact.
			error(400, "Budget must be a number of dollars between 0 and 10000");
		}
	}

	const id = params.id ?? "";
	if (!ObjectId.isValid(id)) {
		error(400, "Invalid conversation ID");
	}

	if (mlBudgetTotalUsd !== undefined) {
		// Guarded on mlAssistant so a budget cannot be conjured onto an ordinary
		// conversation; spend and open holds survive the change untouched.
		const matched = await setMlBudgetTotal({
			conversationId: new ObjectId(id),
			totalMicroUsd: usdToMicroUsd(mlBudgetTotalUsd),
			extraFilter: { ...authCondition(locals), mlAssistant: true },
		});
		if (!matched) {
			error(404, "Conversation not found");
		}
		if (title === undefined && model === undefined) {
			return superjsonResponse({ success: true });
		}
	}
	// Shared with the legacy handler: a plain $set here would change the pinned
	// model without recording who produced the existing turns, and the next
	// request would replay one model's reasoning onto another.
	const res = await applyConversationSettings(
		{ _id: new ObjectId(id), ...authCondition(locals) },
		{ title, model }
	);

	if (typeof res.matchedCount === "number" ? res.matchedCount === 0 : res.modifiedCount === 0) {
		error(404, "Conversation not found");
	}

	if (nextAgentId !== undefined || model !== undefined) {
		const patch: Record<string, unknown> = { updatedAt: new Date() };
		if (nextAgentId !== undefined) {
			// The wrapper: the conversation keeps a plain model — the agent's
			// underlying one — and the agent's prompt becomes its preprompt,
			// so it reads as a plain conversation from here on.
			patch.agentId = nextAgentId;
			patch.model = wrappedModel;
			patch.preprompt = wrappedPrompt;
		} else if (model !== undefined) {
			// A plain model choice clears the wrapper.
			patch.agentId = null;
			patch.model = model;
		}
		await collections.conversations.updateOne(
			{ _id: new ObjectId(id), ...authCondition(locals) },
			{ $set: patch }
		);
	}

	return superjsonResponse({ success: true });
};
