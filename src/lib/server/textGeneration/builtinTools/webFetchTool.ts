import { fetchPage } from "$lib/server/fetching";
import type { BuiltinTool } from "./types";

export const WEB_FETCH_TOOL_NAME = "web_fetch";

// A page is useful only after its markup, navigation, and boilerplate have
// gone. This keeps one fetch from crowding out the actual conversation.
export const MAX_FETCH_RESULT_CHARS = 24_000;
export const MAX_FETCHES_PER_TURN = 20;

/** Canonical form used for the provenance set, not an SSRF validation step. */
export function canonicalUrl(value: string): string | null {
	try {
		const url = new URL(value);
		return url.protocol === "https:" ? url.href : null;
	} catch {
		return null;
	}
}

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

export function createWebFetchBuiltin(params: { allowedUrls: Set<string> }): BuiltinTool {
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
		async execute(args) {
			const requested = typeof args.url === "string" ? canonicalUrl(args.url.trim()) : null;
			if (!requested) return { error: "The page URL must be a valid HTTPS URL." };
			if (!params.allowedUrls.has(requested)) {
				return {
					error:
						"That URL was not supplied by the user or returned by web_search. Search for it first, or ask the user for the link.",
				};
			}
			if (uses >= MAX_FETCHES_PER_TURN) {
				return { error: `This turn may read at most ${MAX_FETCHES_PER_TURN} web pages.` };
			}
			// Increment before I/O so parallel calls cannot race past the cap.
			uses += 1;

			try {
				const page = await fetchPage(requested);
				const finalUrl = canonicalUrl(page.url) ?? requested;
				params.allowedUrls.add(finalUrl);
				const text = readablePageText(page.content);
				if (!text) return { error: "That page had no readable text." };
				const truncated = text.length > MAX_FETCH_RESULT_CHARS;
				return {
					resultText:
						`Title: ${page.title ?? "Untitled"}\nURL: ${finalUrl}\n\n` +
						text.slice(0, MAX_FETCH_RESULT_CHARS) +
						(truncated ? "\n\n[Content truncated.]" : ""),
				};
			} catch (error) {
				return {
					error: `Could not fetch that page: ${error instanceof Error ? error.message : "unknown error"}`,
				};
			}
		},
	};
}
