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
import { createGatewaySearchBuiltins } from "./gatewaySearchTool";
import { createWebFetchBuiltin } from "./webFetchTool";
import { createExecuteCodeBuiltin } from "./executeCodeTool";
import { createWebFetchStructuredBuiltin } from "./webFetchStructuredTool";
import { createMemoryBuiltins } from "./memoryTool";
import { configuredBackend } from "$lib/server/fetching";
import type { BuiltinTool } from "./types";

export type { BuiltinTool, BuiltinToolContext, BuiltinToolResult } from "./types";
export { PLAN_TOOL_NAME } from "./planTool";
export { RESEARCH_TOOL_NAME, isResearchTool } from "./researchTool";
export { SANDBOX_TOOL_NAME, isSandboxTool } from "./sandboxTool";
export { JOB_CHECK_TOOL_NAME, isJobCheckTool } from "./jobCheckTool";
export { CREATE_TRACKIO_TOOL_NAME } from "./createTrackioTool";
export { REMEMBER_TOOL_NAME, FORGET_TOOL_NAME } from "./memoryTool";
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
	/** URLs from user messages; search results join this set during the run. */
	allowedFetchUrls?: Set<string>;
	/** The global tool-approval policy (ADR 0075). Absent means `manual`. */
	toolApprovalPolicy?: "always-allow" | "manual";
	/** Tools this conversation has already approved (server-qualified names for MCP). */
	approvedTools?: Set<string>;
	/**
	 * Whether this turn may read and write the person's standing facts: the
	 * deployment flag (`CHAT_MEMORY_ENABLED`) and their own opt-in, resolved
	 * together by the caller. Two reads — a config key and a settings
	 * document — so it arrives here already decided, like `searchModelIds`.
	 * Absent or `false` withholds `remember` and `forget` entirely, which is
	 * also what an anonymous session gets: memory belongs to a user, and
	 * there is nowhere durable to put a fact without one.
	 */
	memoryEnabled?: boolean;
	/**
	 * Whether `ask_user_question` joins this conversation even outside the ML
	 * Assistant preset (which always has it): the deployment switch
	 * `CHAT_ASK_USER_QUESTION_ENABLED`, resolved by the caller like memory's.
	 */
	askUserQuestionEnabled?: boolean;
	/**
	 * Whether a recent liveness probe of the configured Playwright renderer
	 * succeeded (`probePlaywrightHealth` in `$lib/server/fetching/playwright`,
	 * cached ~30s). The caller resolves this — an async network probe has no
	 * business inside this otherwise-synchronous decision function, the same
	 * reason `searchModelIds` is resolved by the caller rather than fetched
	 * here. Absent or `false` withholds `web_fetch_structured` exactly as an
	 * unreachable renderer would; see that tool's own condition below for why
	 * this is strict where the admin panel (a different consumer of the same
	 * probe) is deliberately not.
	 */
	playwrightReachable?: boolean;
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

	// Every conversation can put a decision to the person as options they
	// click; the ML Assistant preset already carries the tool above.
	if (params.askUserQuestionEnabled && !isMlAssistantConversation(params.conv)) {
		tools.push(askUserQuestionBuiltin);
	}

	// Gated on the deployment-level flag alone: absent flag = fences only,
	// exactly today's behavior. The tool withholds itself when the flag is off.
	tools.push(...createExecuteCodeBuiltin());

	// Memory joins every conversation, not just the ML Assistant preset: a
	// standing fact about somebody is as relevant to an ordinary chat as to a
	// mode one, and the whole point is that it survives across them. Both
	// switches are already folded into the one flag by the caller.
	tools.push(...createMemoryBuiltins({ enabled: params.memoryEnabled === true }));

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
	if (webAccessEnabled && (params.searchModelIds?.length ?? 0) > 0) {
		tools.push(
			...createGatewaySearchBuiltins({
				token: params.token,
				searchModelIds: params.searchModelIds ?? [],
				allowedFetchUrls: params.allowedFetchUrls,
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
		(params.allowedFetchUrls.size > 0 || (params.searchModelIds?.length ?? 0) > 0)
	) {
		tools.push(
			createWebFetchBuiltin({
				allowedUrls: params.allowedFetchUrls,
				toolApprovalPolicy: params.toolApprovalPolicy,
				approvedTools: params.approvedTools,
			})
		);
	}

	// `web_fetch_structured` needs a real, answering browser (it returns
	// `page.ariaSnapshot()`, which only exists because a page was actually
	// rendered) — two separate conditions, both required:
	//
	// 1. The configured fetch backend is specifically `playwright`. `direct`
	//    has no browser at all, and `pystino` is a deliberate stub that
	//    refuses with a message rather than working. `web_fetch` itself needs
	//    no such check: `direct` is a perfectly good way to read a static
	//    page, so it stays offered on every backend (the condition just above
	//    this one). Read fresh on every call rather than cached: `FETCH_BACKEND`
	//    is the one config key the admin panel writes at runtime
	//    (Administration → Fetching), and the tool list is rebuilt once per
	//    turn, so a live switch to `direct` must stop advertising a tool that
	//    would immediately fail — not leave it offered until a restart.
	// 2. `playwrightReachable`, the caller's recent liveness probe. Selecting
	//    `playwright` is a configuration a deployment can hold before the
	//    overlay is even deployed — a legitimate order of operations, and one
	//    the admin panel deliberately still allows (see its own route) — so
	//    the backend being *configured* is not evidence it currently *works*.
	//    Advertising the tool anyway costs the model a wasted round on a call
	//    that cannot succeed; `renderWithPlaywright`'s own "may not be
	//    deployed" error is the backstop for a renderer that dies between
	//    this check and the call, not a substitute for making the check.
	if (
		webAccessEnabled &&
		configuredBackend() === "playwright" &&
		params.playwrightReachable &&
		params.allowedFetchUrls &&
		(params.allowedFetchUrls.size > 0 || (params.searchModelIds?.length ?? 0) > 0)
	) {
		tools.push(
			createWebFetchStructuredBuiltin({
				toolApprovalPolicy: params.toolApprovalPolicy,
				approvedTools: params.approvedTools,
			})
		);
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
