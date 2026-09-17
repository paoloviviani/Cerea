import type { Conversation } from "$lib/types/Conversation";
import type { Settings } from "$lib/types/Settings";

/**
 * Resolves the one global tool-approval policy (ADR 0075) for a turn: chat
 * override wins, then the user's setting, then `manual`. Settings hold the
 * default; a chat holds per-chat state — the same split `webSearch` already
 * uses (`conv.webSearch` over `Settings.webSearchEnabled`).
 */
export function resolveToolApprovalPolicy(
	conv: Pick<Conversation, "toolApprovalOverride">,
	settings: Pick<Settings, "toolApprovalPolicy"> | null | undefined
): "always-allow" | "manual" {
	return conv.toolApprovalOverride ?? settings?.toolApprovalPolicy ?? "manual";
}
