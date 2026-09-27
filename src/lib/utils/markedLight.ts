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
