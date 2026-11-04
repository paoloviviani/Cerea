/**
 * The composer's Auto step (ADR 0107 section 3): its label, and the computed expectation line.
 *
 * Three layers, each a cap, the most cautious wins: the machine's limit per class (hello), the
 * administrator's row per class (you | reviewer), and the session's word. This works out, for a
 * session on Auto (the wire word `allow`), what happens to each class and why.
 */
import { m } from "$lib/paraglide/messages";
import type { ReviewAnswerer } from "$lib/types/AgentReview";
import {
	machineLimits,
	PERMISSION_CLASSES,
	type PermissionClass,
	type PermissionLimit,
	type Policy,
} from "$lib/types/machineProtocol";

/** What happens to a class under Auto. */
export type ClassOutcome = "run" | "reviewed" | "you" | "never" | "stop";
/** Why: the machine's own limit, the administrator's row, or the deployment/device switch. */
export type ClassReason = "machine" | "admin" | "older" | "device" | "deployment";

export interface ClassRow {
	class: PermissionClass;
	outcome: ClassOutcome;
	limit: PermissionLimit;
	reason: ClassReason;
}

export interface AutoSetup {
	/** The deployment's kill switch is on, a reviewer is enabled and has a model. */
	reviewerAvailable: boolean;
	/** The administrator's rows. */
	perClass: Record<PermissionClass, ReviewAnswerer>;
	/** The device's owner opted out of the reviewer. */
	neverReview?: boolean;
}

/** The third step reads "Auto" only when a reviewer can answer for this machine. */
export function thirdStepLabel(setup: AutoSetup | null | undefined): "auto" | "allow" {
	return setup?.reviewerAvailable && !setup.neverReview ? "auto" : "allow";
}

/**
 * The limits of a machine older than classes: the old fields' equivalent. The default ceiling had
 * bash on ask, and outside access and `.env` on ask under Allow; everything else ran.
 */
export function limitsOfOlderMachine(
	policy: Policy | undefined
): Record<PermissionClass, PermissionLimit> {
	const max = policy?.permission?.max ?? {};
	const word = (...keys: string[]): PermissionLimit | undefined => {
		const found = keys.map((k) => max[k] ?? max["*"]).filter(Boolean);
		if (found.includes("deny")) return "deny";
		if (found.includes("ask")) return "ask";
		return found.length ? "allow" : undefined;
	};
	return {
		edit: word("edit") ?? "allow",
		command: word("bash") ?? "ask",
		web: word("webfetch", "websearch", "codesearch") ?? "allow",
		outside: word("external_directory") ?? "ask",
		secrets: "ask",
		agents: word("task") ?? "allow",
		tools: "allow",
		loop: "ask",
	};
}

export function classRows(
	policy: Policy | undefined,
	setup: AutoSetup
): { rows: ClassRow[]; older: boolean } {
	const reported = machineLimits(policy);
	const older = reported === undefined;
	const limits = older
		? limitsOfOlderMachine(policy)
		: { ...limitsOfOlderMachine(undefined), ...reported };
	const rows = PERMISSION_CLASSES.map((c): ClassRow => {
		const limit = limits[c] ?? "allow";
		const base = { class: c, limit };
		if (limit === "deny") return { ...base, outcome: "never", reason: older ? "older" : "machine" };
		if (limit === "stop") return { ...base, outcome: "stop", reason: "machine" };
		if (limit === "allow") return { ...base, outcome: "run", reason: older ? "older" : "machine" };
		// ask: a card is raised; who answers is the deployment's and the device's
		if (c === "loop") return { ...base, outcome: "you", reason: "admin" };
		if (!setup.reviewerAvailable) return { ...base, outcome: "you", reason: "deployment" };
		if (setup.neverReview) return { ...base, outcome: "you", reason: "device" };
		return setup.perClass[c] === "reviewer"
			? { ...base, outcome: "reviewed", reason: "admin" }
			: { ...base, outcome: "you", reason: "admin" };
	});
	return { rows, older };
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
export function expectationLine(
	machineName: string,
	rows: ClassRow[],
	label: "auto" | "allow"
): string {
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
	push("never", (classes) => m["code.auto.line.never"]({ classes }));
	push("stop", (classes) => m["code.auto.line.stop"]({ classes }));
	const head = (label === "auto" ? m["code.auto.line.head_auto"] : m["code.auto.line.head_allow"])({
		machine: machineName,
	});
	return `${head} ${parts.join(" · ")}`;
}

export function reasonText(row: ClassRow): string {
	switch (row.reason) {
		case "machine":
			return m["code.auto.reason.machine"]();
		case "older":
			return m["code.auto.reason.older"]();
		case "device":
			return m["code.auto.reason.device"]();
		case "deployment":
			return m["code.auto.reason.deployment"]();
		default:
			return row.outcome === "you" && row.class === "loop"
				? m["code.auto.reason.loop"]()
				: m["code.auto.reason.admin"]();
	}
}

export function outcomeText(row: ClassRow): string {
	return {
		run: m["code.auto.outcome.run"],
		reviewed: m["code.auto.outcome.reviewed"],
		you: m["code.auto.outcome.you"],
		never: m["code.auto.outcome.never"],
		stop: m["code.auto.outcome.stop"],
	}[row.outcome]();
}
