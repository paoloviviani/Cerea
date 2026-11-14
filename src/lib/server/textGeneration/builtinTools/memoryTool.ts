import { MessageUpdateType } from "$lib/types/MessageUpdate";
import type { ObjectId } from "mongodb";
import {
	CONVERSATION_MEMORY_TEXT_MAX_CHARS,
	forgetFact,
	forgetForConversation,
	forgetForProject,
	MemoryValidationError,
	MEMORY_TEXT_MAX_CHARS,
	PROJECT_MEMORY_TEXT_MAX_CHARS,
	rememberFact,
	rememberForConversation,
	rememberForProject,
} from "$lib/server/memory/service";
import type { BuiltinTool, BuiltinToolContext } from "./types";

export const REMEMBER_TOOL_NAME = "remember";
export const FORGET_TOOL_NAME = "forget";

/** The three places a note can go, narrowest first. */
export type MemoryToolScope = "conversation" | "project" | "global";

/**
 * Writing and unwriting notes: one pair of tools, with the place named in
 * every call (see `$lib/types/Memory` for why memory is a short list rather
 * than a store to search, and `$lib/types/ScopedMemory` for the two narrower
 * lists).
 *
 * ## Why one pair with a `scope`, where there used to be two pairs
 *
 * "Remember this for this chat" used to reach the one tool that existed and
 * wrote to the personal list, so a note about one chat came back in every
 * later one. Writing too broadly is the worse failure, and the cure is to make
 * the model say where a note goes, every time, with the narrow choices first.
 * The scopes offered are only those that exist for this turn: the enum is the
 * first guard, and each branch below is the second, because a model can name
 * a value it was not offered.
 *
 * `global` is the widest and the only one a model may not pick on its own
 * judgement: it must quote the user's own words that make a note permanent
 * (`user_words`), and a call without them is refused with an instruction to
 * ask. That cannot prove what the user meant, but it turns "default to
 * global" into a deliberate act the transcript card then shows.
 *
 * ## Why these are not behind the approval gate
 *
 * Gating (ADR 0075) exists for calls with external reach or cost, and a
 * memory write has neither: it touches one document in this app's own
 * database, on behalf of the person who owns it. An approval card per
 * remembered fact would be the most frequent interruption in the product and
 * would teach people to dismiss approval cards without reading them. The
 * safeguard is instead that the write is **shown** in the transcript as it
 * happens, says where it went, and can be undone in one click.
 *
 * ## The prompt guidance does most of the work
 *
 * Nothing stops a model from remembering something silly. The doctrine below
 * is the real control, and it is deliberately conservative: durable facts
 * only, nothing secret, and the narrowest scope that fits.
 */
function doctrine(scopes: MemoryToolScope[]): string {
	const has = (scope: MemoryToolScope) => scopes.includes(scope);
	const lines = [
		`MEMORY: You can keep short notes with ${REMEMBER_TOOL_NAME} and remove them with ${FORGET_TOOL_NAME}. ` +
			"Every call says where the note goes (scope), and the choice matters more than the wording: " +
			"a note kept too widely is repeated in places it does not belong, and a note kept too narrowly " +
			"is only lost, so always take the narrowest scope that fits.",
	];
	if (has("conversation")) {
		lines.push(
			'- scope "conversation": for this chat only. Use it for "remember this for this chat", ' +
				'"for now", "in this conversation", or any detail that matters here and nowhere else (a naming ' +
				"choice, a constraint of this task, what the user has decided so far). These notes are shown to " +
				"you on every turn of this chat and never appear in another."
		);
	}
	if (has("project")) {
		lines.push(
			'- scope "project": this chat belongs to a project, and the notes are read by every member in every ' +
				'chat in it. Use it when the user says "for this project", or for a durable fact about the ' +
				"project's work that the next person to open it would otherwise have to rediscover. Never for " +
				"facts about the user themselves: colleagues read these."
		);
	}
	if (has("global")) {
		lines.push(
			'- scope "global": standing facts about the user, kept in every future chat. Only when they clearly ' +
				'mean always or about themselves ("always", "from now on", "about me", "in every chat"). ' +
				"You must pass their own words, quoted from their latest message, in user_words. If it is unclear whether a note should be for " +
				'this chat or for every chat, ask the user, and do not guess "global".'
		);
	}
	lines.push(
		"Do not remember: anything already obvious from the conversation you are in, facts about other " +
			"people, or credentials, keys and other secrets: a secret in memory is a secret in every later " +
			"prompt. Do not remember something just because it was interesting. Write one self-contained " +
			'sentence that will still make sense with no surrounding context: "Prefers replies in Italian", ' +
			'not "yes, do that". Never announce that you are about to use these tools. After a save, the ' +
			'result tells you where the note went: tell the user in a few words (for example "Saved to ' +
			"this chat's notes\"), and do not repeat the note."
	);
	return lines.join("\n");
}

/** Where a write landed, in the words the model passes on to the user. */
const PLACE: Record<MemoryToolScope, string> = {
	conversation: "this chat's notes",
	project: "this project's notes (shared with every member)",
	global: "your memory, for every chat",
};

interface ScopeContext {
	userId: ObjectId;
	conversationId?: ObjectId;
	projectId?: ObjectId;
}

interface Stored {
	text: string;
	id: string;
	created: boolean;
}

async function rememberAt(
	scope: MemoryToolScope,
	text: string,
	ctx: ScopeContext
): Promise<Stored> {
	switch (scope) {
		case "conversation": {
			if (!ctx.conversationId)
				throw new MemoryValidationError("There is no chat to keep notes in.");
			const { memory, created } = await rememberForConversation({
				conversationId: ctx.conversationId,
				ownerUserId: ctx.userId,
				text,
				source: "model",
			});
			return { text: memory.text, id: memory._id.toString(), created };
		}
		case "project": {
			if (!ctx.projectId) throw new MemoryValidationError("This chat is not in a project.");
			const { memory, created } = await rememberForProject({
				projectId: ctx.projectId,
				authorUserId: ctx.userId,
				text,
				source: "model",
				...(ctx.conversationId ? { conversationId: ctx.conversationId } : {}),
			});
			return { text: memory.text, id: memory._id.toString(), created };
		}
		case "global": {
			const { memory, created } = await rememberFact({
				userId: ctx.userId,
				text,
				source: "model",
				...(ctx.conversationId ? { conversationId: ctx.conversationId } : {}),
			});
			return { text: memory.text, id: memory._id.toString(), created };
		}
	}
}

async function forgetAt(
	scope: MemoryToolScope,
	text: string,
	ctx: ScopeContext
): Promise<{ text: string }> {
	switch (scope) {
		case "conversation":
			if (!ctx.conversationId)
				throw new MemoryValidationError("There is no chat to keep notes in.");
			return forgetForConversation({ conversationId: ctx.conversationId, text });
		case "project":
			if (!ctx.projectId) throw new MemoryValidationError("This chat is not in a project.");
			return forgetForProject({ projectId: ctx.projectId, text });
		case "global":
			return forgetFact({ userId: ctx.userId, text });
	}
}

function textMaxFor(scopes: MemoryToolScope[]): number {
	const limits: Record<MemoryToolScope, number> = {
		conversation: CONVERSATION_MEMORY_TEXT_MAX_CHARS,
		project: PROJECT_MEMORY_TEXT_MAX_CHARS,
		global: MEMORY_TEXT_MAX_CHARS,
	};
	return Math.max(...scopes.map((scope) => limits[scope]));
}

/**
 * The scope a call asked for, or a refusal the model can act on. Anything
 * outside what this turn offers is refused, whatever the schema said; with a
 * single scope on offer the argument may be left out.
 */
function resolveScope(
	raw: unknown,
	scopes: MemoryToolScope[]
): { scope: MemoryToolScope } | { error: string } {
	if (raw === undefined || raw === null || raw === "") {
		if (scopes.length === 1) return { scope: scopes[0] };
		return {
			error: `Say where this goes: scope must be one of ${scopes.join(", ")}. Take the narrowest that fits.`,
		};
	}
	if (typeof raw === "string" && (scopes as string[]).includes(raw)) {
		return { scope: raw as MemoryToolScope };
	}
	return {
		error: `scope "${String(raw)}" is not available here. Use one of: ${scopes.join(", ")}.`,
	};
}

function guardsFor(ctx: BuiltinToolContext): ObjectId | undefined {
	return ctx.userId;
}

/** Case and whitespace folded, so "Always  reply in Italian" matches "always reply in italian". */
function fold(text: string): string {
	return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function build(
	scopes: MemoryToolScope[],
	projectId: ObjectId | undefined,
	latestUserText: (() => string) | undefined
): BuiltinTool[] {
	const textMax = textMaxFor(scopes);
	const scopeProperty = {
		type: "string",
		enum: scopes,
		description:
			"Where the note goes. " +
			(scopes.includes("conversation")
				? '"conversation" is this chat only (the default for "remember this for this chat"). '
				: "") +
			(scopes.includes("project")
				? '"project" is shared with every member of this chat\'s project. '
				: "") +
			(scopes.includes("global")
				? '"global" is every future chat, only when the user clearly means always or about themselves. '
				: "") +
			"Take the narrowest that fits.",
	};
	const withGlobal = scopes.includes("global");
	const userWords = {
		type: "string",
		description:
			'Required for scope "global": the words, quoted exactly from the user\'s latest message, that make ' +
			'this note permanent ("always", "about me", "in every chat"). It is checked against that message. ' +
			"Leave out for other scopes. If they said nothing like that, ask the user instead.",
	};

	const remember: BuiltinTool = {
		name: REMEMBER_TOOL_NAME,
		definition: {
			type: "function" as const,
			function: {
				name: REMEMBER_TOOL_NAME,
				description:
					"Keep one short note. The scope says where: this chat only, this chat's project, or " +
					"(only when the user clearly means always or about themselves) every future chat. " +
					"Use it for things that stay true for that scope, not for the state of the current task. " +
					"The result tells you where it was saved.",
				parameters: {
					type: "object",
					properties: {
						fact: {
							type: "string",
							maxLength: textMax,
							description:
								"One self-contained sentence, understandable with no surrounding context. " +
								'For example: "Prefers concise answers with no preamble".',
						},
						scope: scopeProperty,
						...(withGlobal ? { user_words: userWords } : {}),
					},
					required: scopes.length > 1 ? ["fact", "scope"] : ["fact"],
				},
			},
		},
		preprompt: doctrine(scopes),

		async execute(args, ctx) {
			const userId = guardsFor(ctx);
			if (!userId) {
				return { error: "Memory is only available to a signed-in person. Continue without it." };
			}
			const picked = resolveScope(args.scope, scopes);
			if ("error" in picked) return picked;
			const { scope } = picked;
			if (scope === "global") {
				// The words must be the user's: they have to appear in their newest message. A
				// model can invent a justification; it cannot invent what the user typed.
				const words = fold(String(args.user_words ?? ""));
				const said = latestUserText ? fold(latestUserText()) : "";
				if (!words || !said.includes(words)) {
					return {
						error:
							"A global note needs the user's own words, quoted from their latest message, saying it " +
							"should last (pass them as user_words). Ask the user whether this is for this chat only " +
							"or for every chat, and do not guess.",
					};
				}
			}
			try {
				const { text, id, created } = await rememberAt(scope, String(args.fact ?? ""), {
					userId,
					conversationId: ctx.conversationId,
					projectId,
				});
				return {
					// A no-op is reported as one. Told "Saved" for something it already
					// knew, a model tends to announce a save that did not happen, and on
					// the next turn tends to save it again.
					resultText: created
						? `Saved to ${PLACE[scope]}: ${text}`
						: `Already in ${PLACE[scope]}, nothing changed: ${text}`,
					extraUpdates: created
						? [
								{
									type: MessageUpdateType.Memory as const,
									uuid: ctx.uuid,
									action: "remembered" as const,
									text,
									memoryId: id,
									scope,
									...(scope === "project" && projectId ? { projectId: projectId.toString() } : {}),
									...(scope === "conversation" && ctx.conversationId
										? { conversationId: ctx.conversationId.toString() }
										: {}),
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
					"Remove one note from the scope it was kept in. Use it when the user asks you to forget " +
					"something, or when a note has become wrong.",
				parameters: {
					type: "object",
					properties: {
						fact: {
							type: "string",
							maxLength: textMax,
							description:
								"The note to remove, repeated as closely as you can to how it appears in the " +
								"list you were given. If more than one matches you will be told, and can retry " +
								"with the exact wording.",
						},
						scope: { ...scopeProperty, description: "The list the note is in." },
					},
					required: scopes.length > 1 ? ["fact", "scope"] : ["fact"],
				},
			},
		},

		async execute(args, ctx) {
			const userId = guardsFor(ctx);
			if (!userId) {
				return { error: "Memory is only available to a signed-in person. Continue without it." };
			}
			const picked = resolveScope(args.scope, scopes);
			if ("error" in picked) return picked;
			const { scope } = picked;
			try {
				const removed = await forgetAt(scope, String(args.fact ?? ""), {
					userId,
					conversationId: ctx.conversationId,
					projectId,
				});
				return {
					resultText: `Forgotten from ${PLACE[scope]}: ${removed.text}`,
					extraUpdates: [
						{
							type: MessageUpdateType.Memory as const,
							uuid: ctx.uuid,
							action: "forgot" as const,
							text: removed.text,
							scope,
							...(scope === "project" && projectId ? { projectId: projectId.toString() } : {}),
							...(scope === "conversation" && ctx.conversationId
								? { conversationId: ctx.conversationId.toString() }
								: {}),
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
 * `enabled` is the person's own opt-in for standing facts about themselves
 * (deployment flag and `Settings.memoryEnabled`, resolved by the caller
 * because it needs a database read and `getEnabledBuiltinTools` is
 * deliberately synchronous). It gates only the `global` scope.
 * `conversation` is the deployment flag alone: a note that dies with the chat
 * is not a decision about the person, so it needs no opt-in. `project` is
 * offered in a project's chat when the caller has confirmed this person is a
 * member and the deployment flag is on.
 */
export function createMemoryBuiltins(params: {
	enabled: boolean;
	/** The deployment flag is on, so this chat may keep its own notes. */
	conversation?: boolean;
	project?: { projectId: ObjectId };
	/** The user's newest message, for the `global` scope's quote check; without it no global write passes. */
	latestUserText?: () => string;
}): BuiltinTool[] {
	const scopes: MemoryToolScope[] = [];
	if (params.conversation) scopes.push("conversation");
	if (params.project) scopes.push("project");
	if (params.enabled) scopes.push("global");
	if (scopes.length === 0) return [];
	return build(scopes, params.project?.projectId, params.latestUserText);
}
