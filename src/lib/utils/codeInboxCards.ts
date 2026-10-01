import { base } from "$app/paths";
import type { ElicitationField, ElicitationRequestPayload } from "$lib/types/McpElicitation";
import type { PermissionRequest, Question } from "$lib/types/machineProtocol";

/**
 * The Needs-you inbox's card payloads — the client-safe half of
 * `$lib/server/code/machineTimeline.ts`'s own mapping.
 *
 * The SAME card components the agent transcript uses (`ToolApprovalCard`
 * for a permission, `AskQuestion` for a question) render from
 * `ElicitationRequestPayload`; the inbox builds that payload with these
 * functions, and `machineTimeline`'s `permissionRequestToUpdate` /
 * `questionRequestedToUpdate` delegate to them, so one definition serves
 * both the stream and the inbox. If the card's shape ever changes, change
 * it here — never in only one of the two callers.
 */

/** Which child asked, when the ask belongs to a subagent of the watched session. */
export interface InboxChildContext {
	childId: string;
	childTitle?: string | null;
}

/** "Subagent ‹title›: " — or "Subagent: " while the title is unknown. */
function subagentLabel(child: InboxChildContext): string {
	const title = child.childTitle?.trim();
	return title ? `Subagent ${title}: ` : "Subagent: ";
}

/**
 * A waiting tool approval → the approval card's request. Mirrors
 * `machineTimeline.permissionRequestToUpdate`'s `request` exactly: the
 * card reads `toolApproval.tool`/`args` (galopin approvals carry the whole
 * prompt/message there), and a subagent's ask carries the child session the
 * reply must reach.
 */
export function permissionToElicitation(
	request: PermissionRequest,
	child?: InboxChildContext
): ElicitationRequestPayload {
	return {
		elicitationId: request.id,
		server: request.tool,
		mode: "form",
		message: child ? `${subagentLabel(child)}${request.title}` : request.title,
		toolApproval: { tool: request.tool, args: request.metadata },
		...(child ? { childSessionId: child.childId, childTitle: child.childTitle ?? null } : {}),
	};
}

/**
 * A waiting question-tool ask → the question card's request. Mirrors
 * `machineTimeline.questionRequestedToUpdate`'s `request` exactly: each
 * machine `Question` is one `select` field named `q<i>`, `value` is the
 * option's own label (opencode's reply body wants the chosen labels back
 * verbatim), and a typed answer is offered unless the ask opts out.
 */
export function questionToElicitation(
	requestId: string,
	questions: Question[],
	child?: InboxChildContext
): ElicitationRequestPayload {
	const fields: ElicitationField[] = questions.map((q, i) => ({
		kind: "select",
		name: `q${i}`,
		title: q.header,
		description: q.question,
		required: true,
		multiple: q.multiple ?? false,
		options: q.options.map((o) => ({ value: o.label, label: o.label, description: o.description })),
		allowOther: q.custom !== false,
	}));
	return {
		elicitationId: requestId,
		server: "agent",
		mode: "form",
		source: "assistant",
		message: child
			? `${subagentLabel(child)}${questions.map((q) => q.question).join("\n\n")}`
			: questions.map((q) => q.question).join("\n\n"),
		fields,
		...(child ? { childSessionId: child.childId, childTitle: child.childTitle ?? null } : {}),
	};
}

/** Deep-link to the agent card that owns an ask: the address `CodePanel` remounts on. */
export function inboxAgentHref(deviceId: string, workspaceId: string, sessionId: string): string {
	return `${base}/code?device=${encodeURIComponent(deviceId)}&ws=${encodeURIComponent(workspaceId)}&agent=${encodeURIComponent(sessionId)}`;
}
