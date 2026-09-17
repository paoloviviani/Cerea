import { fetchPage } from "$lib/server/fetching";
import { canonicalUrl, WEB_FETCH_TOOL_NAME } from "./fetchUrlUtils";
import type { BuiltinTool } from "./types";

// A page is useful only after its markup, navigation, and boilerplate have
// gone. This keeps one fetch from crowding out the actual conversation.
export const MAX_FETCH_RESULT_CHARS = 24_000;
export const MAX_FETCHES_PER_TURN = 20;

export { canonicalUrl, WEB_FETCH_TOOL_NAME };

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
 * tool-approval resume path (`resumeElicitation.ts`), which re-issues this
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

export interface WebFetchApprovalParams {
	/** The global tool-approval policy (ADR 0075). Absent means `manual`. */
	toolApprovalPolicy?: "always-allow" | "manual";
	/** Tools this conversation has already approved (server-qualified names for MCP). */
	approvedTools?: Set<string>;
}

/**
 * Whether a URL needs the tool-approval gate before `web_fetch` may read it:
 * only user-authored or search-surfaced URLs start trusted (`allowedUrls`),
 * closing the gap is what the global policy is for. The dispatch loop
 * (`toolInvocation.ts`) calls this ahead of `execute` to decide, across the
 * whole round, which gated calls need a prompt this pass — it must match
 * `execute`'s own notion of "trusted" exactly, so both read the same set.
 */
export function webFetchNeedsApproval(
	args: Record<string, unknown>,
	allowedUrls: Set<string>
): boolean {
	const requested = typeof args.url === "string" ? canonicalUrl(args.url.trim()) : null;
	return requested === null || !allowedUrls.has(requested);
}

export function createWebFetchBuiltin(
	params: { allowedUrls: Set<string> } & WebFetchApprovalParams
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
		async execute(args, _ctx) {
			const requested = typeof args.url === "string" ? canonicalUrl(args.url.trim()) : null;
			if (!requested) return { error: "The page URL must be a valid HTTPS URL." };

			if (!params.allowedUrls.has(requested)) {
				// The gate (toolInvocation.ts) only calls execute() for an untrusted
				// URL once it has already cleared the tool-approval checkpoint —
				// always-allow, or a standing "approve for the conversation" grant.
				// Never looser: a call reaching here any other way is refused, not
				// silently allowed through.
				const cleared =
					params.toolApprovalPolicy === "always-allow" ||
					(params.approvedTools?.has(WEB_FETCH_TOOL_NAME) ?? false);
				if (!cleared) {
					return {
						error:
							"That URL was not supplied by the user or returned by web_search, and was not approved.",
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
