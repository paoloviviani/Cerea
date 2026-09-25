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
	try {
		await collections.codeAudit.insertOne({
			_id: new ObjectId(),
			userId,
			deviceId: new ObjectId(input.deviceId),
			action: input.action,
			...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
			...(input.path ? { path: input.path.slice(0, 1024) } : {}),
			...(input.bytes !== undefined ? { bytes: input.bytes } : {}),
			...(ip ? { ip } : {}),
			...(event.request.headers.get("user-agent")
				? { userAgent: event.request.headers.get("user-agent")?.slice(0, 256) }
				: {}),
			at: new Date(),
		});
	} catch (err) {
		logger.warn({ err: String(err), action: input.action }, "code audit: write failed");
	}
}
