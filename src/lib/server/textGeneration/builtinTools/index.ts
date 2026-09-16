import type { Conversation } from "$lib/types/Conversation";
import { isMlAssistantConversation } from "$lib/server/mlAssistant";
import { askUserQuestionBuiltin } from "./askUserQuestion";
import { githubGroundingBuiltins } from "./githubGrounding";
import { createPlanTool } from "./planTool";
import { waitBuiltin } from "./waitTool";
import { createResearchTool } from "./researchTool";
import { createSandboxTool } from "./sandboxTool";
import { createJobCheckTool } from "./jobCheckTool";
import { createTrackioTool } from "./createTrackioTool";
import { createGatewaySearchBuiltins, isDuckDuckGoEnabled } from "./gatewaySearchTool";
import { createWebFetchBuiltin } from "./webFetchTool";
import { createExecuteCodeBuiltin } from "./executeCodeTool";
import type { BuiltinTool } from "./types";

export type { BuiltinTool, BuiltinToolContext, BuiltinToolResult } from "./types";
export { PLAN_TOOL_NAME } from "./planTool";
export { RESEARCH_TOOL_NAME, isResearchTool } from "./researchTool";
export { SANDBOX_TOOL_NAME, isSandboxTool } from "./sandboxTool";
export { JOB_CHECK_TOOL_NAME, isJobCheckTool } from "./jobCheckTool";
export { CREATE_TRACKIO_TOOL_NAME } from "./createTrackioTool";
export { isNestedAgentTool } from "./nestedAgent";

/**
 * Enablement policy lives here, per tool — never in the dispatch or gate
 * plumbing, which treats every builtin the same. All of these are part of the
 * ML Assistant preset: outside a mode conversation (or in a build without the
 * mode) there are no builtin tools at all.
 */
export function getEnabledBuiltinTools(params: {
	conv: Pick<Conversation, "_id" | "plan" | "mlAssistant" | "webSearch">;
	/** Hub namespace to name a Trackio Space in; absent when the run has no user. */
	namespace?: string;
	/** The turn's OIDC token; the gateway search tool meters the search to its owner. */
	token?: string;
	/** Ids of the `kind: "search"` models this caller may use; absent means none. */
	searchModelIds?: string[];
	/** The user's web-search setting; on, the search builtin joins any conversation. */
	webSearchEnabled?: boolean;
	/**
	 * Keyless DuckDuckGo fallback when no search backend is granted. Defaults
	 * to on unless `DDG_SEARCH_DISABLED=true`, so a deployment without a
	 * commercial search key still searches.
	 */
	duckDuckGoEnabled?: boolean;
	/** URLs from user messages; search results join this set during the run. */
	allowedFetchUrls?: Set<string>;
}): BuiltinTool[] {
	const tools: BuiltinTool[] = [];

	if (isMlAssistantConversation(params.conv)) {
		// The GitHub tools carry a second condition of their own — they withhold
		// themselves without a GITHUB_TOKEN — which is still policy, so it lives
		// with them rather than leaking a config read into this list. The
		// research tool's definition is static too, but its nested loop needs
		// the turn's request plumbing, which runMcpFlow binds onto it once that
		// exists.
		tools.push(
			askUserQuestionBuiltin,
			createPlanTool(params.conv),
			waitBuiltin,
			...githubGroundingBuiltins(),
			createResearchTool(),
			createSandboxTool(),
			createJobCheckTool(),
			createTrackioTool(() => params.namespace)
		);
	}

	// Gated on the deployment-level flag alone: absent flag = fences only,
	// exactly today's behavior. The tool withholds itself when the flag is off.
	tools.push(...createExecuteCodeBuiltin());

	// The gateway's own search backends, metered to this caller. Two switches,
	// both meaningful: the per-chat state says they consent to web search in
	// this conversation (inheriting project then app defaults at creation and
	// at turn resolution — settings hold *defaults*, a chat holds *per-chat
	// state*), the ML Assistant preset includes it by nature, and the
	// console's search tier says the deployment permits it. The tool
	// withholds itself when either is missing — like the GitHub tools do
	// without a token.
	//
	// `conv.webSearch` wins over the passed default when set: an explicit
	// per-chat `false` must override an app default of `true`, and vice
	// versa. The caller (runMcpFlow) already folds the project layer into
	// `webSearchEnabled`, so here the chain is per-chat > caller default.
	const effectiveWebSearch = params.conv.webSearch ?? params.webSearchEnabled ?? false;
	const webAccessEnabled = effectiveWebSearch || isMlAssistantConversation(params.conv);
	// A granted backend or the keyless fallback: the tool withholds itself
	// when neither exists — like the GitHub tools do without a token.
	const duckDuckGoEnabled = isDuckDuckGoEnabled(params.duckDuckGoEnabled);
	const hasSearch = (params.searchModelIds?.length ?? 0) > 0 || duckDuckGoEnabled;
	if (webAccessEnabled && hasSearch) {
		tools.push(
			...createGatewaySearchBuiltins({
				token: params.token,
				searchModelIds: params.searchModelIds ?? [],
				allowedFetchUrls: params.allowedFetchUrls,
				duckDuckGoEnabled,
			})
		);
	}
	// Fetch needs the same consent as search. Offer it with a granted search
	// backend even when the user supplied no URL: search can add safe targets
	// during this run, and the tool list cannot change between model rounds.
	// A direct user URL does not require a granted search backend to be read.
	if (
		webAccessEnabled &&
		params.allowedFetchUrls &&
		(params.allowedFetchUrls.size > 0 || hasSearch)
	) {
		tools.push(createWebFetchBuiltin({ allowedUrls: params.allowedFetchUrls }));
	}

	return tools;
}

/**
 * The MCP flow used to bail whenever no MCP servers were selected, which also
 * withheld every builtin tool. Shared by all early-return sites so the rule
 * can't drift between them.
 */
export function shouldSkipMcpFlow(serverCount: number, builtinToolCount: number): boolean {
	return serverCount === 0 && builtinToolCount === 0;
}
