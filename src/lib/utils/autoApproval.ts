/**
 * The composer's Auto step and the shield sheet's rows (ADR 0109): no machine limits. For a
 * session on Auto, each class either runs (the user's row says `runs`, or the fixed floor lets it),
 * is reviewed, or comes to the user. Three things decide, the most cautious wins: the session's
 * word, the user's rows (Workspace -> Agents) and the fixed floor (secrets and loops are always a
 * card). Allow is hands off apart from that floor.
 */
import { m } from "$lib/paraglide/messages";
import type { ReviewAnswerer } from "$lib/types/AgentReview";
import { PERMISSION_CLASSES, type PermissionClass } from "$lib/types/machineProtocol";

/** What happens to a class. */
export type ClassOutcome = "run" | "reviewed" | "you";
/** Why: the user's row, the fixed floor, or the reviewer being off for the deployment / device. */
export type ClassReason = "row" | "floor" | "device" | "deployment";

export interface ClassRow {
	class: PermissionClass;
	outcome: ClassOutcome;
	reason: ClassReason;
}

export interface AutoSetup {
	/** The deployment's kill switch is on and the user's reviewer is on with a model. */
	reviewerAvailable: boolean;
	/** The user's own rows. */
	perClass: Record<PermissionClass, ReviewAnswerer>;
	/** The device's owner opted out of the reviewer. */
	neverReview?: boolean;
	/** The reviewer keeps failing: Auto's cards come to the user until it answers again. */
	degraded?: boolean;
}

/** Whether a reviewer can answer for this machine's Auto cards. */
export function reviewerFor(setup: AutoSetup | null | undefined): boolean {
	return Boolean(setup?.reviewerAvailable && !setup.neverReview);
}

/** The rows for a session on Auto: one per class. */
export function classRows(setup: AutoSetup): ClassRow[] {
	return PERMISSION_CLASSES.map((c): ClassRow => {
		if (c === "loop") return { class: c, outcome: "you", reason: "floor" };
		const row = setup.perClass[c] ?? "you";
		if (c === "secrets") {
			// Credential paths always raise a card; the row only says who answers it.
			if (row === "reviewer" && reviewerFor(setup)) {
				return { class: c, outcome: "reviewed", reason: "row" };
			}
			return { class: c, outcome: "you", reason: "floor" };
		}
		if (row === "run") return { class: c, outcome: "run", reason: "row" };
		if (row === "reviewer") {
			if (!setup.reviewerAvailable) return { class: c, outcome: "you", reason: "deployment" };
			if (setup.neverReview) return { class: c, outcome: "you", reason: "device" };
			return { class: c, outcome: "reviewed", reason: "row" };
		}
		return { class: c, outcome: "you", reason: "row" };
	});
}

const NAMES: Record<PermissionClass, () => string> = {
	edit: m["code.auto.class.edit"],
	command: m["code.auto.class.command"],
	web: m["code.auto.class.web"],
	outside: m["code.auto.class.outside"],
	secrets: m["code.auto.class.secrets"],
	agents: m["code.auto.class.agents"],
	tools: m["code.auto.class.tools"],
	loop: m["code.auto.class.loop"],
};
export const className = (c: PermissionClass): string => NAMES[c]();

function list(items: string[]): string {
	if (items.length < 2) return items.join("");
	return `${items.slice(0, -1).join(", ")} ${m["code.auto.line.and"]()} ${items[items.length - 1]}`;
}

/** "Auto on studio-laptop: edits, web and tools run · commands and outside access are reviewed · secrets come to you" */
export function expectationLine(machineName: string, rows: ClassRow[]): string {
	const group = (o: ClassOutcome) =>
		list(rows.filter((r) => r.outcome === o).map((r) => className(r.class)));
	const parts: string[] = [];
	const push = (o: ClassOutcome, text: (classes: string) => string) => {
		const g = group(o);
		if (g) parts.push(text(g));
	};
	push("run", (classes) => m["code.auto.line.run"]({ classes }));
	push("reviewed", (classes) => m["code.auto.line.reviewed"]({ classes }));
	push("you", (classes) => m["code.auto.line.you"]({ classes }));
	return `${m["code.auto.line.head_auto"]({ machine: machineName })} ${parts.join(" · ")}`;
}

export function reasonText(row: ClassRow): string {
	switch (row.reason) {
		case "floor":
			return row.class === "loop" ? m["code.auto.reason.loop"]() : m["code.auto.reason.floor"]();
		case "device":
			return m["code.auto.reason.device"]();
		case "deployment":
			return m["code.auto.reason.deployment"]();
		default:
			return m["code.auto.reason.row"]();
	}
}

export function outcomeText(row: ClassRow): string {
	return {
		run: m["code.auto.outcome.run"],
		reviewed: m["code.auto.outcome.reviewed"],
		you: m["code.auto.outcome.you"],
	}[row.outcome]();
}
