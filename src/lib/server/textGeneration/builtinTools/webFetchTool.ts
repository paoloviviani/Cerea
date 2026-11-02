import { fetchPage } from "$lib/server/fetching";
import { readablePageText } from "$lib/server/fetching/readable";
import { detectGate, type GateKind } from "$lib/server/fetching/pageQuality";
import { extractDocument } from "$lib/server/files/extractDocument";
import { logger } from "$lib/server/logger";
import {
	freshWindowMs,
	getCachedFetch,
	putCachedFetch,
	refreshCachedFetch,
	sha256Hex,
	type CacheScope,
} from "$lib/server/webFetchCache";
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

export { readablePageText };

/** The per-turn cache key: a forced render must not be answered from the direct result. */
export function fetchCacheKey(url: string, render: boolean): string {
	return render ? `${url}\u0000render` : url;
}

/**
 * What the model is told when the text is a consent notice or a pay-or-accept
 * wall rather than the page. It must not receive the banner as if it were the
 * article.
 */
export function gateFailureMessage(
	kind: GateKind,
	text: string,
	opts: { canRender: boolean }
): string {
	const what =
		kind === "paywall"
			? "a wall that asks the reader to accept tracking or subscribe"
			: "a cookie-consent notice";
	const options = [
		...(opts.canRender
			? [`call ${WEB_FETCH_TOOL_NAME} again with render: true, to read it in a real browser`]
			: []),
		"search for another source for the same information (web_search)",
		"ask the user to paste the text of the page",
	];
	const snippet = text.trim().slice(0, 500);
	return (
		`The page showed ${what} that could not be passed, so its content was not read. ` +
		`Do not treat the text below as the article.\n` +
		`Options: ${options.join("; or ")}.\n\nWhat the page showed:\n${snippet}`
	);
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
	/**
	 * The conversation (and owner) whose persistent cache backs the per-turn
	 * map: text read in an earlier turn is reused, within the freshness window
	 * without downloading, after it when the downloaded bytes hash the same.
	 * Absent means no persistent cache (the approval-resume path, tests).
	 */
	persist?: CacheScope;
	/** Read the page in the browser, skipping the direct attempt (only when the renderer is available). */
	render?: boolean;
	/**
	 * Whether `render: true` is on offer. Only changes the wording of the
	 * failure message when the page showed a consent wall.
	 */
	renderAvailable?: boolean;
}

/** A cache that is only an optimisation must never fail the fetch it serves. */
async function quietly<T>(what: string, work: Promise<T>): Promise<T | null> {
	try {
		return await work;
	} catch (error) {
		logger.warn({ err: error }, `web_fetch_cache_${what}_failed`);
		return null;
	}
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
		const render = options.render === true;
		const cacheKey = fetchCacheKey(url, render);
		let page = options.cache?.get(cacheKey);
		if (!page) {
			// A forced render is asked for because what was read before was not
			// enough: the stored text of the same URL is not the answer.
			const stored =
				options.persist && !render
					? await quietly("read", getCachedFetch(options.persist, url))
					: null;
			if (stored && Date.now() - stored.fetchedAt.getTime() < freshWindowMs()) {
				logger.debug({ url, hit: "fresh" }, "web_fetch_cache_hit");
				page = { title: stored.title, finalUrl: stored.finalUrl, text: stored.text };
			} else {
				const fetched = await fetchPage(url, { render });
				const finalUrl = canonicalUrl(fetched.url) ?? url;
				const contentHash = sha256Hex(fetched.document ? fetched.document.bytes : fetched.content);
				if (stored && stored.contentHash === contentHash) {
					logger.debug({ url, hit: "hash" }, "web_fetch_cache_hit");
					page = { title: stored.title, finalUrl: stored.finalUrl, text: stored.text };
					if (options.persist) await quietly("refresh", refreshCachedFetch(options.persist, url));
				} else {
					if (options.persist)
						logger.debug({ url, replaced: Boolean(stored) }, "web_fetch_cache_miss");
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
					// A wall is not the page: say so, and keep it out of the caches.
					const gate = fetched.document ? null : detectGate(text, finalUrl);
					if (gate) {
						return {
							result: {
								error: gateFailureMessage(gate, text, {
									canRender:
										(options.renderAvailable ?? false) &&
										!render &&
										fetched.backend !== "playwright",
								}),
							},
						};
					}
					page = { title, finalUrl, text };
					if (options.persist) {
						await quietly(
							"write",
							putCachedFetch(options.persist, url, {
								finalUrl,
								title,
								text,
								contentHash,
								contentType: fetched.document?.mime ?? fetched.contentType,
								extractedBy: fetched.document ? "document" : "html",
							})
						);
					}
				}
			}
			options.cache?.set(cacheKey, page);
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

const WEB_FETCH_BASE_DESCRIPTION =
	"Read a web page or a document (PDF, Word, Excel, PowerPoint, epub). Long content arrives in " +
	"chunks: when the result ends with a note that more remains, call again with the same url and " +
	"the offset it names to continue. The URL must have been provided by the user or returned by web_search.";

const WEB_FETCH_BASE_PREPROMPT =
	"WEB FETCH: Read one specific page only after the user supplied its URL or web_search returned it. " +
	"Use web_search first to discover pages. PDFs and other documents can be read too. Long content arrives in chunks: " +
	"read on by calling again with the same url and the offset the result names. Cite the URL you read.";

/**
 * The tool's definition and preprompt. They differ with the renderer: with it
 * the model is told how pages are read and about `render`; without it nothing
 * is said about rendering at all, as there is nothing it could do about it.
 */
export function webFetchDefinition(renderAvailable: boolean): {
	definition: BuiltinTool["definition"];
	preprompt: string;
} {
	const properties: Record<string, unknown> = {
		url: {
			type: "string",
			description: "An HTTPS URL previously supplied by the user or web_search.",
		},
		offset: {
			type: "integer",
			description: "Character position to start from, to read on from a previous chunk. Default 0.",
		},
	};
	if (renderAvailable) {
		properties.render = {
			type: "boolean",
			description:
				"Read the page in a real browser instead of fetching it directly. Use it only when a " +
				"previous read looked incomplete, was a JavaScript shell, or was a consent or cookie notice. Default false.",
		};
	}
	return {
		definition: {
			type: "function",
			function: {
				name: WEB_FETCH_TOOL_NAME,
				description: renderAvailable
					? WEB_FETCH_BASE_DESCRIPTION +
						" Pages are read directly first, and a real browser is used when that comes back empty. " +
						"Set render to true to re-read a page in a real browser when its content looks incomplete, " +
						"is a JavaScript shell, or is a consent or cookie notice."
					: WEB_FETCH_BASE_DESCRIPTION,
				parameters: { type: "object", properties, required: ["url"] },
			},
		},
		preprompt: renderAvailable
			? WEB_FETCH_BASE_PREPROMPT +
				" Pages are read directly first and in a browser when that comes back empty; " +
				"if a result looks incomplete, is a JavaScript shell or a consent or cookie notice, " +
				"call again with render: true."
			: WEB_FETCH_BASE_PREPROMPT,
	};
}

export function createWebFetchBuiltin(
	params: {
		allowedUrls: Set<string>;
		persist?: CacheScope;
		/** The renderer is the configured backend and answers: `render` is offered. */
		renderAvailable?: boolean;
	} & WebFetchApprovalParams
): BuiltinTool {
	let uses = 0;
	// Per turn (the tool is built per turn): paging through one long page or
	// document costs one fetch and one extraction, not one per chunk.
	const cache = new Map<string, ReadablePage>();
	const renderAvailable = params.renderAvailable === true;
	const { definition, preprompt } = webFetchDefinition(renderAvailable);
	return {
		name: WEB_FETCH_TOOL_NAME,
		definition,
		preprompt,
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
			// Only honoured when it was offered.
			const render = renderAvailable && args.render === true;
			const key = fetchCacheKey(requested, render);
			if (!cache.has(key) && uses >= MAX_FETCHES_PER_TURN) {
				return { error: `This turn may read at most ${MAX_FETCHES_PER_TURN} web pages.` };
			}
			// Increment before I/O so parallel calls cannot race past the cap.
			if (!cache.has(key)) uses += 1;

			const { result, finalUrl } = await performFetch(requested, {
				offset,
				token: params.token,
				cache,
				persist: params.persist,
				render,
				renderAvailable,
			});
			if ("resultText" in result) {
				params.allowedUrls.add(finalUrl ?? requested);
			}
			return result;
		},
	};
}
