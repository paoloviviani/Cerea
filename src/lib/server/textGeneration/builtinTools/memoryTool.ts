import { MessageUpdateType } from "$lib/types/MessageUpdate";
import type { ObjectId } from "mongodb";
import {
	forgetFact,
	forgetForProject,
	MemoryValidationError,
	MEMORY_TEXT_MAX_CHARS,
	PROJECT_MEMORY_TEXT_MAX_CHARS,
	rememberFact,
	rememberForProject,
} from "$lib/server/memory/service";
import type { BuiltinTool } from "./types";

export const REMEMBER_TOOL_NAME = "remember";
export const FORGET_TOOL_NAME = "forget";
export const REMEMBER_FOR_PROJECT_TOOL_NAME = "remember_for_project";
export const FORGET_FOR_PROJECT_TOOL_NAME = "forget_for_project";

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
 * Doctrine for the project pair. Shorter than the personal one because the
 * rules it shares (nothing transient, nothing secret, one self-contained
 * sentence) are already stated there when both are offered; what it adds is
 * the one thing a model gets wrong between the two lists — which one a fact
 * belongs in — and the fact that the note is read by other people.
 */
const PROJECT_DOCTRINE =
	"PROJECT MEMORY: This conversation belongs to a project, which keeps a shared list of notes " +
	"read by every member in every conversation in it. Call " +
	`${REMEMBER_FOR_PROJECT_TOOL_NAME} when they ask you to remember something for the project, or ` +
	"when a durable fact about the project's work comes up that the next person to open it would " +
	"otherwise have to rediscover — a decision and its reason, a convention, a constraint, where " +
	`something lives. Call ${FORGET_FOR_PROJECT_TOOL_NAME} when a note is wrong or they ask for ` +
	`it to go. Use ${REMEMBER_TOOL_NAME} instead for facts about the person themselves ` +
	"(their preferences, how they want to be addressed): a project note is read by colleagues. " +
	"The same limits apply as for personal memory: nothing transient, no secrets or credentials, " +
	"one self-contained sentence or short paragraph that makes sense with no surrounding context, " +
	"and never announce that you are using these tools.";

/** What differs between the personal pair and the project pair. */
interface Flavor {
	rememberName: string;
	forgetName: string;
	textMax: number;
	doctrine: string;
	rememberDescription: string;
	rememberFactDescription: string;
	forgetDescription: string;
	forgetFactDescription: string;
	remember(
		text: string,
		ctx: { userId: ObjectId; conversationId?: ObjectId }
	): Promise<{ text: string; id: string; created: boolean }>;
	forget(text: string, ctx: { userId: ObjectId }): Promise<{ text: string }>;
	/** Added to the transcript card so its undo can reach the right route. */
	updateScope: { scope?: "project"; projectId?: string };
	unavailable: string;
}

function build(flavor: Flavor): BuiltinTool[] {
	const remember: BuiltinTool = {
		name: flavor.rememberName,
		definition: {
			type: "function" as const,
			function: {
				name: flavor.rememberName,
				description: flavor.rememberDescription,
				parameters: {
					type: "object",
					properties: {
						fact: {
							type: "string",
							maxLength: flavor.textMax,
							description: flavor.rememberFactDescription,
						},
					},
					required: ["fact"],
				},
			},
		},
		preprompt: flavor.doctrine,

		async execute(args, ctx) {
			if (!ctx.userId) {
				// Anonymous sessions have nowhere durable to write; say so plainly
				// rather than failing in a way the model reads as "try again".
				return { error: flavor.unavailable };
			}
			try {
				const { text, id, created } = await flavor.remember(String(args.fact ?? ""), {
					userId: ctx.userId,
					conversationId: ctx.conversationId,
				});
				return {
					// A no-op is reported as one. Told "Remembered" for something it
					// already knew, a model tends to announce a save that did not
					// happen, and on the next turn tends to save it again.
					resultText: created
						? `Remembered: ${text}`
						: `Already in memory, nothing changed: ${text}`,
					extraUpdates: created
						? [
								{
									type: MessageUpdateType.Memory as const,
									uuid: ctx.uuid,
									action: "remembered" as const,
									text,
									memoryId: id,
									...flavor.updateScope,
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
		name: flavor.forgetName,
		definition: {
			type: "function" as const,
			function: {
				name: flavor.forgetName,
				description: flavor.forgetDescription,
				parameters: {
					type: "object",
					properties: {
						fact: {
							type: "string",
							maxLength: flavor.textMax,
							description: flavor.forgetFactDescription,
						},
					},
					required: ["fact"],
				},
			},
		},

		async execute(args, ctx) {
			if (!ctx.userId) return { error: flavor.unavailable };
			try {
				const removed = await flavor.forget(String(args.fact ?? ""), { userId: ctx.userId });
				return {
					resultText: `Forgotten: ${removed.text}`,
					extraUpdates: [
						{
							type: MessageUpdateType.Memory as const,
							uuid: ctx.uuid,
							action: "forgot" as const,
							text: removed.text,
							...flavor.updateScope,
						},
					],
				};
			} catch (err) {
				// Every failure here is a mismatch the model can fix by retrying
				// with better wording, and the service puts the real list in the
				// message for exactly that. None of them is a server fault.
				if (err instanceof MemoryValidationError) return { error: err.message };
				throw err;
			}
		},
	};

	return [remember, forget];
}

/**
 * The tools, or none at all.
 *
 * `enabled` is resolved by the caller (runMcpFlow) from the deployment flag
 * and the person's own setting, because it needs a database read and
 * `getEnabledBuiltinTools` is deliberately synchronous — the same division
 * `searchModelIds` and `playwrightReachable` already follow. Returning an
 * empty array rather than throwing keeps the "a tool withholds itself" shape
 * every other builtin here uses.
 *
 * `project` is the second pair, offered *in addition* in a project's
 * conversation and only when the caller has already confirmed this person is
 * a member and the deployment flag is on. It is independent of `enabled`: the
 * personal opt-in is a decision about facts concerning oneself, and a shared
 * project's notes are not that.
 */
export function createMemoryBuiltins(params: {
	enabled: boolean;
	project?: { projectId: ObjectId };
}): BuiltinTool[] {
	const tools: BuiltinTool[] = [];

	if (params.enabled) {
		tools.push(
			...build({
				rememberName: REMEMBER_TOOL_NAME,
				forgetName: FORGET_TOOL_NAME,
				textMax: MEMORY_TEXT_MAX_CHARS,
				doctrine: DOCTRINE,
				rememberDescription:
					"Store one standing fact about the person you are talking to, so it is available " +
					"in every future conversation. Use it for things that stay true, not for the state " +
					"of the current task.",
				rememberFactDescription:
					"One self-contained sentence in the third person, understandable with no " +
					'surrounding context. For example: "Works on the Pystino gateway for ' +
					'his personal deployment" or "Prefers concise answers with no preamble".',
				forgetDescription:
					"Remove one standing fact from memory. Use it when the person asks you to forget " +
					"something, or when a remembered fact has become wrong.",
				forgetFactDescription:
					"The fact to remove, repeated as closely as you can to how it appears in " +
					"the memory list you were given. If more than one matches you will be " +
					"told, and can retry with the exact wording.",
				unavailable: "Memory is only available to a signed-in person. Continue without it.",
				updateScope: {},
				async remember(text, ctx) {
					const { memory, created } = await rememberFact({
						userId: ctx.userId,
						text,
						source: "model",
						...(ctx.conversationId ? { conversationId: ctx.conversationId } : {}),
					});
					return { text: memory.text, id: memory._id.toString(), created };
				},
				forget: (text, ctx) => forgetFact({ userId: ctx.userId, text }),
			})
		);
	}

	if (params.project) {
		const { projectId } = params.project;
		tools.push(
			...build({
				rememberName: REMEMBER_FOR_PROJECT_TOOL_NAME,
				forgetName: FORGET_FOR_PROJECT_TOOL_NAME,
				textMax: PROJECT_MEMORY_TEXT_MAX_CHARS,
				doctrine: PROJECT_DOCTRINE,
				rememberDescription:
					"Store one note on this project's shared memory, available to every member in " +
					"every conversation in this project. Use it for durable facts about the work, " +
					"not for facts about the person you are talking to and not for the state of the " +
					"current task.",
				rememberFactDescription:
					"One self-contained note, understandable by a colleague with no surrounding " +
					'context. For example: "Deploys go through the release branch; the staging ' +
					'database is reset every Monday".',
				forgetDescription:
					"Remove one note from this project's shared memory. Use it when a note is wrong " +
					"or the person asks for it to go.",
				forgetFactDescription:
					"The note to remove, repeated as closely as you can to how it appears in the " +
					"project memory you were given. If more than one matches you will be told, " +
					"and can retry with the exact wording.",
				unavailable: "Project memory is only available to a signed-in person. Continue without it.",
				updateScope: { scope: "project", projectId: projectId.toString() },
				async remember(text, ctx) {
					const { memory, created } = await rememberForProject({
						projectId,
						authorUserId: ctx.userId,
						text,
						source: "model",
						...(ctx.conversationId ? { conversationId: ctx.conversationId } : {}),
					});
					return { text: memory.text, id: memory._id.toString(), created };
				},
				forget: (text) => forgetForProject({ projectId, text }),
			})
		);
	}

	return tools;
}
