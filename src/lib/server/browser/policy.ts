/**
 * From an action's class to what Cerea does with it: allow it, ask the user, or refuse it.
 *
 * The classes map onto the Plan · Ask · Allow ceiling (ADR 0097) like this:
 *
 * | ceiling | read  | input   | commit                                  |
 * |---------|-------|---------|-----------------------------------------|
 * | plan    | allow | refuse  | refuse                                  |
 * | ask     | allow | allow   | ask                                     |
 * | allow   | allow | allow   | ask (commits ask even under Allow)      |
 *
 * A chat has no Plan mode; its tool-approval policy gives `ask` (manual) or `allow`
 * (always-allow). Commits ask under both, as the ADR says: Allow is for the user's own tools, a
 * purchase is not one. The administrator's site lists change that per site: a denied site refuses
 * everything on it (and leaving for it), an allow-listed site lets commits through without asking.
 * Nobody to ask (a scheduled run) refuses a commit that no allow-list covers.
 */

import type { ActionClass, Classification } from "./classifier";
import { matchesAny, type SiteRules } from "./siteRules";

export type Ceiling = "plan" | "ask" | "allow";
export type Verdict = "allow" | "ask" | "deny";

export interface Decision {
	verdict: Verdict;
	/** Why, in words the sub-agent can be told. */
	reason: string;
	/** Allowed without asking because an administrator allow-listed the site. */
	viaSiteRule?: boolean;
}

export interface DecideContext {
	classification: Classification;
	/** The host the action runs on. */
	currentHost?: string;
	rules: SiteRules;
	ceiling: Ceiling;
	/** Nobody is watching: an ask cannot be answered. */
	unattended?: boolean;
}

export function ceilingOf(policy: "always-allow" | "manual" | undefined): Ceiling {
	return policy === "always-allow" ? "allow" : "ask";
}

export function decide(ctx: DecideContext): Decision {
	const { classification, currentHost, rules, ceiling } = ctx;
	const cls: ActionClass = classification.class;
	const target = classification.targetHost;

	// A non-web address (javascript:, file:, data:, blob:, ...) is never asked about and no list
	// covers it: the runtime refuses it too.
	if (classification.reason === "bad-url") {
		return { verdict: "deny", reason: "Only http and https addresses may be opened." };
	}
	if (matchesAny(currentHost, rules.deny) || matchesAny(target, rules.deny)) {
		const site = matchesAny(target, rules.deny) ? target : currentHost;
		return {
			verdict: "deny",
			reason: `${site} is on this deployment's list of sites the browser may not use.`,
		};
	}
	if (cls === "read") return { verdict: "allow", reason: "reading" };
	if (ceiling === "plan") {
		return {
			verdict: "deny",
			reason: "This browsing session is read-only (plan mode): it may look but not type or act.",
		};
	}
	if (cls === "input") return { verdict: "allow", reason: "typing" };

	// A commit. The site that governs it is where it leads, when it leaves the page.
	const governing = target ?? currentHost;
	// A tab of the user's own is always asked about: no allow list covers it.
	if (classification.reason !== "user-tab" && matchesAny(governing, rules.allow)) {
		return { verdict: "allow", reason: `${governing} is on the allowed list`, viaSiteRule: true };
	}
	if (ctx.unattended) {
		return {
			verdict: "deny",
			reason: "This action needs the user's approval and nobody is here to give it.",
		};
	}
	return { verdict: "ask", reason: "this action commits something" };
}
