// Dependency-free subset of the markdown pipeline.
//
// Everything importable from the main-thread entry chunks (MarkdownRenderer,
// the worker pool, ArtifactPanel) must come from here: the rich pipeline in
// ./marked.ts pulls in KaTeX + highlight.js (~700KB decoded), which must only
// ever load inside the markdown worker or through a dynamic import().

export type CodeToken = {
	type: "code";
	lang: string;
	code: string;
	rawCode: string;
	isClosed: boolean;
};

export type TextToken = {
	type: "text";
	html: string | Promise<string>;
};

export type Token = CodeToken | TextToken;

export type BlockToken = {
	id: string;
	content: string;
	tokens: Token[];
};

export function escapeHTML(content: string) {
	return content.replace(
		/[<>&"']/g,
		(x) =>
			({
				"<": "&lt;",
				">": "&gt;",
				"&": "&amp;",
				"'": "&#39;",
				'"': "&quot;",
			})[x] || x
	);
}

/**
 * The one allowlist for where a markdown link or image may point. Returns the
 * cleaned target, or undefined when it should not be a link at all.
 *
 * Links: absolute http(s) URLs with a host, mailto:, tel:, in-page #anchors and
 * same-origin absolute paths (one leading `/`; `//host` and `/\\host` are
 * protocol-relative and refused). Anything else (relative paths, `:/id` note
 * links, joplin:, obsidian:, file:, javascript:, ...) would resolve to nothing
 * useful against the page, so it is shown as plain text: no link is better than
 * a broken link. Images additionally accept data:image/* and blob:.
 */
export function safeLinkTarget(
	href: string | null | undefined,
	kind: "link" | "image" = "link"
): string | undefined {
	if (!href) return undefined;
	const target = href.trim().replace(/>$/, "");
	if (!target) return undefined;
	// Browsers drop tabs and newlines inside a URL, so "java\tscript:" is a scheme.
	// eslint-disable-next-line no-control-regex
	const probe = target.replace(/[\u0000-\u0020]/g, "");
	if (probe.startsWith("#")) return kind === "link" && probe.length > 1 ? target : undefined;
	if (probe.startsWith("/")) {
		return /^\/[/\\]/.test(probe) ? undefined : target;
	}
	const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(probe)?.[1]?.toLowerCase();
	if (!scheme) return undefined;
	if (scheme === "http" || scheme === "https") {
		try {
			return new URL(probe).hostname ? target : undefined;
		} catch {
			return undefined;
		}
	}
	if (kind === "link") return scheme === "mailto" || scheme === "tel" ? target : undefined;
	if (scheme === "blob") return target;
	if (scheme === "data") {
		return /^data:image\/(png|jpe?g|gif|webp|avif|bmp|svg\+xml)[;,]/i.test(probe)
			? target
			: undefined;
	}
	return undefined;
}

/**
 * Cheap, allocation-light blocks used for SSR and the initial client render.
 *
 * Rich markdown rendering (marked + highlight.js + KaTeX + DOMPurify/jsdom) is
 * intentionally NOT run here: it executes synchronously on the single Node event loop
 * during SSR and, summed across every message of a conversation, can block the loop
 * long enough to fail liveness/readiness health checks (observed event-loop stalls up
 * to ~1.5s). The browser upgrades each message to fully rendered markdown via the
 * markdown worker (or async processBlocks fallback) on mount.
 *
 * The output is deterministic and identical on server and client, so hydration is not
 * affected; only the first paint shows lightly-formatted text before the worker result
 * arrives.
 */
/** A closed fenced code block found by `findClosedFences` — language tag and raw inner text. */
export interface ClosedFence {
	lang: string;
	rawCode: string;
}

// Same opening/closing fence length, no leading indentation: the common case
// for a model-emitted block. A fence outside that (4+ backticks, one indented
// inside a list) simply isn't found here — CodeBlock's own per-render mark is
// the fallback for whatever this misses (see MarkdownRenderer.svelte).
const CLOSED_FENCE_RE =
	/^ {0,3}(`{3,}|~{3,})[ \t]*([^\n`]*)\r?\n([\s\S]*?)\r?\n {0,3}\1[ \t]*(?:\r?\n|$)/gm;

/**
 * Closed fenced code blocks in raw markdown text, found synchronously and
 * without a real markdown parser: language and raw text only, no HTML.
 *
 * Exists so a fence can be marked "seen live" (see `RunsStore.markSeenStreaming`
 * in execution/runs.svelte.ts) the instant its closed content is captured —
 * synchronously, in the same tick that captures the page's own generating
 * flag — rather than waiting for the async markdown pipeline (a worker round
 * trip, or a dynamically-imported rich module on first use) to tokenize it.
 * That pipeline can easily outlast the flag: some models stream only their
 * thinking and deliver the whole visible answer, fence already closed, in
 * one final chunk, and by the time the async pipeline's result renders, the
 * flag may already have flipped — CodeBlock's own render-time mark would then
 * never fire.
 */
export function findClosedFences(content: string): ClosedFence[] {
	const fences: ClosedFence[] = [];
	CLOSED_FENCE_RE.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = CLOSED_FENCE_RE.exec(content))) {
		fences.push({ lang: match[2].trim(), rawCode: match[3] });
	}
	return fences;
}

export function fallbackBlocks(content: string): BlockToken[] {
	// Static id: it is only used as the {#each} key for this single throwaway block and
	// has no semantic meaning, so there is no need to hash the (potentially large) content.
	return [
		{
			id: "fallback",
			content,
			tokens: [
				{
					type: "text",
					html: `<div style="white-space:pre-wrap;overflow-wrap:anywhere">${escapeHTML(content)}</div>`,
				},
			],
		},
	];
}
