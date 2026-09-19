/**
 * User memory: the store, the rules, and the block that goes in the prompt.
 *
 * Routes and the builtin tools stay thin and call in here, so the two ways a
 * fact can be written — somebody typing it on the Memory screen, and the
 * model calling `remember` mid-turn — go through exactly the same validation,
 * the same deduplication and the same ceiling. They were never going to stay
 * in step if each grew its own copy.
 *
 * Read `src/lib/types/Memory.ts` first: it explains why this is a list that
 * is injected whole rather than a vector store that is searched.
 */

import { ObjectId } from "mongodb";
import { collections } from "$lib/server/database";
import { logger } from "$lib/server/logger";
import {
	MEMORY_BLOCK_MAX_CHARS,
	MEMORY_MAX_FACTS,
	MEMORY_TEXT_MAX_CHARS,
	type Memory,
	type MemoryView,
} from "$lib/types/Memory";
import type { User } from "$lib/types/User";
import { fitMemoriesToBudget } from "$lib/utils/memoryBudget";

// Re-exported so the routes and the tools keep one import for the whole
// vocabulary of this feature; the values themselves live with the type
// because the Memory screen needs them too.
export { MEMORY_BLOCK_MAX_CHARS, MEMORY_MAX_FACTS, MEMORY_TEXT_MAX_CHARS };

/** A rejected write, with a message meant to be read by a person or a model. */
export class MemoryValidationError extends Error {}

export function memoryView(memory: Memory): MemoryView {
	return {
		id: memory._id.toString(),
		text: memory.text,
		source: memory.source,
		...(memory.conversationId ? { conversationId: memory.conversationId.toString() } : {}),
		createdAt: memory.createdAt.toISOString(),
		updatedAt: memory.updatedAt.toISOString(),
	};
}

/**
 * Oldest first, everywhere: it is the order the prompt block renders in, the
 * order the screen lists in, and the end the budget drops from. One order
 * means the screen's top row is always the first thing at risk of falling out
 * of the prompt, rather than some other row the person cannot identify.
 */
export async function listMemories(userId: User["_id"]): Promise<Memory[]> {
	return collections.memories.find({ userId }).sort({ createdAt: 1 }).toArray();
}

/**
 * Comparison form for deduplication and for `forget`'s matching.
 *
 * Case, surrounding space, internal runs of space and a trailing full stop
 * all get normalised away, because a model asked to forget a fact it was
 * shown reproduces it with exactly those differences. Anything cleverer —
 * stemming, embedding similarity — would start silently conflating facts
 * that differ in one meaningful word, which is a worse failure than asking
 * the model to try again.
 */
function normalise(text: string): string {
	return text.trim().toLowerCase().replace(/\s+/g, " ").replace(/\.$/, "");
}

function validateText(raw: unknown): string {
	if (typeof raw !== "string") throw new MemoryValidationError("A memory must be text.");
	const text = raw.trim().replace(/\s+/g, " ");
	if (!text) throw new MemoryValidationError("A memory cannot be empty.");
	if (text.length > MEMORY_TEXT_MAX_CHARS) {
		throw new MemoryValidationError(
			`A memory must be ${MEMORY_TEXT_MAX_CHARS} characters or fewer; that one is ${text.length}. ` +
				"Store the durable part of it, not the whole passage."
		);
	}
	return text;
}

/**
 * Store a fact, or recognise one already stored.
 *
 * Deduplication is exact-after-normalising and nothing more. A model that
 * re-remembers something it was already told gets the existing row back with
 * its timestamp moved, rather than a second copy — the cheap half of what
 * mem0 does with an extraction model, and the half that pays for itself. The
 * expensive half (noticing that a new fact *contradicts* an old one and
 * retiring it) is deliberately not attempted: getting it wrong deletes
 * something true, and the model can call `forget` when it actually knows.
 *
 * `created` tells the caller which happened, because the transcript card
 * should not announce a save that was really a no-op.
 */
export async function rememberFact(options: {
	userId: User["_id"];
	text: string;
	source: Memory["source"];
	conversationId?: ObjectId;
}): Promise<{ memory: Memory; created: boolean }> {
	const text = validateText(options.text);
	const existing = await collections.memories.find({ userId: options.userId }).toArray();

	const duplicate = existing.find((row) => normalise(row.text) === normalise(text));
	if (duplicate) {
		const now = new Date();
		await collections.memories.updateOne({ _id: duplicate._id }, { $set: { updatedAt: now } });
		return { memory: { ...duplicate, updatedAt: now }, created: false };
	}

	if (existing.length >= MEMORY_MAX_FACTS) {
		throw new MemoryValidationError(
			`Memory is full (${MEMORY_MAX_FACTS} facts). Forget something before remembering more.`
		);
	}

	const now = new Date();
	const memory: Memory = {
		_id: new ObjectId(),
		userId: options.userId,
		text,
		source: options.source,
		...(options.conversationId ? { conversationId: options.conversationId } : {}),
		createdAt: now,
		updatedAt: now,
	};
	await collections.memories.insertOne(memory);
	return { memory, created: true };
}

/** Rewrite one fact in place. Owner-only; a miss is indistinguishable from not existing. */
export async function updateMemory(
	userId: User["_id"],
	id: ObjectId,
	rawText: string
): Promise<Memory> {
	const text = validateText(rawText);
	// Write then read, rather than `findOneAndUpdate`: this driver's typing
	// for that call returns a `ModifyResult` wrapper whose shape has changed
	// between versions, and the ownership filter — which is the part that
	// matters — is enforced identically either way by `matchedCount`.
	const result = await collections.memories.updateOne(
		{ _id: id, userId },
		{ $set: { text, updatedAt: new Date() } }
	);
	if (result.matchedCount === 0) throw new MemoryValidationError("No such memory.");
	const updated = await collections.memories.findOne({ _id: id, userId });
	if (!updated) throw new MemoryValidationError("No such memory.");
	return updated;
}

export async function deleteMemory(userId: User["_id"], id: ObjectId): Promise<boolean> {
	const result = await collections.memories.deleteOne({ _id: id, userId });
	return result.deletedCount > 0;
}

/**
 * Remove a fact the model named in words rather than by id.
 *
 * Ids are kept out of the prompt block on purpose — they are noise in every
 * turn that does not forget anything, which is nearly all of them — so
 * `forget` has to match on text. Three tiers, narrowest first: an exact match
 * after normalising, then a unique containment either way (the model
 * paraphrasing, or quoting only the clause it means), then refusal.
 *
 * The refusal is the important part, and it is shaped like `update_plan`'s:
 * it lists what is actually stored so the model can retry against the real
 * wording instead of guessing again. Deleting the wrong fact silently would
 * be far worse than one wasted round.
 */
export async function forgetFact(options: { userId: User["_id"]; text: string }): Promise<Memory> {
	const query = normalise(options.text);
	if (!query) throw new MemoryValidationError("Say which memory to forget.");

	const stored = await listMemories(options.userId);
	if (stored.length === 0) throw new MemoryValidationError("There is nothing in memory to forget.");

	const exact = stored.filter((row) => normalise(row.text) === query);
	const candidates =
		exact.length > 0
			? exact
			: stored.filter((row) => {
					const text = normalise(row.text);
					return text.includes(query) || query.includes(text);
				});

	if (candidates.length === 0) {
		throw new MemoryValidationError(
			`Nothing in memory matches that. Currently stored: ${renderList(stored)}.`
		);
	}
	if (candidates.length > 1) {
		throw new MemoryValidationError(
			`That matches more than one memory: ${renderList(candidates)}. ` +
				"Repeat one of them exactly."
		);
	}

	const target = candidates[0];
	await collections.memories.deleteOne({ _id: target._id, userId: options.userId });
	return target;
}

/** Quoted, comma-separated and bounded — a refusal is guidance, not a dump. */
function renderList(rows: Memory[]): string {
	const shown = rows.slice(0, 20).map((row) => `"${row.text}"`);
	const rest = rows.length - shown.length;
	return rest > 0 ? `${shown.join(", ")} and ${rest} more` : shown.join(", ");
}

/**
 * The system-prompt block, or `undefined` when there is nothing to say.
 *
 * `undefined` rather than an empty block, for the reason `projectContext`
 * gives: telling a model there is a memory section and leaving it blank
 * invites it to comment on the emptiness, which is worse than silence.
 *
 * Over budget, the **oldest** facts are dropped, and the block says how many.
 * Saying so matters — a model that is told it can see everything will answer
 * confidently about what somebody has never mentioned, and the truncation
 * notice is what turns that into a hedge. The screen carries the same warning
 * for the person, so neither side is the only one who knows.
 */
export async function buildMemoryBlock(userId: User["_id"]): Promise<string | undefined> {
	const stored = await listMemories(userId);
	if (stored.length === 0) return undefined;

	// The budget arithmetic is shared with the Memory screen rather than
	// repeated here, so the screen's "no longer being sent" marks and this
	// block can never disagree about which facts made it.
	const { included, omitted } = fitMemoriesToBudget(stored.map((row) => row.text));
	const lines = included.map((index) => `- ${stored[index].text}`);

	const notice =
		omitted > 0
			? ` ${omitted} older ${omitted === 1 ? "fact is" : "facts are"} stored but omitted here ` +
				"for length, so do not treat this list as everything you have been told."
			: "";

	return (
		"The following are standing facts about the person you are talking to, " +
		"remembered from earlier conversations. Use them where they are relevant and " +
		"ignore them where they are not; do not recite them back or mention this list " +
		`unless asked.${notice}\n\n${lines.join("\n")}`
	);
}

/**
 * The same block, resolved for a turn and guaranteed not to throw.
 *
 * Every caller is on the generation path, where the rule is the one
 * `projectContext` and the skills assembly already follow: a store that
 * cannot be read is a reason for a worse answer, never for no answer. The
 * try/catch lives here rather than at each call site so that rule cannot be
 * forgotten by the next caller.
 */
export async function memoryContext(userId: User["_id"] | undefined): Promise<string | undefined> {
	if (!userId) return undefined;
	try {
		return await buildMemoryBlock(userId);
	} catch (err) {
		logger.warn({ err: String(err) }, "memory_context_degraded: answering without memory");
		return undefined;
	}
}
