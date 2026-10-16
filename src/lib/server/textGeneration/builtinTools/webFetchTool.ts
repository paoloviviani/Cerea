import { fetchPage } from "$lib/server/fetching";
import { extractDocument } from "$lib/server/files/extractDocument";
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
	// Prefer the article when the page marks one: the navigation, sidebars and
	// footers around it would otherwise eat the read budget. Otherwise drop the
	// chrome elements that are never the content.
	const main = /<(article|main)\b[^>]*>([\s\S]*)<\/\1>/i.exec(html);
	const body = main
		? main[2]
		: html.replace(/<(nav|footer|aside|svg|form)\b[^>]*>[\s\S]*?<\/\1>/gi, " ");
	return body
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

/** A page's readable text, kept for the turn so reading on does not fetch (or extract) again. */
export interface ReadablePage {
	title: string | null;
	finalUrl: string;
	text: string;
}

export interface PerformFetchOptions {
	/** Character position to start from. Default 0. */
	offset?: number;
	/** The turn's user token: a document is extracted (and metered) as this user. */
	token?: string;
	/**
	 * Readable text by requested URL. Supplied by the tool for the turn; a hit
	 * skips the network and the extractor, which may bill per page.
	 */
	cache?: Map<string, ReadablePage>;
}

/** The offset a model asked for, or an error sentence. Absent means the start. */
export function parseOffset(value: unknown): number | { error: string } {
	if (value === undefined || value === null || value === "") return 0;
	const n = typeof value === "string" ? Number(value) : value;
	if (typeof n !== "number" || !Number.isInteger(n) || n < 0) {
		return { error: "offset must be a non-negative integer (a character position)." };
	}
	return n;
}

/** One chunk of the text, with a footer saying how to read on when more remains. */
export function chunkOf(page: ReadablePage, offset: number): FetchOutcome {
	const total = page.text.length;
	if (offset >= total && offset > 0) {
		return { error: `offset ${offset} is past the end of the content (${total} characters).` };
	}
	const end = Math.min(offset + MAX_FETCH_RESULT_CHARS, total);
	const footer =
		end < total
			? `\n\n[Showing characters ${offset}\u2013${end} of ${total}. ` +
				`Call ${WEB_FETCH_TOOL_NAME} again with the same url and offset=${end} to read on.]`
			: "";
	return {
		resultText:
			`Title: ${page.title ?? "Untitled"}\nURL: ${page.finalUrl}\n\n` +
			page.text.slice(offset, end) +
			footer,
	};
}

/**
 * Fetches and renders one page. Shared by the ordinary tool call and by the
 * tool-approval resume path (`resumeElicitation.ts`), which re-issues this
 * same fetch once the user approves it — so the two must format results,
 * chunk, and report errors identically.
 *
 * A document (PDF, Word, ...) goes through `extractDocument`, the reader an
 * attached file uses, never through the HTML text path.
 */
export async function performFetch(
	url: string,
	options: PerformFetchOptions = {}
): Promise<FetchedPage> {
	const offset = parseOffset(options.offset);
	if (typeof offset !== "number") return { result: offset };
	try {
		let page = options.cache?.get(url);
		if (!page) {
			const fetched = await fetchPage(url);
			const finalUrl = canonicalUrl(fetched.url) ?? url;
			let text: string;
			let title = fetched.title;
			if (fetched.document) {
				if (!options.token) {
					return {
						result: {
							error:
								"This document could not be read: it needs the reader of the person asking, and none is available here. Approve it again from the conversation.",
						},
					};
				}
				const extraction = await extractDocument({
					bytes: fetched.document.bytes,
					mime: fetched.document.mime,
					filename: fetched.document.filename,
					token: options.token,
				});
				if (!extraction.ok) {
					const label = fetched.document.mime === "application/pdf" ? "PDF" : "document";
					return { result: { error: `This ${label} could not be read: ${extraction.reason}` } };
				}
				text = extraction.text.trim();
				title = title ?? fetched.document.filename;
			} else {
				text = readablePageText(fetched.content);
			}
			if (!text) return { result: { error: "That page had no readable text." } };
			page = { title, finalUrl, text };
			options.cache?.set(url, page);
		}
		return { result: chunkOf(page, offset), finalUrl: page.finalUrl };
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
	/** The turn's user token, for extracting documents as this user. */
	token?: string;
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
	// Per turn (the tool is built per turn): paging through one long page or
	// document costs one fetch and one extraction, not one per chunk.
	const cache = new Map<string, ReadablePage>();
	return {
		name: WEB_FETCH_TOOL_NAME,
		definition: {
			type: "function",
			function: {
				name: WEB_FETCH_TOOL_NAME,
				description:
					"Read a web page or a document (PDF, Word, Excel, PowerPoint, epub). Long content arrives in " +
					"chunks: when the result ends with a note that more remains, call again with the same url and " +
					"the offset it names to continue. The URL must have been provided by the user or returned by web_search.",
				parameters: {
					type: "object",
					properties: {
						url: {
							type: "string",
							description: "An HTTPS URL previously supplied by the user or web_search.",
						},
						offset: {
							type: "integer",
							description:
								"Character position to start from, to read on from a previous chunk. Default 0.",
						},
					},
					required: ["url"],
				},
			},
		},
		preprompt:
			"WEB FETCH: Read one specific page only after the user supplied its URL or web_search returned it. " +
			"Use web_search first to discover pages. PDFs and other documents can be read too. Long content arrives in chunks: " +
			"read on by calling again with the same url and the offset the result names. Cite the URL you read.",
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

			const offset = parseOffset(args.offset);
			if (typeof offset !== "number") return offset;

			// Reading on from a page already fetched this turn is not a new fetch.
			if (!cache.has(requested) && uses >= MAX_FETCHES_PER_TURN) {
				return { error: `This turn may read at most ${MAX_FETCHES_PER_TURN} web pages.` };
			}
			// Increment before I/O so parallel calls cannot race past the cap.
			if (!cache.has(requested)) uses += 1;

			const { result, finalUrl } = await performFetch(requested, {
				offset,
				token: params.token,
				cache,
			});
			if ("resultText" in result) {
				params.allowedUrls.add(finalUrl ?? requested);
			}
			return result;
		},
	};
}
