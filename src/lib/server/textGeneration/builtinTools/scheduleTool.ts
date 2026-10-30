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

const inputSchema = z.object({
	name: z.string().trim().min(1).max(MAX_NAME_LENGTH),
	prompt: z.string().trim().min(1).max(MAX_PROMPT_LENGTH),
	mode: z.enum(["continue", "new"]).default("continue"),
	recurrence: z.unknown(),
	timezone: z.string().trim().optional(),
	maxOccurrences: z.number().int().min(1).max(MAX_OCCURRENCES).nullish(),
});

export interface ScheduleProposal {
	name: string;
	prompt: string;
	mode: "continue" | "new";
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
	const proposal = parseScheduleToolArgs(input.args, {});
	if (!proposal.ok) return { error: proposal.error };
	const { value } = proposal;
	const conversation = await collections.conversations.findOne(
		{ _id: input.conversationId, userId: input.userId },
		{ projection: { title: 1 } }
	);
	if (!conversation) return { error: "The conversation this was proposed in is gone." };

	try {
		const schedule = await createSchedule(
			input.userId,
			{
				name: value.name,
				kind: "chat",
				prompt: value.prompt,
				recurrence: value.recurrence,
				timezone: value.timezone,
				target: { mode: value.mode, conversationId: input.conversationId.toString() },
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
