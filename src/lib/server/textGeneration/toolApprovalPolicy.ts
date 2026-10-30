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

/**
 * The approval policy and the tools already approved, as a turn sees them. A scheduled run in
 * `ask` mode has nobody to ask and no grant is an approval for it: policy is manual and nothing
 * is pre-approved, so every tool that needs approval is refused. In `allow` mode, and for any
 * other turn, they are what the person's own settings and the chat say.
 */
export function approvalStateFor(input: {
	scheduledRun?: { permissionMode: "ask" | "allow" };
	policy: "always-allow" | "manual";
	approvedTools: readonly string[];
}): { policy: "always-allow" | "manual"; approvedTools: Set<string> } {
	if (input.scheduledRun && input.scheduledRun.permissionMode !== "allow") {
		return { policy: "manual", approvedTools: new Set() };
	}
	return { policy: input.policy, approvedTools: new Set(input.approvedTools) };
}
