import { createHash } from "node:crypto";
import type { RelayOp } from "$lib/types/CodeRelay";

/**
 * What a relayed call's ticket is bound to (ADR 0121 section 5): the op, the target, the
 * content, the hop and the CALLER'S session, so a ticket belongs to one caller session on one
 * device. Cerea computes it from its own record at ask time and again from the call's own
 * arguments at consume time; any difference is a refusal.
 */
export interface RelayCovered {
	op: RelayOp;
	computerId: string;
	/** send, read. */
	sessionId?: string | null;
	/** spawn. */
	workspaceId?: string | null;
	/** send. */
	text?: string | null;
	/** spawn. */
	prompt?: string | null;
	/** read, always explicit (the default is applied by the caller's galopin). */
	last?: number | null;
	/** spawn. */
	title?: string | null;
	/** spawn. */
	mode?: string | null;
	hop: number;
	callerSessionId: string;
}

/** JSON with every object's keys sorted and `undefined` read as null: one string per value. */
export function canonicalJson(value: unknown): string {
	if (value === undefined || value === null) return "null";
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
			a < b ? -1 : a > b ? 1 : 0
		);
		return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
	}
	return JSON.stringify(value);
}

/** The fixed field set, every field present (null when it does not apply to the op). */
export function ticketHash(c: RelayCovered): string {
	const fixed = {
		op: c.op,
		computerId: c.computerId,
		sessionId: c.sessionId ?? null,
		workspaceId: c.workspaceId ?? null,
		text: c.text ?? null,
		prompt: c.prompt ?? null,
		last: c.last ?? null,
		title: c.title ?? null,
		mode: c.mode ?? null,
		hop: c.hop,
		callerSessionId: c.callerSessionId,
	};
	return createHash("sha256").update(canonicalJson(fixed)).digest("hex");
}
