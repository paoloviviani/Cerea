import { MessageUpdateType } from "$lib/types/MessageUpdate";
import {
	forgetFact,
	MemoryValidationError,
	MEMORY_TEXT_MAX_CHARS,
	rememberFact,
} from "$lib/server/memory/service";
import type { BuiltinTool } from "./types";

export const REMEMBER_TOOL_NAME = "remember";
export const FORGET_TOOL_NAME = "forget";

/**
 * Writing and unwriting the standing facts about a person (see
 * `$lib/types/Memory` for why memory is a short list rather than a store to
 * search).
 *
 * ## Why two tools rather than one with a mode
 *
 * A single `memory(action, text)` reads to a model as one capability with a
 * switch, and models flip switches. Two named verbs make forgetting a
 * deliberate choice of tool, which is the behaviour worth biasing toward
 * when one branch deletes something the person may not be able to
 * reconstruct. It is also what LibreChat settled on, for what that is worth.
 *
 * ## Why these are not behind the approval gate
 *
 * Gating (ADR 0075) exists for calls with external reach or cost, and a
 * memory write has neither: it touches one document in this app's own
 * database, on behalf of the person who owns it. An approval card per
 * remembered fact would be the most frequent interruption in the product and
 * would teach people to dismiss approval cards without reading them —
 * degrading the gate where it actually matters. The safeguard here is
 * different and, for this operation, better: the write is **shown** in the
 * transcript as it happens, and can be undone from there in one click.
 *
 * ## The prompt guidance does most of the work
 *
 * Nothing stops a model from remembering something silly. The doctrine below
 * is the real control, and it is deliberately conservative: durable facts
 * only, nothing transient, nothing about third parties, nothing secret. A
 * store that fills with "the user is currently debugging a Postgres error"
 * is worse than an empty one, because every later turn carries it.
 */
const DOCTRINE =
	"MEMORY: You can keep a short list of standing facts about the person you are talking to, " +
	`carried into every future conversation. Call ${REMEMBER_TOOL_NAME} when they ask you to ` +
	"remember something, or when they state something durable about themselves that would change " +
	"how you answer them months from now — how they want to be addressed, a language or format " +
	"preference, their role, a long-running project, a standing constraint. " +
	`Call ${FORGET_TOOL_NAME} when they ask you to forget something, or when they tell you a ` +
	"remembered fact is now wrong.\n" +
	"Do not remember: anything that is only true today (what they are debugging right now, what " +
	"a file currently contains), anything already obvious from the conversation you are in, " +
	"facts about other people, or credentials, keys and other secrets — a secret in memory is a " +
	"secret in every future prompt. Do not remember something just because it was interesting. " +
	"When in doubt, do not: the person can add a memory themselves, and an unremembered fact " +
	"costs far less than a wrong one repeated forever.\n" +
	"Write one self-contained sentence, in the third person, that will still make sense with no " +
	'surrounding context: "Prefers replies in Italian", not "yes, do that from now on". Never ' +
	"announce that you are about to use these tools, and do not repeat the saved fact back — the " +
	"person is shown the change as it happens.";

/**
 * The tools, or none at all.
 *
 * `enabled` is resolved by the caller (runMcpFlow) from the deployment flag
 * and the person's own setting, because it needs a database read and
 * `getEnabledBuiltinTools` is deliberately synchronous — the same division
 * `searchModelIds` and `playwrightReachable` already follow. Returning an
 * empty array rather than throwing keeps the "a tool withholds itself" shape
 * every other builtin here uses.
 */
export function createMemoryBuiltins(params: { enabled: boolean }): BuiltinTool[] {
	if (!params.enabled) return [];

	const remember: BuiltinTool = {
		name: REMEMBER_TOOL_NAME,
		definition: {
			type: "function" as const,
			function: {
				name: REMEMBER_TOOL_NAME,
				description:
					"Store one standing fact about the person you are talking to, so it is available " +
					"in every future conversation. Use it for things that stay true, not for the state " +
					"of the current task.",
				parameters: {
					type: "object",
					properties: {
						fact: {
							type: "string",
							maxLength: MEMORY_TEXT_MAX_CHARS,
							description:
								"One self-contained sentence in the third person, understandable with no " +
								'surrounding context. For example: "Works on the Pystino gateway at LINKS ' +
								'Foundation" or "Prefers concise answers with no preamble".',
						},
					},
					required: ["fact"],
				},
			},
		},
		preprompt: DOCTRINE,

		async execute(args, ctx) {
			if (!ctx.userId) {
				// Anonymous sessions have nowhere durable to write; say so plainly
				// rather than failing in a way the model reads as "try again".
				return { error: "Memory is only available to a signed-in person. Continue without it." };
			}
			try {
				const { memory, created } = await rememberFact({
					userId: ctx.userId,
					text: String(args.fact ?? ""),
					source: "model",
					...(ctx.conversationId ? { conversationId: ctx.conversationId } : {}),
				});
				return {
					// A no-op is reported as one. Told "Remembered" for something it
					// already knew, a model tends to announce a save that did not
					// happen, and on the next turn tends to save it again.
					resultText: created
						? `Remembered: ${memory.text}`
						: `Already in memory, nothing changed: ${memory.text}`,
					extraUpdates: created
						? [
								{
									type: MessageUpdateType.Memory as const,
									uuid: ctx.uuid,
									action: "remembered" as const,
									text: memory.text,
									memoryId: memory._id.toString(),
								},
							]
						: [],
				};
			} catch (err) {
				if (err instanceof MemoryValidationError) return { error: err.message };
				throw err;
			}
		},
	};

	const forget: BuiltinTool = {
		name: FORGET_TOOL_NAME,
		definition: {
			type: "function" as const,
			function: {
				name: FORGET_TOOL_NAME,
				description:
					"Remove one standing fact from memory. Use it when the person asks you to forget " +
					"something, or when a remembered fact has become wrong.",
				parameters: {
					type: "object",
					properties: {
						fact: {
							type: "string",
							maxLength: MEMORY_TEXT_MAX_CHARS,
							description:
								"The fact to remove, repeated as closely as you can to how it appears in " +
								"the memory list you were given. If more than one matches you will be " +
								"told, and can retry with the exact wording.",
						},
					},
					required: ["fact"],
				},
			},
		},

		async execute(args, ctx) {
			if (!ctx.userId) {
				return { error: "Memory is only available to a signed-in person. Continue without it." };
			}
			try {
				const removed = await forgetFact({ userId: ctx.userId, text: String(args.fact ?? "") });
				return {
					resultText: `Forgotten: ${removed.text}`,
					extraUpdates: [
						{
							type: MessageUpdateType.Memory as const,
							uuid: ctx.uuid,
							action: "forgot" as const,
							text: removed.text,
						},
					],
				};
			} catch (err) {
				// Every failure here is a mismatch the model can fix by retrying
				// with better wording, and `forgetFact` puts the real list in the
				// message for exactly that. None of them is a server fault.
				if (err instanceof MemoryValidationError) return { error: err.message };
				throw err;
			}
		},
	};

	return [remember, forget];
}
