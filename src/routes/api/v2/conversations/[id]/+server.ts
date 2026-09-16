import { error, type RequestHandler } from "@sveltejs/kit";
import { superjsonResponse } from "$lib/server/api/utils/superjsonResponse";
import { requireAuth } from "$lib/server/api/utils/requireAuth";
import { resolveConversation } from "$lib/server/api/utils/resolveConversation";
import { collections } from "$lib/server/database";
import { authCondition } from "$lib/server/auth";
import { ObjectId } from "mongodb";
import { validModelIdSchema } from "$lib/server/models";
import { applyConversationSettings } from "$lib/server/conversationSettings";
import { knowledgeBaseViews, parseAttachedKnowledgeBaseIds } from "$lib/server/projects";
import { setMlBudgetTotal } from "$lib/server/mlBudget/budget";
import { usdToMicroUsd } from "$lib/utils/mlBudget";
import type { TurnStateSnapshot } from "$lib/types/TurnState";
import { deleteConversationDeliverables } from "$lib/server/execution/deliverables";

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

	// Project defaults ride along so a first-opened chat can seed its per-chat
	// state (web search, connector selection) without a second round trip.
	// Names only; every turn re-checks reach and credentials server-side.
	let projectDefaults:
		{ defaultWebSearch?: boolean; defaultMcpConnectorIds?: string[] } | undefined;
	try {
		if (!conversation.shared && "projectId" in conversation && conversation.projectId) {
			const project = await collections.projects.findOne(
				{ _id: new ObjectId(conversation.projectId) },
				{ projection: { defaultWebSearch: 1, defaultMcpConnectorIds: 1 } }
			);
			if (project) {
				projectDefaults = {
					...(typeof project.defaultWebSearch === "boolean"
						? { defaultWebSearch: project.defaultWebSearch }
						: {}),
					...(Array.isArray(project.defaultMcpConnectorIds)
						? { defaultMcpConnectorIds: project.defaultMcpConnectorIds }
						: {}),
				};
			}
		}
	} catch {
		// No defaults is a valid answer; the chat falls back to app defaults.
	}

	return superjsonResponse({
		messages: conversation.messages,
		title: conversation.title,
		model: conversation.model,
		projectDefaults,
		preprompt: conversation.preprompt,
		rootMessageId: conversation.rootMessageId,
		id: conversation._id.toString(),
		updatedAt: conversation.updatedAt,
		modelId: conversation.model,
		shared: conversation.shared,
		// The composer's chips read this back on load. A shared view learns
		// nothing about the owner's bases: its composer is read-only anyway,
		// and base names are the owner's to disclose, not the share's. The
		// `in` check is the sharedConversations branch, which carries no bases.
		knowledgeBases:
			!conversation.shared && "knowledgeBaseIds" in conversation
				? await knowledgeBaseViews(conversation.knowledgeBaseIds)
				: undefined,
		deployedSpaces: "deployedSpaces" in conversation ? conversation.deployedSpaces : undefined,
		webSearch: "webSearch" in conversation ? conversation.webSearch : undefined,
		projectId:
			"projectId" in conversation && conversation.projectId
				? conversation.projectId.toString()
				: undefined,
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
	await deleteConversationDeliverables(new ObjectId(id));

	return superjsonResponse({ success: true });
};

export const PATCH: RequestHandler = async ({ locals, params, request }) => {
	requireAuth(locals);

	const body = await request.json();
	const title = body?.title as string | undefined;
	const model = body?.model as string | undefined;
	const webSearch = body?.webSearch as boolean | undefined;
	const mlBudgetTotalUsd = body?.mlBudgetTotalUsd as number | undefined;

	if (title !== undefined) {
		if (typeof title !== "string" || title.length === 0 || title.length > 100) {
			error(400, "Title must be a string between 1 and 100 characters");
		}
	}

	if (model !== undefined && !validModelIdSchema.safeParse(model).success) {
		error(400, "Invalid model ID");
	}

	if (webSearch !== undefined && typeof webSearch !== "boolean") {
		error(400, "webSearch must be a boolean");
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

	// Validated here rather than trusted from the body: shape, count and —
	// unlike a project create — reach, because this is a live attach from a
	// picker the client has just shown (see parseAttachedKnowledgeBaseIds).
	const knowledgeBaseIds = await parseAttachedKnowledgeBaseIds(body?.knowledgeBaseIds, locals);

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
		if (
			title === undefined &&
			model === undefined &&
			webSearch === undefined &&
			knowledgeBaseIds === undefined
		) {
			return superjsonResponse({ success: true });
		}
	}
	// Shared with the legacy handler: a plain $set here would change the pinned
	// model without recording who produced the existing turns, and the next
	// request would replay one model's reasoning onto another.
	const res = await applyConversationSettings(
		{ _id: new ObjectId(id), ...authCondition(locals) },
		{
			title,
			model,
			...(webSearch !== undefined ? { webSearch } : {}),
			...(knowledgeBaseIds !== undefined ? { knowledgeBaseIds } : {}),
		}
	);

	if (typeof res.matchedCount === "number" ? res.matchedCount === 0 : res.modifiedCount === 0) {
		error(404, "Conversation not found");
	}

	if (model !== undefined) {
		const patch: Record<string, unknown> = { updatedAt: new Date() };
		patch.model = model;
		await collections.conversations.updateOne(
			{ _id: new ObjectId(id), ...authCondition(locals) },
			{ $set: patch }
		);
	}

	return superjsonResponse({ success: true });
};
