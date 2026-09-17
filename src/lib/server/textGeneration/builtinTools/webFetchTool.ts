import { fetchPage } from "$lib/server/fetching";
import { turnAwaitingInput } from "$lib/server/generation/turnState";
import { openFetchApprovalPrompt } from "./fetchApproval";
import { verifyUrlBySearch } from "./fetchVerification";
import { canonicalUrl, hostnameOf, WEB_FETCH_TOOL_NAME } from "./fetchUrlUtils";
import type { BuiltinTool } from "./types";

// A page is useful only after its markup, navigation, and boilerplate have
// gone. This keeps one fetch from crowding out the actual conversation.
export const MAX_FETCH_RESULT_CHARS = 24_000;
export const MAX_FETCHES_PER_TURN = 20;

export { canonicalUrl, hostnameOf, WEB_FETCH_TOOL_NAME };

/** URLs a person supplied, before the model has had an opportunity to invent one. */
export function urlsInUserText(text: string): string[] {
	return [...text.matchAll(/https:\/\/[^\s<>"')\]]+/g)]
		.map(([value]) => canonicalUrl(value))
		.filter((value): value is string => value !== null);
}

/**
 * Rendered pages arrive as HTML from the Playwright backend. The model needs
 * readable text, not scripts, styles, or a second HTML parser in its prompt.
 */
export function readablePageText(html: string): string {
	return html
		.replace(/<(script|style|noscript|template)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
		.replace(/<[^>]+>/g, " ")
		.replace(/&nbsp;/gi, " ")
		.replace(/&amp;/gi, "&")
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">")
		.replace(/&quot;/gi, '"')
		.replace(/&#39;|&apos;/gi, "'")
		.replace(/\s+/g, " ")
		.trim();
}

/** Never `{awaitingInput}`: a real fetch always either succeeds or fails outright. */
export type FetchOutcome = { resultText: string } | { error: string };

export interface FetchedPage {
	result: FetchOutcome;
	/** Absent on failure. The page's own final URL after redirects, canonicalized. */
	finalUrl?: string;
}

/**
 * Fetches and renders one page. Shared by the ordinary tool call and by the
 * "ask per domain" resume path (`resumeElicitation.ts`), which re-issues this
 * same fetch once the user approves it — so the two must format results,
 * truncate, and report errors identically.
 */
export async function performFetch(url: string): Promise<FetchedPage> {
	try {
		const page = await fetchPage(url);
		const finalUrl = canonicalUrl(page.url) ?? url;
		const text = readablePageText(page.content);
		if (!text) return { result: { error: "That page had no readable text." } };
		const truncated = text.length > MAX_FETCH_RESULT_CHARS;
		return {
			result: {
				resultText:
					`Title: ${page.title ?? "Untitled"}\nURL: ${finalUrl}\n\n` +
					text.slice(0, MAX_FETCH_RESULT_CHARS) +
					(truncated ? "\n\n[Content truncated.]" : ""),
			},
			finalUrl,
		};
	} catch (error) {
		return {
			result: {
				error: `Could not fetch that page: ${error instanceof Error ? error.message : "unknown error"}`,
			},
		};
	}
}

export interface WebFetchPolicyParams {
	/**
	 * How to close the gap for a URL neither the user nor `web_search`
	 * supplied. Absent keeps today's behavior: such a URL is refused outright.
	 */
	policy?: "ask-domain" | "auto-verified";
	/** Domains approved for the rest of this conversation under `"ask-domain"`. */
	approvedDomains?: Set<string>;
	/** Search credential for `"auto-verified"`'s silent unlock search. Absent disables it. */
	verificationToken?: string;
}

export function createWebFetchBuiltin(
	params: { allowedUrls: Set<string> } & WebFetchPolicyParams
): BuiltinTool {
	let uses = 0;
	return {
		name: WEB_FETCH_TOOL_NAME,
		definition: {
			type: "function",
			function: {
				name: WEB_FETCH_TOOL_NAME,
				description:
					"Read a web page in full. The URL must have been provided by the user or returned by web_search.",
				parameters: {
					type: "object",
					properties: {
						url: {
							type: "string",
							description: "An HTTPS URL previously supplied by the user or web_search.",
						},
					},
					required: ["url"],
				},
			},
		},
		preprompt:
			"WEB FETCH: Read one specific page only after the user supplied its URL or web_search returned it. " +
			"Use web_search first to discover pages. Cite the URL you read.",
		// Only ever exercised under the "ask-domain" policy — see below.
		mayPark: true,
		parkRefusalMessage:
			"Only one web_fetch call waiting on a domain approval can run per turn. Ask about one URL at a time.",
		async execute(args, ctx) {
			const requested = typeof args.url === "string" ? canonicalUrl(args.url.trim()) : null;
			if (!requested) return { error: "The page URL must be a valid HTTPS URL." };

			if (!params.allowedUrls.has(requested)) {
				const hostname = hostnameOf(requested);
				const domainApproved =
					hostname !== null && (params.approvedDomains?.has(hostname) ?? false);

				if (domainApproved) {
					// Already approved for this conversation: fall through to the ordinary fetch below.
				} else if (params.policy === "ask-domain") {
					if (!ctx.elicitationSink || !ctx.conversationId || !ctx.messageId) {
						return {
							error:
								"That URL was not supplied by the user or returned by web_search, and there is no chat to ask for approval.",
						};
					}
					const opened = await openFetchApprovalPrompt({
						sink: ctx.elicitationSink,
						toolUuid: ctx.uuid,
						toolCallId: ctx.toolCallId,
						messageId: ctx.messageId,
						url: requested,
					});
					if (!opened.opened) {
						return { error: `The domain approval prompt could not be shown (${opened.reason}).` };
					}
					const stateUpdate = await turnAwaitingInput({
						conversationId: ctx.conversationId,
						messageId: ctx.messageId,
						producerId: ctx.generationId ?? "",
						...(ctx.userId ? { userId: ctx.userId } : {}),
						...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
					});
					ctx.elicitationSink.emit(stateUpdate);
					return { awaitingInput: true };
				} else if (params.policy === "auto-verified") {
					if (!params.verificationToken) {
						return {
							error:
								"That URL was not supplied by the user or returned by web_search, and there is no search credential to verify it against.",
						};
					}
					const verified = await verifyUrlBySearch({
						url: requested,
						token: params.verificationToken,
					});
					if (!verified.matched) {
						return {
							error: `That URL was not supplied by the user or returned by web_search, and a verification search found no match.\n\n${verified.evidence}`,
						};
					}
					// Verified against genuine, fresh search results: trust it for the rest of this turn.
					params.allowedUrls.add(requested);
				} else {
					return {
						error:
							"That URL was not supplied by the user or returned by web_search. Search for it first, or ask the user for the link.",
					};
				}
			}

			if (uses >= MAX_FETCHES_PER_TURN) {
				return { error: `This turn may read at most ${MAX_FETCHES_PER_TURN} web pages.` };
			}
			// Increment before I/O so parallel calls cannot race past the cap.
			uses += 1;

			const { result, finalUrl } = await performFetch(requested);
			if ("resultText" in result) {
				params.allowedUrls.add(finalUrl ?? requested);
			}
			return result;
		},
	};
}
