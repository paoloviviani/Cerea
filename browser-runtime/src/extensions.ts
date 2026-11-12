/**
 * Additions to Cerea's contract that the runtime speaks ahead of `contract.ts` (which Cerea's server
 * side owns and `scripts/sync-contract.mjs` copies, so it is never edited here). Each is marked
 * PROPOSED: the Cerea worker adds the same to `contract.ts`, and this file then shrinks to
 * nothing. Until then the runtime's results carry these fields; a Cerea that does not know them
 * ignores them (zod strips unknown keys).
 */

import { createHash } from "node:crypto";
import { z } from "zod";
import { urlWithoutFragment } from "./classifier.ts";
import { browserActionSchema, type BrowserAction } from "./contract.ts";

/** PROPOSED: a tool that lists the open pages of the persistent context. */
export const TABS_TOOL = "tabs";

/** PROPOSED: an `act` action that adopts a page the user opened. Always commit-class (`user-tab`). */
export const useTabActionSchema = z.object({
	type: z.literal("use_tab"),
	/** A tab id from `tabs()`. */
	tab: z.string().min(1).max(64),
});
export type UseTabAction = z.infer<typeof useTabActionSchema>;
export type RuntimeAction = BrowserAction | UseTabAction;

export const runtimeActionSchema = z.discriminatedUnion("type", [
	...browserActionSchema.options,
	useTabActionSchema,
]);

/** PROPOSED: `tabs()` result. `mine` is true for a page the task owns (opened by it, or adopted). */
export const tabSchema = z.object({
	id: z.string().max(64),
	title: z.string().max(500),
	url: z.string().max(4096),
	mine: z.boolean(),
});
export const tabsResultSchema = z.object({ tabs: z.array(tabSchema).max(100) });
export type Tab = z.infer<typeof tabSchema>;

/** PROPOSED: `refused: "challenge"` joins the refusal enum; `challenge` rides on snapshot and diff. */
export const CHALLENGE_REFUSAL = "challenge" as const;
export const challengeSchema = z.object({ kind: z.string().max(32) });
export type Challenge = z.infer<typeof challengeSchema>;

/**
 * PROPOSED: the digest of a `use_tab` grant, in the same eight-field form as every other action:
 * `[ "use_tab", tabId, "", tabUrlWithoutFragment, tabTitle, "user-tab", "", "0" ]`. It binds the
 * tab, the address it is on and its title as `tabs()` showed them, so a tab that navigated since
 * the user approved no longer matches.
 */
export function useTabDigest(tab: { id: string; url: string; title: string }): string {
	const canonical = JSON.stringify([
		"use_tab",
		tab.id,
		"",
		urlWithoutFragment(tab.url),
		tab.title,
		"user-tab",
		"",
		"0",
	]);
	return createHash("sha256").update(canonical).digest("hex").slice(0, 32);
}
