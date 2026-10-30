import { z } from "zod";
import type { ObjectId } from "mongodb";
import { collections } from "$lib/server/database";
import { isValidTimezone, validateRecurrence } from "$lib/server/schedules/recurrence";
import { runStamp } from "$lib/server/schedules/runHeader";
import {
	createSchedule,
	MAX_NAME_LENGTH,
	MAX_OCCURRENCES,
	MAX_PROMPT_LENGTH,
	ScheduleError,
} from "$lib/server/schedules/store";
import { authTimeFresh } from "$lib/server/code/stepUp";
import { userApprovalPolicy } from "$lib/server/schedules/permission";
import { schedulesEnabled } from "$lib/server/schedules/limits";
import type { Recurrence } from "$lib/types/Schedule";
import { recurrenceText } from "$lib/utils/scheduleFormat";
import type { BuiltinTool } from "./types";

/**
 * `schedule`: the assistant proposes a scheduled action for the conversation the
 * person is in ("remind me every Friday to…"). A call never creates anything by
 * itself: it opens the approval card (`toolInvocation.ts` gates it whatever the
 * person's approval policy is, and a grant for the conversation never covers it),
 * and only the person's click runs `createScheduleFromApproval`
 * (`mcp/resumeElicitation.ts`). `execute` is therefore reached only by a call that
 * was not valid, and says why; or, should the gate ever be bypassed, refuses.
 */
export const SCHEDULE_TOOL_NAME = "schedule";

/** What the assistant may make on a person's behalf: a confirmed click is not a licence to fill their list. */
export const MAX_ACTIVE_PER_CONVERSATION = 3;
export const MAX_ASSISTANT_SCHEDULES_PER_HOUR = 10;

const inputSchema = z.object({
	name: z.string().trim().min(1).max(MAX_NAME_LENGTH),
	prompt: z.string().trim().min(1).max(MAX_PROMPT_LENGTH),
	mode: z.enum(["continue", "new"]).default("continue"),
	permissionMode: z.enum(["ask", "allow"]).default("ask"),
	recurrence: z.unknown(),
	timezone: z.string().trim().optional(),
	maxOccurrences: z.number().int().min(1).max(MAX_OCCURRENCES).nullish(),
});

export interface ScheduleProposal {
	name: string;
	prompt: string;
	mode: "continue" | "new";
	/** What a run may do about tools that need approval; never looser than the conversation's policy. */
	permissionMode: "ask" | "allow";
	recurrence: Recurrence;
	timezone: string;
	maxOccurrences?: number;
}

export function parseScheduleToolArgs(
	args: Record<string, unknown> | null,
	defaults: { timezone?: string }
): { ok: true; value: ScheduleProposal } | { ok: false; error: string } {
	const parsed = inputSchema.safeParse(args ?? {});
	if (!parsed.success) {
		return {
			ok: false,
			error:
				"A schedule needs a name, the prompt to send, and a recurrence. " +
				`The name is at most ${MAX_NAME_LENGTH} characters and the prompt at most ${MAX_PROMPT_LENGTH}.`,
		};
	}
	const input = parsed.data;
	const timezone = input.timezone || defaults.timezone || "UTC";
	if (!isValidTimezone(timezone)) {
		return { ok: false, error: "That is not a known IANA timezone (for example Europe/Rome)." };
	}
	const recurrence = validateRecurrence(input.recurrence, timezone);
	if (!recurrence.ok) return { ok: false, error: recurrence.error };
	return {
		ok: true,
		value: {
			name: input.name,
			prompt: input.prompt,
			mode: input.mode,
			permissionMode: input.permissionMode,
			recurrence: recurrence.recurrence,
			timezone,
			...(input.maxOccurrences != null ? { maxOccurrences: input.maxOccurrences } : {}),
		},
	};
}

export function createScheduleTool(defaults: { timezone?: string }): BuiltinTool {
	return {
		name: SCHEDULE_TOOL_NAME,
		exemptFromToolRestraint: true,
		definition: {
			type: "function",
			function: {
				name: SCHEDULE_TOOL_NAME,
				description:
					"Propose a scheduled action: the person's prompt sent again on a timetable, " +
					"for example 'every Friday at 16:00 remind me to send the report'. The person sees " +
					"the proposal on a card and the schedule exists only if they confirm it, so call " +
					"it when they ask for something recurring, not to suggest one. The run is unattended: " +
					"it can use web search, fetching and documents, but no Python sandbox, and any tool " +
					"that needs approval is refused. Write `prompt` as the instruction to carry out at " +
					"each run, self-contained. It posts into this conversation by default (`mode: " +
					"continue`); `mode: new` starts a new conversation each run.",
				parameters: {
					type: "object",
					properties: {
						name: { type: "string", description: "A short name, shown in the schedules list." },
						prompt: { type: "string", description: "What to send at each run." },
						mode: {
							type: "string",
							enum: ["continue", "new"],
							description:
								"continue: post into this conversation (default). new: a new conversation each run.",
						},
						permissionMode: {
							type: "string",
							enum: ["ask", "allow"],
							description:
								"ask (default): a scheduled run refuses every tool that needs approval. allow: such tools " +
								"run as they would for the person, only if their approval setting is always allow.",
						},
						recurrence: {
							type: "object",
							description:
								"When it runs. One of: {type:'daily', at:'09:00'}, {type:'weekdays', at:'09:00'}, " +
								"{type:'weekly', day:0-6 (0 is Sunday), at:'16:00'}, {type:'hours', every:N}, " +
								"{type:'cron', expr:'0 9 * * 1-5'}. No faster than every 15 minutes.",
						},
						timezone: {
							type: "string",
							description:
								"The IANA timezone the times are in: the person's, from the current-time line.",
						},
						maxOccurrences: {
							type: "integer",
							description:
								"Stop after this many runs (for example 1 for a one-time reminder). Omit to repeat.",
						},
					},
					required: ["name", "prompt", "recurrence", "timezone"],
				},
			},
		},
		async execute(args) {
			const parsed = parseScheduleToolArgs(args, defaults);
			if (!parsed.ok) return { error: parsed.error };
			// A valid proposal is answered by the card, never here.
			return {
				error: "A schedule is created only when the person confirms it on the approval card.",
			};
		},
	};
}

/**
 * The person confirmed the card: make the schedule, as them, from the conversation
 * it was proposed in. Returns the text the model reads next, or why it could not.
 */
export async function createScheduleFromApproval(input: {
	args: Record<string, unknown>;
	conversationId: ObjectId;
	userId: ObjectId | undefined;
	/** The approving person's own session token: the key a chat schedule runs with is made with it. */
	token: string | undefined;
}): Promise<{ text: string } | { error: string }> {
	if (!input.userId) return { error: "Scheduling needs a signed-in account." };
	// The same gates as the schedules API: the switch, and a sign-in within the 7-day window.
	if (!schedulesEnabled()) return { error: "Scheduled actions are switched off here." };
	const session = await collections.sessions
		.find({ userId: input.userId })
		.sort({ updatedAt: -1 })
		.next();
	if (!authTimeFresh(session?.authTime)) {
		return {
			error:
				"The person's sign-in is older than 7 days: they need to sign in again before a schedule can be made.",
		};
	}
	const proposal = parseScheduleToolArgs(input.args, {});
	if (!proposal.ok) return { error: proposal.error };
	const { value } = proposal;
	const conversation = await collections.conversations.findOne(
		{ _id: input.conversationId, userId: input.userId },
		{ projection: { title: 1, toolApprovalOverride: 1 } }
	);
	if (!conversation) return { error: "The conversation this was proposed in is gone." };

	// Never looser than the person's setting, nor than this conversation's own policy.
	const userPolicy = await userApprovalPolicy(input.userId);
	const conversationPolicy = conversation.toolApprovalOverride ?? userPolicy;
	const permissionMode =
		value.permissionMode === "allow" &&
		userPolicy === "always-allow" &&
		conversationPolicy === "always-allow"
			? "allow"
			: "ask";
	const active = await collections.schedules.countDocuments({
		userId: input.userId,
		enabled: true,
		"createdBy.kind": "chat",
		"createdBy.conversationId": input.conversationId.toString(),
	});
	if (active >= MAX_ACTIVE_PER_CONVERSATION) {
		return {
			error: `This conversation already has ${MAX_ACTIVE_PER_CONVERSATION} running schedules made by the assistant. Ask the person to delete or switch one off under Schedules first.`,
		};
	}
	const lately = await collections.schedules.countDocuments({
		userId: input.userId,
		"createdBy.kind": "chat",
		createdAt: { $gte: new Date(Date.now() - 3600_000) },
	});
	if (lately >= MAX_ASSISTANT_SCHEDULES_PER_HOUR) {
		return { error: "The assistant has made many schedules in the last hour. Try again later." };
	}
	try {
		const schedule = await createSchedule(
			input.userId,
			{
				name: value.name,
				kind: "chat",
				prompt: value.prompt,
				recurrence: value.recurrence,
				timezone: value.timezone,
				target: {
					mode: value.mode,
					conversationId: input.conversationId.toString(),
					permissionMode,
				},
				...(value.maxOccurrences !== undefined ? { maxOccurrences: value.maxOccurrences } : {}),
			},
			{
				createdBy: {
					kind: "chat",
					conversationId: input.conversationId.toString(),
					title: conversation.title,
				},
				token: input.token,
			}
		);
		const next = schedule.nextRunAt ? runStamp(schedule.nextRunAt, schedule.timezone) : null;
		return {
			text:
				`The person confirmed. Created the schedule "${schedule.name}": ` +
				`${recurrenceText(schedule.recurrence).toLowerCase()} (${schedule.timezone})` +
				`${next ? `, first run ${next}` : ""}. ` +
				"They can change, switch off or delete it under Schedules.",
		};
	} catch (err) {
		if (err instanceof ScheduleError) return { error: err.message };
		throw err;
	}
}
