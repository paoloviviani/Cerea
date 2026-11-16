import { collections } from "$lib/server/database";
import { resolveWebSearchFor } from "$lib/server/webSearch/config";
import { resolveWebSearchEnabled } from "$lib/server/webSearchDefaults";
import type { Conversation } from "$lib/types/Conversation";
import type { TextGenerationContext } from "./types";

/** Web search is on for the chat and a backend is granted, but the model cannot call tools. */
export const WEB_SEARCH_NEEDS_TOOLS_LINE =
	"Web search is on, but this model cannot use tools, so it cannot search. Pick a model that supports tools.";

/** A backend is granted, the chat has search off, and the model could use it if the user switched it on. */
export const WEB_SEARCH_OFF_LINE =
	"Web search is off for this chat. There is a web search switch in the composer; if the user needs current information from the web, tell them to turn it on instead of saying you have no web access.";

/**
 * The one line that explains web search to the model when it would otherwise be
 * confused about it. Pure: the caller resolves the three facts.
 */
export function webSearchNoticeLine(input: {
	/** Whether search is on for this chat (per-chat, project, then app default). */
	enabled: boolean;
	/** Whether the caller has at least one search backend granted. */
	granted: boolean;
	/** Whether the model calls tools this turn. */
	toolsEnabled: boolean;
}): string | undefined {
	if (!input.granted) return undefined;
	if (input.enabled && !input.toolsEnabled) return WEB_SEARCH_NEEDS_TOOLS_LINE;
	if (!input.enabled && input.toolsEnabled) return WEB_SEARCH_OFF_LINE;
	return undefined;
}

/**
 * Resolves the facts for a turn and returns the line, or undefined. Never
 * throws: a failed read is a turn without the hint, not a failed turn.
 */
export async function webSearchNoticeFor(
	ctx: Pick<TextGenerationContext, "model" | "forceTools" | "locals">,
	conv: Pick<Conversation, "webSearch" | "projectId">
): Promise<string | undefined> {
	try {
		if (ctx.locals?.scheduledRun) return undefined;
		const toolsEnabled = Boolean(ctx.forceTools ?? ctx.model.supportsTools);
		const { granted } = await resolveWebSearchFor(ctx.locals?.token);
		if (granted.length === 0) return undefined;
		const user = ctx.locals?.user;
		const sessionId = ctx.locals?.sessionId;
		const settings = user
			? await collections.settings.findOne({ userId: user._id })
			: sessionId
				? await collections.settings.findOne({ sessionId })
				: null;
		const project = conv.projectId
			? await collections.projects.findOne({ _id: conv.projectId })
			: null;
		const enabled = resolveWebSearchEnabled({
			conversationWebSearch: conv.webSearch,
			projectDefault:
				typeof project?.defaultWebSearch === "boolean" ? project.defaultWebSearch : undefined,
			settingsEnabled: settings?.webSearchEnabled,
		});
		return webSearchNoticeLine({ enabled, granted: true, toolsEnabled });
	} catch {
		return undefined;
	}
}
