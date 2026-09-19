/**
 * `web_fetch_structured`: read a page like `web_fetch`, but return its
 * structure — an accessibility tree — instead of extracted prose. Built on
 * `page.ariaSnapshot({ mode: "ai" })` through the same renderer `web_fetch`
 * uses (`$lib/server/fetching/playwright.ts`).
 *
 * **A `screenshot` tool was built alongside this one, and removed before
 * shipping.** Recording why, because the reasoning is durable and will
 * otherwise be rediscovered the hard way:
 *
 * `screenshot` was proposed on the premise that a vision-capable model could
 * read a page defeat by text extraction — a chart, a canvas, a dashboard —
 * by looking at a render of it. That premise does not hold on this stack, or
 * on any OpenAI-compatible one: the Chat Completions protocol types a
 * tool-role message's `content` as `string | ChatCompletionContentPartText[]`
 * — no image content part is valid there at all. Image parts
 * (`ChatCompletionContentPartImage`) are valid only on `user`-role messages,
 * and this app only ever builds them from a persisted user message's own
 * file attachments (`prepareFiles.ts`). A model calling a screenshot tool
 * therefore never sees the image it asked for — it gets a paragraph naming
 * dimensions and a download path, and the actual bytes go to a person who
 * could have taken that screenshot themselves. What was left, once the
 * vision premise fell away, was a file-production tool the model gains
 * nothing from reasoning about — the weaker case `page_to_pdf` was already
 * removed for (a pure export, overlapping what `execute_code`'s browser
 * sandbox already produces) — while still paying for a gated approval flow,
 * a deliverable-storage path, and a vision-capability check. None of that
 * infrastructure survived the removal; there is nothing left in this module
 * or in `$lib/server/fetching/playwright.ts` that exists solely to support
 * it.
 *
 * **If a screenshot-shaped tool is proposed again**, the question to ask
 * first is not "can Playwright capture this" (it can) but "how does the
 * result reach the model" — today's honest answers are: a text description
 * only (what this file avoided building, judged not worth the surface
 * area), or a synthetic `user`-role message carrying the image on a *later*
 * round (unbuilt; touches the round loop, replay, and the history-budget
 * accounting in `utils/prepareFiles.ts`, well beyond a builtin-tool
 * addition).
 *
 * Built against `run-server`'s own API rather than adopting
 * `@playwright/mcp` — see ADR 0079. The short version: that project's core
 * tool set ships `browser_evaluate` (model-supplied JavaScript, executed
 * server-side), which this project forbids outright. Writing this tool
 * ourselves means that capability simply does not exist here — no
 * allowlist, no config flag, nothing to misconfigure into exposing it.
 *
 * **Every call needs approval**, unconditionally (ADR 0079 extends ADR
 * 0075's gated set). Unlike `web_fetch`, there is no trusted-URL exemption
 * for a URL the user already supplied or `web_search` already returned — ADR
 * 0075 itself found that kind of carve-out ("auto-verified") to be theater
 * risk once a real approval card exists, and this tool never had a legacy
 * auto-run behavior to preserve the way `web_fetch` did. `execute()`
 * re-checks the gate itself (`isCleared` below) as a defence in depth: if a
 * future caller of this module ever dispatches a call without routing it
 * through the checkpoint in `toolInvocation.ts` first, the call fails closed
 * here rather than silently running.
 */

import { accessibilitySnapshotWithPlaywright } from "$lib/server/fetching/playwright";
import { canonicalUrl } from "./fetchUrlUtils";
import { MAX_FETCH_RESULT_CHARS } from "./webFetchTool";
import type { BuiltinTool } from "./types";

export const WEB_FETCH_STRUCTURED_TOOL_NAME = "web_fetch_structured";

// Rendering a page is heavier than fetching its bytes, and every call here
// already costs a click (or an always-allow policy an administrator chose) —
// a smaller ceiling than web_fetch's MAX_FETCHES_PER_TURN (20) still leaves
// room for real use while bounding a runaway loop under always-allow.
export const MAX_STRUCTURED_SNAPSHOT_CALLS_PER_TURN = 20;

/** Same result shape `performFetch` (webFetchTool.ts) uses, so the resume dispatch table in resumeElicitation.ts can treat every gated builtin uniformly. */
export type FetchOutcome = { resultText: string } | { error: string };

export async function performAccessibilitySnapshot(
	url: string
): Promise<{ result: FetchOutcome; finalUrl?: string }> {
	try {
		const page = await accessibilitySnapshotWithPlaywright(url);
		const finalUrl = canonicalUrl(page.url) ?? url;
		const snapshot = page.snapshot.trim();
		if (!snapshot) return { result: { error: "That page had no accessible content." }, finalUrl };
		const truncated = snapshot.length > MAX_FETCH_RESULT_CHARS;
		return {
			result: {
				resultText:
					`Title: ${page.title ?? "Untitled"}\nURL: ${finalUrl}\n\n` +
					snapshot.slice(0, MAX_FETCH_RESULT_CHARS) +
					(truncated ? "\n\n[Content truncated.]" : ""),
			},
			finalUrl,
		};
	} catch (error) {
		return {
			result: {
				error: `Could not read that page's structure: ${error instanceof Error ? error.message : "unknown error"}`,
			},
		};
	}
}

interface GatedToolParams {
	toolApprovalPolicy?: "always-allow" | "manual";
	approvedTools?: Set<string>;
}

/**
 * The defence-in-depth re-check `execute()` runs at the top:
 * `toolInvocation.ts` is what actually opens the approval card, so by the
 * time execute() runs for a manual-policy call it must already be cleared.
 * This is the fallback for anything that reaches execute() another way —
 * see webFetchTool.ts's own version of the same check.
 */
function isCleared(name: string, params: GatedToolParams): boolean {
	return params.toolApprovalPolicy === "always-allow" || (params.approvedTools?.has(name) ?? false);
}

export function createWebFetchStructuredBuiltin(params: GatedToolParams): BuiltinTool {
	let callsThisTurn = 0;
	return {
		name: WEB_FETCH_STRUCTURED_TOOL_NAME,
		definition: {
			type: "function",
			function: {
				name: WEB_FETCH_STRUCTURED_TOOL_NAME,
				description:
					"Read a web page like web_fetch, but return its structure instead of extracted prose: " +
					"an accessibility tree of roles, names and stable element references " +
					"(e.g. `[ref=e12]`), the same shape a screen reader or an automation script would see. " +
					"Prefer this over web_fetch when you need to reason about a page's controls, layout or " +
					"navigation rather than read its writing. Every call needs the person's explicit " +
					"approval first. The URL must have been provided by the user or returned by web_search.",
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
		async execute(args, _ctx) {
			const requested = typeof args.url === "string" ? canonicalUrl(args.url.trim()) : null;
			if (!requested) return { error: "The page URL must be a valid HTTPS URL." };
			if (!isCleared(WEB_FETCH_STRUCTURED_TOOL_NAME, params)) {
				return { error: "That call was not approved." };
			}
			if (callsThisTurn >= MAX_STRUCTURED_SNAPSHOT_CALLS_PER_TURN) {
				return {
					error: `web_fetch_structured has reached its limit of ${MAX_STRUCTURED_SNAPSHOT_CALLS_PER_TURN} calls for this turn.`,
				};
			}
			callsThisTurn += 1;
			const { result } = await performAccessibilitySnapshot(requested);
			return result;
		},
	};
}
