import type { RequestHandler } from "./$types";
import { collections } from "$lib/server/database";
import { ObjectId } from "mongodb";
import { error, redirect } from "@sveltejs/kit";
import { base } from "$app/paths";
import { z } from "zod";
import type { Message } from "$lib/types/Message";
import { models, validateModel } from "$lib/server/models";
import {
	conversationOwnerFilter,
	isSelectableModel,
	resolveConversationModel,
} from "$lib/server/customModels";
import {
	projectAccess,
	viewerPrincipals,
	parseAttachedKnowledgeBaseIds,
	knowledgeBaseViews,
} from "$lib/server/projects";
import { v4 } from "uuid";
import { authCondition } from "$lib/server/auth";
import { usageLimits } from "$lib/server/usageLimits";
import { MetricsServer } from "$lib/server/metrics";
import superjson from "superjson";
import { ML_ASSISTANT_MODE } from "$lib/utils/mlAssistantFlag";
import { resolveMlAssistantModel } from "$lib/server/mlAssistantModels";
import { usdToMicroUsd } from "$lib/utils/mlBudget";

export const POST: RequestHandler = async ({ locals, request }) => {
	const body = await request.text();

	let title = "";

	const parsedBody = z
		.object({
			fromShare: z.string().optional(),
			// A catalogue id or one of this person's own custom models; checked below.
			model: z.string(),
			// Accepted for old clients and ignored: the per-model prompts that used to
			// travel here are gone, and a stale tab must not smuggle one back in. A
			// conversation's prompt is the model's own, or an imported share's.
			preprompt: z.string().optional(),
			mlAssistant: z.boolean().optional(),
			/** Start this conversation inside a project. */
			projectId: z.string().optional(),
			/**
			 * Knowledge bases to attach to this conversation from its first
			 * turn. Validated for shape and reach below; retrieval still
			 * re-checks the reader every turn.
			 */
			knowledgeBaseIds: z.array(z.unknown()).optional(),
			/**
			 * Per-chat web-search state for the new conversation. When absent
			 * the server inherits: project default, then the app default.
			 */
			webSearch: z.boolean().optional(),
			/**
			 * Chat-local tool-approval override for the new conversation,
			 * decided up front at the composer. Absent means no override:
			 * the chat inherits the setting live, so a later default change
			 * still applies to it.
			 */
			toolApprovalOverride: z.enum(["always-allow", "manual"]).optional(),
			mlBudgetUsd: z.number().finite().min(0).max(10_000).optional(),
		})
		.safeParse(JSON.parse(body));

	if (!parsedBody.success) {
		error(400, "Invalid request");
	}
	const values = parsedBody.data;

	const convCount = await collections.conversations.countDocuments(authCondition(locals));

	if (usageLimits?.conversations && convCount > usageLimits?.conversations) {
		error(429, "You have reached the maximum number of conversations. Delete some to continue.");
	}

	// Only builds that ship ML Assistant mode can start a conversation in it.
	const isMlAssistant = ML_ASSISTANT_MODE && values.mlAssistant === true;

	// A custom model starts the conversation on itself (`conversation.model`
	// keeps the custom id) while the checks below, the preprompt default and the
	// ML Assistant swap look at its base.
	const owner = conversationOwnerFilter({ userId: locals.user?._id, sessionId: locals.sessionId });
	if (
		!(await isSelectableModel(
			values.model,
			owner,
			(id) => validateModel(models).safeParse(id).success
		))
	) {
		error(400, "Invalid request");
	}
	let model = (await resolveConversationModel(values.model, owner))?.model;

	if (!model) {
		error(400, "Invalid model");
	}

	let messages: Message[] = [
		{
			id: v4(),
			from: "system",
			content: "",
			createdAt: new Date(),
			updatedAt: new Date(),
			children: [],
			ancestors: [],
		},
	];

	let rootMessageId: Message["id"] = messages[0].id;
	let fromSharePreprompt: string | undefined;

	if (values.fromShare) {
		const conversation = await collections.sharedConversations.findOne({
			_id: values.fromShare,
		});

		if (!conversation) {
			error(404, "Conversation not found");
		}

		// Strip <think> markers from imported titles
		title = conversation.title.replace(/<\/?think>/gi, "").trim();
		messages = conversation.messages;
		rootMessageId = conversation.rootMessageId ?? rootMessageId;
		values.model = conversation.model;
		fromSharePreprompt = conversation.preprompt;
	}

	// The mode runs on its own fixed set (ML_ASSISTANT_MODELS): whatever was
	// requested — the router alias, or a shared conversation's model — is
	// replaced by the set's default when it isn't listed, so neither a stale
	// client nor an import can route the mode onto an unverified model. After
	// the share import, which is the last thing that can change the model.
	if (isMlAssistant) {
		const resolved = resolveMlAssistantModel(values.model);
		if (!resolved) {
			error(400, "ML Intern has no models configured");
		}
		values.model = resolved;
		model = models.find((m) => (m.id || m.name) === resolved) ?? model;
	}

	if (model?.unlisted) {
		error(400, "Can't start a conversation with an unlisted model");
	}

	// Every mode conversation carries a budget, and it is what the user granted
	// in the composer — nothing more. No grant means $0: the gate refuses every
	// submission until the user sets one, so spend authority is never implicit.
	const mlBudget = isMlAssistant
		? {
				totalMicroUsd: usdToMicroUsd(values.mlBudgetUsd ?? 0),
				spentMicroUsd: 0,
				reservations: [],
			}
		: undefined;

	// The model's own preprompt, unless a share brought one. Never the body's.
	values.preprompt = fromSharePreprompt ?? model?.preprompt ?? "";

	// The ML Assistant preset supplies the whole system prompt at generation time.
	// Storing nothing here keeps any stored prompt out of the conversation
	// entirely — the endpoint appends a stored system message after the
	// preprompt, so leaving one would compose the two.
	if (isMlAssistant) {
		values.preprompt = "";
	}

	if (messages && messages.length > 0 && messages[0].from === "system") {
		messages[0].content = values.preprompt;
	}

	// The project, if one was named and this person may use it. Checked here
	// rather than trusted from the body: the id arrives from the browser, and a
	// conversation stamped with a project somebody cannot see would retrieve
	// from that project's knowledge on every turn.
	//
	// A named project that is not visible is a 403 rather than a silent
	// downgrade to a project-less chat. Losing the standing context without
	// being told is how somebody spends an afternoon wondering why the
	// assistant has forgotten their instructions.
	let projectId: ObjectId | undefined;
	if (values.projectId) {
		if (!locals.user) {
			error(401, "Projects need a signed-in account.");
		}
		const principals = await viewerPrincipals(locals.user, locals.token);
		const access = await projectAccess(values.projectId, locals.user._id, principals);
		if (!access) {
			error(403, "That project is not available to you.");
		}
		projectId = access.project._id;
	}

	// Bases attached from the composer ride in with the conversation's first
	// turn. Shape, count and reach are checked here rather than trusted from
	// the body, and the validation needs the caller — which also settles that
	// attaching requires a signed-in account, like starting in a project does.
	const attachedKnowledgeBaseIds = await parseAttachedKnowledgeBaseIds(
		values.knowledgeBaseIds,
		locals
	);

	// Per-chat web-search state for the new chat. Settings hold *defaults*, a
	// chat holds *per-chat state*: an explicit body value wins, then the
	// project's default (when created under one), then the app default, then
	// off. Stored concretely so a later default change never rewrites an
	// existing chat; legacy chats without the field keep resolving live at
	// turn time.
	const { resolveWebSearchEnabled } = await import("$lib/server/webSearchDefaults");
	let initialWebSearch: boolean | undefined;
	let seedProjectDefaults:
		{ defaultWebSearch?: boolean; defaultMcpConnectorIds?: string[] } | undefined;
	try {
		const settingsDoc = await collections.settings.findOne(authCondition(locals));
		const projectDoc =
			projectId !== undefined
				? await collections.projects.findOne(
						{ _id: projectId },
						{ projection: { defaultWebSearch: 1, defaultMcpConnectorIds: 1 } }
					)
				: null;
		const projectDefault =
			projectDoc && typeof projectDoc.defaultWebSearch === "boolean"
				? projectDoc.defaultWebSearch
				: undefined;
		if (projectDoc) {
			seedProjectDefaults = {
				...(typeof projectDoc.defaultWebSearch === "boolean"
					? { defaultWebSearch: projectDoc.defaultWebSearch }
					: {}),
				...(Array.isArray(projectDoc.defaultMcpConnectorIds)
					? { defaultMcpConnectorIds: projectDoc.defaultMcpConnectorIds }
					: {}),
			};
		}
		const resolved = resolveWebSearchEnabled({
			conversationWebSearch: values.webSearch,
			projectDefault: typeof projectDefault === "boolean" ? projectDefault : undefined,
			settingsEnabled: settingsDoc?.webSearchEnabled,
		});
		// Store only a positive inheritance or an explicit choice: absent means
		// off, and an off-by-default chat needs no field to stay off.
		if (values.webSearch !== undefined || resolved) initialWebSearch = resolved;
	} catch {
		if (values.webSearch !== undefined) initialWebSearch = values.webSearch;
	}

	// Always store sanitized titles
	const storedTitle = (title || "New Chat").replace(/<\/?think>/gi, "").trim();
	const now = new Date();

	const res = await collections.conversations.insertOne({
		_id: new ObjectId(),
		title: storedTitle,
		rootMessageId,
		messages,
		model: values.model,
		preprompt: values.preprompt,
		createdAt: now,
		updatedAt: now,
		userAgent: request.headers.get("User-Agent") ?? undefined,
		...(locals.user ? { userId: locals.user._id } : { sessionId: locals.sessionId }),
		...(values.fromShare ? { meta: { fromShareId: values.fromShare } } : {}),
		...(projectId ? { projectId } : {}),
		...(attachedKnowledgeBaseIds?.length ? { knowledgeBaseIds: attachedKnowledgeBaseIds } : {}),
		...(initialWebSearch !== undefined ? { webSearch: initialWebSearch } : {}),
		// An explicit up-front choice only; absent inherits the setting.
		...(values.toolApprovalOverride !== undefined
			? { toolApprovalOverride: values.toolApprovalOverride }
			: {}),
		// Only builds that ship ML Assistant mode can mark a conversation with it.
		...(isMlAssistant ? { mlAssistant: true } : {}),
		...(isMlAssistant && mlBudget ? { mlBudget } : {}),
	});

	if (MetricsServer.isEnabled()) {
		MetricsServer.getMetrics().model.conversationsTotal.inc({ model: values.model });
	}

	// Alongside the id (the stable public shape of this legacy endpoint), embed
	// the same payload GET /api/v2/conversations/[id] would return, so the
	// client can seed its conversation cache and skip the follow-up GET that
	// otherwise sits between conversation creation and the first generation
	// request. superjson-encoded (as a string field) to preserve Dates exactly
	// like the v2 endpoint does.
	const conversationId = res.insertedId.toString();
	return new Response(
		JSON.stringify({
			conversationId,
			conversation: superjson.stringify({
				messages,
				title: storedTitle,
				model: values.model,
				preprompt: values.preprompt,
				rootMessageId,
				id: conversationId,
				...(initialWebSearch !== undefined ? { webSearch: initialWebSearch } : {}),
				// An explicit up-front choice only; absent inherits the setting.
				...(values.toolApprovalOverride !== undefined
					? { toolApprovalOverride: values.toolApprovalOverride }
					: {}),
				...(projectId ? { projectId: projectId.toString() } : {}),
				...(seedProjectDefaults ? { projectDefaults: seedProjectDefaults } : {}),
				updatedAt: now,
				modelId: values.model,
				// Matches what GET /api/v2/conversations/[id] returns for the normal
				// post-create navigation (no fromShare query param): resolveConversation
				// only reports shared=true when the viewing URL's fromShare matches.
				shared: false,
				deployedSpaces: undefined,
				mlAssistant: isMlAssistant ? true : undefined,
				mlBudget,
				// Resolved to names so the composer's chips render without a second
				// round trip; a base deleted between validate and this read is left
				// out here, exactly as the GET endpoint would show it.
				knowledgeBases: attachedKnowledgeBaseIds?.length
					? await knowledgeBaseViews(attachedKnowledgeBaseIds)
					: undefined,
			}),
		}),
		{ headers: { "Content-Type": "application/json" } }
	);
};

export const GET: RequestHandler = async () => {
	redirect(302, `${base}/`);
};
