/**
 * The /code audit trail (ADR 0090): who used a machine power, on which
 * device, where, and how much — never file content, never keystrokes or
 * terminal output. Best-effort: a failed write is logged, the action goes on.
 */
import { ObjectId } from "mongodb";
import type { RequestEvent } from "@sveltejs/kit";
import { collections } from "$lib/server/database";
import { logger } from "$lib/server/logger";

export interface CodeAuditInput {
	action: string;
	deviceId: string;
	workspaceId?: string;
	path?: string;
	bytes?: number;
	/** A terminal action's target (open/attach/close, refusals, ticket
	 * failures) — never the terminal's content or keystrokes. */
	terminalId?: string;
	/** A command run's own facts (code.command): its name, the machine's
	 * derived origin, whether its template expands shell ("unknown" when the
	 * wire said nothing — a null shell is the absence of an affirmation,
	 * not a false), and the outcome ("run", or the machine's refusal code)
	 * — never the arguments, never any expanded text. */
	name?: string;
	origin?: string;
	shell?: string;
	outcome?: string;
	/** A permission action's session and the exception it touched
	 * (`permission.saved.remove`) — ids only, never the exception's patterns
	 * (for bash the pattern IS the command text). */
	sessionId?: string;
	approvalId?: string;
	/** The blanket a `permission.mode` set: deny, ask or allow. */
	mode?: string;
	/** A schedule an agent's `schedule.*` call touched (its name rides in `name`). */
	scheduleId?: string;
}

/** The row-writing core, independent of a SvelteKit `RequestEvent`: the
 * terminal WebSocket upgrade (`terminalServer.ts`) runs below SvelteKit's
 * routing (an upgrade bypasses hooks, same reason the machine link's own
 * auth is pre-upgrade), so it never has one to pull `locals`/`request` off
 * of. `recordCodeAudit` below is the REST-route convenience wrapper. */
export async function recordCodeAuditRow(
	userId: ObjectId,
	input: CodeAuditInput,
	context: { ip?: string; userAgent?: string } = {}
): Promise<void> {
	try {
		await collections.codeAudit.insertOne({
			_id: new ObjectId(),
			userId,
			deviceId: new ObjectId(input.deviceId),
			action: input.action,
			...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
			...(input.path ? { path: input.path.slice(0, 1024) } : {}),
			...(input.bytes !== undefined ? { bytes: input.bytes } : {}),
			...(input.terminalId ? { terminalId: input.terminalId } : {}),
			...(input.name ? { name: input.name } : {}),
			...(input.origin ? { origin: input.origin } : {}),
			...(input.shell ? { shell: input.shell } : {}),
			...(input.outcome ? { outcome: input.outcome } : {}),
			...(input.sessionId ? { sessionId: input.sessionId.slice(0, 200) } : {}),
			...(input.approvalId ? { approvalId: input.approvalId.slice(0, 200) } : {}),
			...(input.mode ? { mode: input.mode.slice(0, 16) } : {}),
			...(input.scheduleId ? { scheduleId: input.scheduleId.slice(0, 64) } : {}),
			...(context.ip ? { ip: context.ip } : {}),
			...(context.userAgent ? { userAgent: context.userAgent.slice(0, 256) } : {}),
			at: new Date(),
		});
	} catch (err) {
		logger.warn({ err: String(err), action: input.action }, "code audit: write failed");
	}
}

export async function recordCodeAudit(
	event: Pick<RequestEvent, "locals" | "request" | "getClientAddress">,
	input: CodeAuditInput
): Promise<void> {
	const userId = event.locals.user?._id;
	if (!userId) return;
	let ip: string | undefined;
	try {
		ip = event.getClientAddress();
	} catch {
		ip = undefined;
	}
	await recordCodeAuditRow(userId, input, {
		ip,
		userAgent: event.request.headers.get("user-agent") ?? undefined,
	});
}
