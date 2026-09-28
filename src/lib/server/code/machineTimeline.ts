/**
 * The one place the machine's normalized shapes become the panel's frames.
 *
 * The wire vocabulary (`$lib/types/machineProtocol.ts`) tells a part's role
 * directly (`Part.role`), so no status inference is needed to tell a
 * user echo from an assistant token — the mapping here is a pure function of
 * one part or event at a time. The one place that still needs a sliver of
 * caller-held state is turn-level failure: `status: "idle"` means "done"
 * unless the turn's last assistant message carries an `error`, and a live
 * `status` event does not itself repeat that message — callers (the SSE
 * bridge) track the one string and pass it in, per spec §8's "keep
 * per-connection state only where needed".
 *
 * `snapshotToUpdates` folds a whole `Transcript` (a `session.sync` snapshot,
 * or an offline read); `eventToUpdates` folds one live `NormalizedEvent`.
 * Both route through the same part/permission/todo mapping so a snapshot and
 * its later live tail render identically.
 */

import {
	MessageElicitationUpdateType,
	MessageToolUpdateType,
	MessageUpdateType,
	type MessageElicitationRequestUpdate,
	type MessageElicitationResolvedUpdate,
	type MessagePlanUpdate,
	type MessageToolCallUpdate,
	type MessageToolErrorUpdate,
	type MessageToolResultUpdate,
	type MessageTurnStateUpdate,
} from "$lib/types/MessageUpdate";
import type {
	AgentCompactionUpdate,
	AgentMessageBoundaryUpdate,
	AgentStreamUpdate,
	AgentUsageUpdate,
} from "$lib/types/CodeAgent";
import { ToolResultStatus, type ToolResult } from "$lib/types/Tool";
import type {
	Envelope,
	NormalizedEvent,
	Part,
	PermissionRequest,
	Question,
	SessionStatus,
	Todo,
	ToolAttachment,
	Transcript,
	Usage,
} from "$lib/types/machineProtocol";
import { usableAttachments, type ToolImageUrl } from "./toolImages";
import type { ElicitationField, ElicitationValue } from "$lib/types/McpElicitation";

let planVersion = 0;

/**
 * A subagent's envelope, as the parent's bridge sees it: which child asked,
 * and the title the approval/question card labels it with (from the session
 * list or a `session` event — null while unknown).
 */
export interface ChildContext {
	childId: string;
	childTitle?: string | null;
}

/** "Subagent ‹title›: " — or "Subagent: " while the title is unknown. */
function subagentLabel(child: ChildContext): string {
	const title = child.childTitle?.trim();
	return title ? `Subagent ${title}: ` : "Subagent: ";
}

function toolCallUpdate(
	callId: string,
	tool: string,
	input: Record<string, unknown>
): MessageToolCallUpdate {
	return {
		type: MessageUpdateType.Tool,
		subtype: MessageToolUpdateType.Call,
		uuid: callId,
		call: { name: tool, parameters: (input ?? {}) as Record<string, string | number | boolean> },
	};
}

function toolResultUpdate(
	callId: string,
	tool: string,
	input: Record<string, unknown>,
	output: string | undefined,
	attachments: ToolAttachment[] = [],
	imageUrl?: ToolImageUrl
): MessageToolResultUpdate {
	const outputs: Record<string, unknown>[] = output ? [{ text: output }] : [];
	// Images ride as URLs into the forwarder's attachment route, never as
	// bytes (PROTOCOL.md §7): a snapshot and the live stream share this map.
	const images = imageUrl ? usableAttachments(attachments) : [];
	if (imageUrl && images.length) {
		outputs.push({
			content: images.map((a) => ({ type: "image", mimeType: a.mime, url: imageUrl(a.sha256) })),
		});
	}
	const result: ToolResult = {
		status: ToolResultStatus.Success,
		call: { name: tool, parameters: (input ?? {}) as Record<string, string | number | boolean> },
		outputs,
		display: true,
	};
	return {
		type: MessageUpdateType.Tool,
		subtype: MessageToolUpdateType.Result,
		uuid: callId,
		result,
	};
}

function toolErrorUpdate(callId: string, message: string): MessageToolErrorUpdate {
	return {
		type: MessageUpdateType.Tool,
		subtype: MessageToolUpdateType.Error,
		uuid: callId,
		message,
	};
}

/** The machine's `Usage` (spec §6) → Cerea's own side-channel shape. The
 * mapping lives here, in one place, so an upstream field rename is a
 * one-line fix rather than a hunt through every caller. */
function usageToUpdate(usage: Usage): AgentUsageUpdate {
	return {
		type: "usage",
		usage: {
			used: usage.contextUsed,
			...(usage.contextMax != null ? { max: usage.contextMax } : {}),
			input: usage.input,
			output: usage.output,
			cacheRead: usage.cacheRead,
			reasoning: usage.reasoning,
		},
	};
}

/** One part → zero or more panel frames. A part upserts in place on the
 * wire (spec §7's text contract); folded here as its current, whole value —
 * a snapshot read and a live `part` event both call this the same way.
 * `clientMessageId` (the owning message's, when it is a user message) rides
 * onto the `user` frame — the key attachments will use once the attachment
 * store lands; the fold ignores it for now. So does the message's `command`
 * marker (PROTOCOL.md §7): the bubble renders "/name args" and folds the
 * expanded text beneath it. */
function partToUpdates(
	part: Part,
	clientMessageId?: string,
	command?: { name: string; arguments: string },
	imageUrl?: ToolImageUrl
): AgentStreamUpdate[] {
	switch (part.type) {
		case "text":
			if (part.synthetic) return [];
			if (!part.text) return [];
			return part.role === "user"
				? [
						{
							type: "user",
							text: part.text,
							...(clientMessageId ? { messageId: clientMessageId } : {}),
							...(command ? { command } : {}),
						},
					]
				: [{ type: MessageUpdateType.Stream, token: part.text }];
		case "tool": {
			const call = toolCallUpdate(part.callId, part.tool, part.input);
			if (part.status === "pending" || part.status === "running") return [call];
			if (part.status === "error")
				return [call, toolErrorUpdate(part.callId, part.error ?? "The call failed.")];
			return [
				call,
				toolResultUpdate(
					part.callId,
					part.tool,
					part.input,
					part.output,
					part.attachments,
					imageUrl
				),
			];
		}
		case "compaction": {
			const update: AgentCompactionUpdate = { type: "compaction", auto: part.auto };
			return [update];
		}
		// reasoning: no panel shape yet. file/subtask: the diff pane and the
		// polled subagent roster are the panel's surfaces for those, not the
		// transcript fold.
		default:
			return [];
	}
}

export function permissionRequestToUpdate(
	request: PermissionRequest,
	child?: ChildContext
): MessageElicitationRequestUpdate {
	return {
		type: MessageUpdateType.Elicitation,
		subtype: MessageElicitationUpdateType.Request,
		request: {
			elicitationId: request.id,
			server: request.tool,
			mode: "form",
			message: child ? `${subagentLabel(child)}${request.title}` : request.title,
			toolApproval: { tool: request.tool, args: request.metadata },
			...(child ? { childSessionId: child.childId, childTitle: child.childTitle ?? null } : {}),
		},
	};
}

export function permissionResolvedToUpdate(
	requestId: string,
	decision: string
): MessageElicitationResolvedUpdate {
	return {
		type: MessageUpdateType.Elicitation,
		subtype: MessageElicitationUpdateType.Resolved,
		elicitationId: requestId,
		action: decision === "reject" ? "decline" : "accept",
		resolution: "user",
	};
}

/** `question.asked` → the same elicitation mechanism, reusing chat's own
 * `ask_user_question` shape (the user-question tool design): each machine
 * `Question` normalizes to one `select` field — `AskQuestion.svelte` (the
 * card `source: "assistant"` already lifts to the composer for) walks
 * `fields` as a multi-step flow exactly as it does for chat's own tool.
 * `value` is the option's own label, not an index: opencode's reply body
 * wants the chosen labels back verbatim, and this is what
 * `AskQuestion.svelte`'s own submit already collects into `content[name]`. */
export function questionRequestedToUpdate(
	event: {
		requestId: string;
		questions: Question[];
	},
	child?: ChildContext
): MessageElicitationRequestUpdate {
	const fields: ElicitationField[] = event.questions.map((q, i) => ({
		kind: "select",
		name: `q${i}`,
		title: q.header,
		description: q.question,
		required: true,
		multiple: q.multiple ?? false,
		options: q.options.map((o) => ({ value: o.label, label: o.label, description: o.description })),
		// opencode tells the model the user can type their own answer unless
		// `custom` is off, so the card has to offer it; the typed text goes back
		// as the answer's label, which opencode relays to the model verbatim.
		allowOther: q.custom !== false,
	}));
	return {
		type: MessageUpdateType.Elicitation,
		subtype: MessageElicitationUpdateType.Request,
		request: {
			elicitationId: event.requestId,
			// Not an MCP server: the card names what was asked, never this.
			server: "agent",
			mode: "form",
			source: "assistant",
			message: child
				? `${subagentLabel(child)}${event.questions.map((q) => q.question).join("\n\n")}`
				: event.questions.map((q) => q.question).join("\n\n"),
			fields,
			...(child ? { childSessionId: child.childId, childTitle: child.childTitle ?? null } : {}),
		},
	};
}

/** `question.resolved` closes that card. `answers` is carried into `content`
 * keyed the same way questionRequestedToUpdate named its fields (`q0`,
 * `q1`, …), so a reloaded transcript still shows what was chosen — the
 * same purpose `content` already serves for chat's own `ask_user_question`. */
export function questionResolvedToUpdate(event: {
	requestId: string;
	answers?: string[][];
	rejected?: true;
}): MessageElicitationResolvedUpdate {
	const content: Record<string, ElicitationValue> = {};
	event.answers?.forEach((answer, i) => (content[`q${i}`] = answer));
	return {
		type: MessageUpdateType.Elicitation,
		subtype: MessageElicitationUpdateType.Resolved,
		elicitationId: event.requestId,
		action: event.rejected ? "decline" : "accept",
		resolution: "user",
		...(event.answers ? { content } : {}),
	};
}

function todoToUpdate(todos: Todo[]): MessagePlanUpdate {
	planVersion += 1;
	return {
		type: MessageUpdateType.Plan,
		uuid: `agent-plan-${planVersion}`,
		goal: todos[0]?.content ?? "",
		version: planVersion,
		steps: todos.map((todo) => ({
			step: todo.content,
			status:
				todo.status === "completed"
					? "completed"
					: todo.status === "in_progress"
						? "in_progress"
						: "pending",
		})),
	};
}

function turnStateUpdate(
	state: MessageTurnStateUpdate["state"],
	reason?: string
): MessageTurnStateUpdate {
	return {
		type: MessageUpdateType.TurnState,
		state,
		serverNow: Date.now(),
		...(reason ? { reason } : {}),
	};
}

/** `status` → turn state (spec §8): `busy`/`retry` are running, `idle` is
 * done unless the turn's last assistant message carries an error — that one
 * bit of context the caller supplies, since a bare `status` event does not
 * repeat it. */
function statusToTurnState(
	status: SessionStatus,
	lastAssistantError: string | undefined,
	detail?: string
): MessageTurnStateUpdate {
	switch (status) {
		case "busy":
		case "retry":
			return turnStateUpdate("running", detail);
		case "error":
			return turnStateUpdate("failed", detail ?? lastAssistantError);
		default:
			return turnStateUpdate(lastAssistantError ? "failed" : "done", lastAssistantError);
	}
}

/** One live normalized event → zero or more panel frames. `lastAssistantError`
 * is the bridge's own tiny bit of tracked state (spec §8), consulted only for
 * a `status: "idle"` event. `resolveClientMessageId` is the same idea for a
 * user part's owning message — a `part` event carries only `messageId`, not
 * the message's `clientMessageId`, so the caller (which has already seen the
 * `message` event that named it) supplies the lookup.
 *
 * `child` marks an envelope that belongs to a subagent of the watched
 * session rather than the session itself: its approvals and questions
 * become the same labelled cards the parent renders (carrying the child's
 * session id, so the reply routes to the child's request), while
 * everything else — tokens, tool calls, turn states — stays out of the
 * parent's transcript and surfaces only as a `childActivity` side-channel
 * cue for the subagent card to re-sync on. */
export function eventToUpdates(
	event: NormalizedEvent,
	lastAssistantError?: string,
	resolveClientMessageId?: (messageId: string) => string | undefined,
	child?: ChildContext,
	resolveCommand?: (messageId: string) => { name: string; arguments: string } | undefined,
	imageUrl?: ToolImageUrl
): AgentStreamUpdate[] {
	if (child) {
		switch (event.kind) {
			case "permission.asked":
				return [permissionRequestToUpdate(event.request, child)];
			case "permission.replied":
				return [permissionResolvedToUpdate(event.requestId, event.decision)];
			case "question.asked":
				return [
					questionRequestedToUpdate(
						{
							requestId: event.request.id,
							questions: event.request.questions,
						},
						child
					),
				];
			case "question.resolved":
				return [
					questionResolvedToUpdate({
						requestId: event.requestId,
						answers: event.answers,
						rejected: event.rejected,
					}),
				];
			default:
				return [{ type: "childActivity", childId: child.childId }];
		}
	}
	switch (event.kind) {
		case "message": {
			// A pure boundary marker (see `AgentMessageBoundaryUpdate`): the
			// message's own text/tool content still arrives as `part` events on
			// the same message, this only names it.
			const boundary: AgentMessageBoundaryUpdate = {
				type: "messageBoundary",
				role: event.message.role,
				messageId: event.message.id,
			};
			return [boundary];
		}
		case "part":
			return partToUpdates(
				event.part,
				event.part.role === "user" ? resolveClientMessageId?.(event.part.messageId) : undefined,
				event.part.role === "user" ? resolveCommand?.(event.part.messageId) : undefined,
				imageUrl
			);
		case "delta":
			return event.field === "text" ? [{ type: MessageUpdateType.Stream, token: event.delta }] : [];
		case "part.removed":
			return [];
		case "status":
			return [statusToTurnState(event.status, lastAssistantError, event.detail)];
		case "permission.asked":
			return [permissionRequestToUpdate(event.request)];
		case "permission.replied":
			return [permissionResolvedToUpdate(event.requestId, event.decision)];
		case "usage":
			return [usageToUpdate(event.usage)];
		case "session":
			return []; // metadata changed; the panel re-reads via its own poll.
		case "error":
			return [turnStateUpdate("failed", event.message)];
		case "todo":
			return [todoToUpdate(event.todos)];
		case "question.asked":
			return [
				questionRequestedToUpdate({
					requestId: event.request.id,
					questions: event.request.questions,
				}),
			];
		case "question.resolved":
			return [
				questionResolvedToUpdate({
					requestId: event.requestId,
					answers: event.answers,
					rejected: event.rejected,
				}),
			];
		default:
			return [];
	}
}

/** opencode's own `question` tool result reads
 * `User has answered your questions: "<q1>"="<a, b>", "<q2>"="<c>". You can now…`,
 * answers joined with ", " and "Unanswered" for none. Split back into per-question
 * label lists, using the options to re-split a multi-pick (a label may itself hold
 * ", "); whatever is left over is the text the user typed. Null when the text is
 * not that shape, so a changed upstream wording degrades to no summary. */
export function answersFromQuestionOutput(
	questions: Question[],
	output: string | undefined
): string[][] | null {
	if (!output || questions.length === 0) return null;
	const answers: string[][] = [];
	let cursor = 0;
	for (let i = 0; i < questions.length; i++) {
		const opener = `"${questions[i].question}"="`;
		const start = output.indexOf(opener, cursor);
		if (start < 0) return null;
		const from = start + opener.length;
		const next = questions[i + 1];
		const end = next
			? output.indexOf(`", "${next.question}"="`, from)
			: output.lastIndexOf(`". You can now`);
		if (end < from) return null;
		const joined = output.slice(from, end);
		cursor = end;
		if (joined === "Unanswered") {
			answers.push([]);
			continue;
		}
		if (!questions[i].multiple) {
			answers.push([joined]);
			continue;
		}
		const labels = new Set(questions[i].options.map((o) => o.label));
		const picked: string[] = [];
		let pending: string[] = [];
		for (const piece of joined.split(", ")) {
			pending.push(piece);
			const candidate = pending.join(", ");
			if (labels.has(candidate)) {
				picked.push(candidate);
				pending = [];
			}
		}
		if (pending.length) picked.push(pending.join(", "));
		answers.push(picked);
	}
	return answers;
}

/** A completed `question` tool part, as a reload finds it: the live card came
 * from `question.asked`/`question.resolved`, which a snapshot does not replay,
 * so rebuild the answered card from the call's own input and result. Keyed by
 * the call id — the live card's opencode request id is not on the part — which
 * cannot collide with a live card because a snapshot only precedes live events
 * that come after the question was already answered. */
function answeredQuestionFromPart(part: Part): AgentStreamUpdate[] {
	if (part.type !== "tool" || part.tool !== "question" || part.status !== "completed") return [];
	const questions = Array.isArray(part.input?.questions)
		? (part.input.questions as Question[])
		: [];
	const answers = answersFromQuestionOutput(questions, part.output);
	if (!answers) return [];
	const requestId = `question-call:${part.callId}`;
	return [
		questionRequestedToUpdate({ requestId, questions }),
		questionResolvedToUpdate({ requestId, answers }),
	];
}

/** A whole snapshot (`session.sync`'s `Transcript`, or an offline read) →
 * the panel frames a fresh mount replays. */
export function snapshotToUpdates(
	transcript: Transcript,
	imageUrl?: ToolImageUrl
): AgentStreamUpdate[] {
	const updates: AgentStreamUpdate[] = [];
	let lastAssistantError: string | undefined;
	// The protocol types these lists as arrays, but a machine that omits an
	// empty one (Go's nil slices) must degrade to "nothing", not a 500.
	for (const { message, parts } of transcript.messages ?? []) {
		const clientMessageId = message.role === "user" ? message.clientMessageId : undefined;
		const command = message.role === "user" ? message.command : undefined;
		updates.push({ type: "messageBoundary", role: message.role, messageId: message.id });
		for (const part of parts ?? []) {
			updates.push(
				...partToUpdates(part, clientMessageId, command, imageUrl),
				...answeredQuestionFromPart(part)
			);
		}
		if (message.role === "assistant") lastAssistantError = message.error;
	}
	for (const permission of transcript.permissions ?? []) {
		updates.push(permissionRequestToUpdate(permission));
	}
	// The turn may be waiting on a question: a snapshot does not replay
	// question.asked, so offer the ask again from the machine's pending list.
	for (const question of transcript.questions ?? []) {
		updates.push(
			questionRequestedToUpdate({ requestId: question.id, questions: question.questions })
		);
	}
	const todos = transcript.todos ?? [];
	if (todos.length) updates.push(todoToUpdate(todos));
	updates.push(statusToTurnState(transcript.status, lastAssistantError));
	// After history, never before it: a fresh mount's first paint should show
	// the transcript before the meter, same order a live turn would deliver
	// them in (the usage event trails the turn's own parts).
	if (transcript.usage) updates.push(usageToUpdate(transcript.usage));
	return updates;
}

/** The trailing assistant message's error, if any — what a caller holding a
 * live connection open past this snapshot should seed its own tracked
 * `lastAssistantError` with (spec §8), so a `status: "idle"` event arriving
 * later without a fresh `message` event still maps to the right terminal
 * state. */
export function lastAssistantErrorOf(transcript: Transcript): string | undefined {
	let lastAssistantError: string | undefined;
	for (const { message } of transcript.messages ?? []) {
		if (message.role === "assistant") lastAssistantError = message.error;
	}
	return lastAssistantError;
}

/** Every user message's `clientMessageId`, by message id — what a caller
 * holding a live connection open past this snapshot should seed its own
 * tracked lookup with, so a `part` event arriving later for a message this
 * snapshot already carried still resolves its `clientMessageId` (a `part`
 * event names only `messageId`, never the owning message's own fields). */
export function userMessageIdsOf(transcript: Transcript): Map<string, string> {
	const ids = new Map<string, string>();
	for (const { message } of transcript.messages ?? []) {
		if (message.role === "user" && message.clientMessageId) {
			ids.set(message.id, message.clientMessageId);
		}
	}
	return ids;
}

/** The snapshot's command markers, by message id — the seed for the same
 * live lookup `eventToUpdates` threads into user frames (PROTOCOL.md §7):
 * a marker rides the message, the panel's bubble renders from it. */
export function commandMarkersOf(
	transcript: Transcript
): Map<string, { name: string; arguments: string }> {
	const markers = new Map<string, { name: string; arguments: string }>();
	for (const { message } of transcript.messages ?? []) {
		if (message.role === "user" && message.command) {
			markers.set(message.id, message.command);
		}
	}
	return markers;
}

/** A replayed run of envelopes (`session.sync`'s `events` branch, when the
 * machine's ring buffer still holds the gap) → panel frames, threading
 * `lastAssistantError` and the user-message-id lookup across them the same
 * way a live tail would. Returns both tracked values too, so the caller can
 * keep tracking them for whatever arrives after.
 *
 * `childOf` names the subagent context for envelopes that belong to a
 * descendant of the watched session (matched on the envelope's own
 * session id): their approvals/questions fold as labelled cards and their
 * content folds to `childActivity`, never touching the parent's tracked
 * turn state. */
export function foldEnvelopeEvents(
	envelopes: Envelope[],
	initialLastAssistantError?: string,
	initialUserMessageIds?: Map<string, string>,
	childOf?: (sessionId: string) => ChildContext | undefined,
	initialCommandMarkers?: Map<string, { name: string; arguments: string }>,
	imageUrl?: ToolImageUrl
): {
	updates: AgentStreamUpdate[];
	lastAssistantError: string | undefined;
	userMessageIds: Map<string, string>;
	commandMarkers: Map<string, { name: string; arguments: string }>;
} {
	let lastAssistantError = initialLastAssistantError;
	const userMessageIds = new Map(initialUserMessageIds ?? []);
	const commandMarkers = new Map(initialCommandMarkers ?? []);
	const updates: AgentStreamUpdate[] = [];
	for (const { sessionId, event } of envelopes) {
		const child = childOf?.(sessionId);
		if (!child && event.kind === "message") {
			if (event.message.role === "assistant") {
				lastAssistantError = event.message.error;
			} else if (event.message.clientMessageId) {
				userMessageIds.set(event.message.id, event.message.clientMessageId);
			}
			if (event.message.role === "user" && event.message.command) {
				commandMarkers.set(event.message.id, event.message.command);
			}
		}
		updates.push(
			...eventToUpdates(
				event,
				lastAssistantError,
				(messageId) => userMessageIds.get(messageId),
				child,
				(messageId) => commandMarkers.get(messageId),
				imageUrl
			)
		);
	}
	return { updates, lastAssistantError, userMessageIds, commandMarkers };
}

/** A frame's identity for seam de-duplication (the SSE bridge, spec §8):
 * the same item never twice, keyed by wire identity rather than content
 * (R4's fix — a token equal to an earlier one, or a repeated user message
 * like "yes", must never be dropped). */
export function frameKey(update: AgentStreamUpdate): string | null {
	switch (update.type) {
		case MessageUpdateType.Tool:
			return `t:${update.uuid}:${update.subtype}`;
		case MessageUpdateType.Elicitation:
			return update.subtype === MessageElicitationUpdateType.Request
				? `q:${update.request.elicitationId}`
				: `r:${update.elicitationId}`;
		default:
			// Stream tokens, user echoes, plan snapshots and turn states are
			// never de-duplicated by content — identity for those is the
			// envelope's (epoch, seq), which the bridge's cursor already
			// guarantees delivers each exactly once.
			return null;
	}
}
