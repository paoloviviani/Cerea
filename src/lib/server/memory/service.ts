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

import { ObjectId, type Collection, type Filter } from "mongodb";
import { collections } from "$lib/server/database";
import { logger } from "$lib/server/logger";
import {
	MEMORY_BLOCK_MAX_CHARS,
	MEMORY_MAX_FACTS,
	MEMORY_TEXT_MAX_CHARS,
	PROJECT_MEMORY_BLOCK_MAX_CHARS,
	PROJECT_MEMORY_MAX_NOTES,
	PROJECT_MEMORY_TEXT_MAX_CHARS,
	type Memory,
	type MemoryView,
} from "$lib/types/Memory";
import type { ProjectMemory, ProjectMemoryView } from "$lib/types/ProjectMemory";
import {
	AGENT_MEMORY_BLOCK_MAX_CHARS,
	AGENT_MEMORY_MAX_NOTES,
	AGENT_MEMORY_TEXT_MAX_CHARS,
	CONVERSATION_MEMORY_BLOCK_MAX_CHARS,
	CONVERSATION_MEMORY_MAX_NOTES,
	CONVERSATION_MEMORY_TEXT_MAX_CHARS,
	type AgentMemory,
	type AgentMemoryScope,
	type ConversationMemory,
} from "$lib/types/ScopedMemory";
import type { User } from "$lib/types/User";
import { fitMemoriesToBudget } from "$lib/utils/memoryBudget";

// Re-exported so the routes and the tools keep one import for the whole
// vocabulary of this feature; the values themselves live with the type
// because the Memory screen needs them too.
export {
	CONVERSATION_MEMORY_TEXT_MAX_CHARS,
	MEMORY_BLOCK_MAX_CHARS,
	MEMORY_MAX_FACTS,
	MEMORY_TEXT_MAX_CHARS,
	PROJECT_MEMORY_BLOCK_MAX_CHARS,
	PROJECT_MEMORY_MAX_NOTES,
	PROJECT_MEMORY_TEXT_MAX_CHARS,
};

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

// ---------------------------------------------------------------------------
// The shared core
//
// Personal facts and a project's notes are the same machine pointed at two
// different keys: a list read whole, oldest first, validated and deduplicated
// on the way in, trimmed to a budget on the way out. The rules live once, here,
// parameterised by a `Scope`, because two hand-kept copies are exactly how a
// ceiling gets raised in one place and not the other. What differs between the
// two — who the rows belong to, the limits, the words in an error — is data on
// the scope; what must not differ is not a parameter at all.
// ---------------------------------------------------------------------------

/** The columns the core reads and writes; both row types carry them. */
interface Row {
	_id: ObjectId;
	text: string;
	source: "model" | "user";
	conversationId?: ObjectId;
	createdAt: Date;
	updatedAt: Date;
}

interface Scope {
	/** Which rows are in this list: `{ userId }` or `{ projectId }`. */
	filter: Record<string, unknown>;
	/** Stamped on every new row to put it in the list (the same keys as `filter`, plus an author). */
	stamp: Record<string, unknown>;
	collection: Collection<Row>;
	textMaxChars: number;
	maxItems: number;
	blockMaxChars: number;
	/** "memory" / "note": the singular used in a message. */
	noun: string;
	/** "Memory" / "Project memory": the store, capitalised, for "… is full". */
	store: string;
	/** "facts" / "notes". */
	plural: string;
	/** Where "nothing to forget" says it is: "memory", "project memory", "this chat's notes". */
	where: string;
}

function personalScope(userId: User["_id"]): Scope {
	return {
		filter: { userId },
		stamp: { userId },
		// Collection<T> is invariant; Row is the subset of columns both stores share.
		collection: collections.memories as unknown as Collection<Row>,
		textMaxChars: MEMORY_TEXT_MAX_CHARS,
		maxItems: MEMORY_MAX_FACTS,
		blockMaxChars: MEMORY_BLOCK_MAX_CHARS,
		noun: "memory",
		store: "Memory",
		plural: "facts",
		where: "memory",
	};
}

function projectScope(projectId: ObjectId, authorUserId?: User["_id"]): Scope {
	return {
		filter: { projectId },
		stamp: { projectId, ...(authorUserId ? { authorUserId } : {}) },
		collection: collections.projectMemories as unknown as Collection<Row>,
		textMaxChars: PROJECT_MEMORY_TEXT_MAX_CHARS,
		maxItems: PROJECT_MEMORY_MAX_NOTES,
		blockMaxChars: PROJECT_MEMORY_BLOCK_MAX_CHARS,
		noun: "note",
		store: "Project memory",
		plural: "notes",
		where: "project memory",
	};
}

function conversationScope(conversationId: ObjectId, ownerUserId?: User["_id"]): Scope {
	return {
		filter: { conversationId },
		stamp: { conversationId, ...(ownerUserId ? { userId: ownerUserId } : {}) },
		collection: collections.conversationMemories as unknown as Collection<Row>,
		textMaxChars: CONVERSATION_MEMORY_TEXT_MAX_CHARS,
		maxItems: CONVERSATION_MEMORY_MAX_NOTES,
		blockMaxChars: CONVERSATION_MEMORY_BLOCK_MAX_CHARS,
		noun: "note",
		store: "This chat's notes",
		plural: "notes",
		where: "this chat's notes",
	};
}

/**
 * An agent's session or workspace list. The filter names the owner, the
 * computer and the scope together, so a key that exists on another computer or
 * under another user is simply not in the list: there is no way to ask for it.
 */
function agentScope(options: {
	userId: User["_id"];
	deviceId: string;
	scope: AgentMemoryScope;
	key: string;
}): Scope {
	const where = {
		userId: options.userId,
		deviceId: options.deviceId,
		scope: options.scope,
		key: options.key,
	};
	return {
		filter: where,
		stamp: where,
		collection: collections.agentMemories as unknown as Collection<Row>,
		textMaxChars: AGENT_MEMORY_TEXT_MAX_CHARS,
		maxItems: AGENT_MEMORY_MAX_NOTES,
		blockMaxChars: AGENT_MEMORY_BLOCK_MAX_CHARS,
		noun: "note",
		store: options.scope === "session" ? "This session's notes" : "This workspace's notes",
		plural: "notes",
		where: options.scope === "session" ? "this session's notes" : "this workspace's notes",
	};
}

/**
 * Oldest first, everywhere: it is the order the prompt block renders in, the
 * order the screen lists in, and the end the budget drops from. One order
 * means the screen's top row is always the first thing at risk of falling out
 * of the prompt, rather than some other row the person cannot identify.
 */
async function listRows(scope: Scope): Promise<Row[]> {
	return scope.collection
		.find(scope.filter as Filter<Row>)
		.sort({ createdAt: 1, _id: 1 })
		.toArray();
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

function validateText(scope: Scope, raw: unknown): string {
	if (typeof raw !== "string") throw new MemoryValidationError(`A ${scope.noun} must be text.`);
	const text = raw.trim().replace(/\s+/g, " ");
	if (!text) throw new MemoryValidationError(`A ${scope.noun} cannot be empty.`);
	if (text.length > scope.textMaxChars) {
		throw new MemoryValidationError(
			`A ${scope.noun} must be ${scope.textMaxChars} characters or fewer; that one is ${text.length}. ` +
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
async function rememberIn(
	scope: Scope,
	options: { text: string; source: Row["source"]; conversationId?: ObjectId }
): Promise<{ row: Row; created: boolean }> {
	const text = validateText(scope, options.text);
	const existing = await listRows(scope);

	const duplicate = existing.find((row) => normalise(row.text) === normalise(text));
	if (duplicate) {
		const now = new Date();
		await scope.collection.updateOne({ _id: duplicate._id }, { $set: { updatedAt: now } });
		return { row: { ...duplicate, updatedAt: now }, created: false };
	}

	if (existing.length >= scope.maxItems) {
		throw new MemoryValidationError(
			`${scope.store} is full (${scope.maxItems} ${scope.plural}). Forget something before remembering more.`
		);
	}

	const now = new Date();
	const row = {
		_id: new ObjectId(),
		...scope.stamp,
		text,
		source: options.source,
		...(options.conversationId ? { conversationId: options.conversationId } : {}),
		createdAt: now,
		updatedAt: now,
	} as Row;
	await scope.collection.insertOne(row);
	return { row, created: true };
}

async function updateIn(scope: Scope, id: ObjectId, rawText: string): Promise<Row> {
	const text = validateText(scope, rawText);
	const filter = { _id: id, ...scope.filter } as Filter<Row>;
	// Write then read, rather than `findOneAndUpdate`: this driver's typing
	// for that call returns a `ModifyResult` wrapper whose shape has changed
	// between versions, and the ownership filter — which is the part that
	// matters — is enforced identically either way by `matchedCount`.
	const result = await scope.collection.updateOne(filter, {
		$set: { text, updatedAt: new Date() },
	});
	if (result.matchedCount === 0) throw new MemoryValidationError(`No such ${scope.noun}.`);
	const updated = await scope.collection.findOne(filter);
	if (!updated) throw new MemoryValidationError(`No such ${scope.noun}.`);
	return updated;
}

async function deleteIn(scope: Scope, id: ObjectId): Promise<boolean> {
	const result = await scope.collection.deleteOne({ _id: id, ...scope.filter } as Filter<Row>);
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
async function forgetIn(scope: Scope, rawText: string): Promise<Row> {
	const query = normalise(rawText);
	if (!query) throw new MemoryValidationError(`Say which ${scope.noun} to forget.`);

	const stored = await listRows(scope);
	const where = scope.where;
	if (stored.length === 0) {
		throw new MemoryValidationError(`There is nothing in ${where} to forget.`);
	}

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
			`Nothing in ${where} matches that. Currently stored: ${renderList(stored)}.`
		);
	}
	if (candidates.length > 1) {
		throw new MemoryValidationError(
			`That matches more than one ${scope.noun}: ${renderList(candidates)}. ` +
				"Repeat one of them exactly."
		);
	}

	const target = candidates[0];
	await scope.collection.deleteOne({ _id: target._id, ...scope.filter } as Filter<Row>);
	return target;
}

/** Quoted, comma-separated and bounded — a refusal is guidance, not a dump. */
function renderList(rows: Row[]): string {
	const shown = rows.slice(0, 20).map((row) => `"${row.text}"`);
	const rest = rows.length - shown.length;
	return rest > 0 ? `${shown.join(", ")} and ${rest} more` : shown.join(", ");
}

/** A row as a list view needs it: ids as strings, dates as ISO. */
function viewOf(row: Row) {
	return {
		id: row._id.toString(),
		text: row.text,
		source: row.source,
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
	};
}

// ---------------------------------------------------------------------------
// Personal memory
// ---------------------------------------------------------------------------

export async function listMemories(userId: User["_id"]): Promise<Memory[]> {
	return (await listRows(personalScope(userId))) as Memory[];
}

export async function rememberFact(options: {
	userId: User["_id"];
	text: string;
	source: Memory["source"];
	conversationId?: ObjectId;
}): Promise<{ memory: Memory; created: boolean }> {
	const { row, created } = await rememberIn(personalScope(options.userId), options);
	return { memory: row as Memory, created };
}

/** Rewrite one fact in place. Owner-only; a miss is indistinguishable from not existing. */
export async function updateMemory(
	userId: User["_id"],
	id: ObjectId,
	rawText: string
): Promise<Memory> {
	return (await updateIn(personalScope(userId), id, rawText)) as Memory;
}

export async function deleteMemory(userId: User["_id"], id: ObjectId): Promise<boolean> {
	return deleteIn(personalScope(userId), id);
}

export async function forgetFact(options: { userId: User["_id"]; text: string }): Promise<Memory> {
	return (await forgetIn(personalScope(options.userId), options.text)) as Memory;
}

/**
 * The system-prompt block, or `undefined` when there is nothing to say.
 *
 * `undefined` rather than an empty block, for the reason `projectContext`
 * gives: telling a model there is a memory section and leaving it blank
 * invites it to comment on the emptiness, which is worse than silence.
 */
export async function buildMemoryBlock(
	userId: User["_id"],
	excludeConversationId?: ObjectId
): Promise<string | undefined> {
	const stored = withoutOwn(await listRows(personalScope(userId)), excludeConversationId);
	return renderMemoryBlock(stored.map((row) => row.text));
}

/**
 * The rows a conversation did not write itself. An entry the chat tool created in this conversation
 * is already in the chat as the `remember` call and its result, so it is left out of this
 * conversation's system prompt (which therefore does not change when the model writes one);
 * every other conversation reads it there. Same order as the list, nothing else changes.
 */
function withoutOwn<T extends { conversationId?: ObjectId }>(
	rows: T[],
	conversationId: ObjectId | undefined
): T[] {
	if (!conversationId) return rows;
	return rows.filter((row) => !row.conversationId?.equals(conversationId));
}

/**
 * The block as a pure function of the fact texts (oldest first). Split from the
 * read so a conversation can render the same text from its start-of-chat
 * snapshot, byte for byte, on every turn (see `memory/snapshot.ts`).
 */
export function renderMemoryBlock(texts: string[]): string | undefined {
	if (texts.length === 0) return undefined;
	const { included, omitted } = fitMemoriesToBudget(texts, MEMORY_BLOCK_MAX_CHARS);
	const lines = included.map((index) => `- ${texts[index]}`);
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
export async function memoryContext(
	userId: User["_id"] | undefined,
	excludeConversationId?: ObjectId
): Promise<string | undefined> {
	if (!userId) return undefined;
	try {
		return await buildMemoryBlock(userId, excludeConversationId);
	} catch (err) {
		logger.warn({ err: String(err) }, "memory_context_degraded: answering without memory");
		return undefined;
	}
}

// ---------------------------------------------------------------------------
// Project memory
//
// Access is decided by the caller: every function here takes a project id it
// is trusting the route (or the conversation's own `projectId`) to have
// checked with `projectAccess`. A note's id is only ever matched together with
// its project's, so an id from another project is a miss, not a leak.
// ---------------------------------------------------------------------------

export async function listProjectMemories(projectId: ObjectId): Promise<ProjectMemory[]> {
	return (await listRows(projectScope(projectId))) as ProjectMemory[];
}

export async function rememberForProject(options: {
	projectId: ObjectId;
	authorUserId: User["_id"];
	text: string;
	source: ProjectMemory["source"];
	conversationId?: ObjectId;
}): Promise<{ memory: ProjectMemory; created: boolean }> {
	const { row, created } = await rememberIn(
		projectScope(options.projectId, options.authorUserId),
		options
	);
	return { memory: row as ProjectMemory, created };
}

/** Any member may rewrite any note; the author stays the person who wrote it. */
export async function updateProjectMemory(
	projectId: ObjectId,
	id: ObjectId,
	rawText: string
): Promise<ProjectMemory> {
	return (await updateIn(projectScope(projectId), id, rawText)) as ProjectMemory;
}

export async function deleteProjectMemory(projectId: ObjectId, id: ObjectId): Promise<boolean> {
	return deleteIn(projectScope(projectId), id);
}

export async function forgetForProject(options: {
	projectId: ObjectId;
	text: string;
}): Promise<ProjectMemory> {
	return (await forgetIn(projectScope(options.projectId), options.text)) as ProjectMemory;
}

/** Shown in place of a name once the author's account is gone. */
export const DELETED_AUTHOR = "deleted user";

/**
 * The notes as the tab draws them, authors resolved to names.
 *
 * A name rather than an address: a member of a shared project is entitled to
 * know who wrote a note, not to read the email of everyone else it was shared
 * with (`projectView` withholds the share list for the same reason). An author
 * whose account no longer exists — erased, or merged away — reads as
 * "deleted user", which is the user-approved wording for notes that outlive
 * their writer.
 */
export async function projectMemoryViews(
	projectId: ObjectId,
	viewerId: User["_id"]
): Promise<ProjectMemoryView[]> {
	const rows = await listProjectMemories(projectId);
	const ids = [
		...new Map(rows.map((row) => [row.authorUserId.toString(), row.authorUserId])).values(),
	];
	const users =
		ids.length > 0
			? await collections.users
					.find({ _id: { $in: ids } })
					.project<{ _id: ObjectId; name?: string; username?: string }>({
						name: 1,
						username: 1,
					})
					.toArray()
			: [];
	const names = new Map(users.map((user) => [user._id.toString(), user.name || user.username]));
	return rows.map((row) => {
		const key = row.authorUserId.toString();
		return {
			id: row._id.toString(),
			text: row.text,
			source: row.source,
			author: names.has(key) ? (names.get(key) ?? "a member") : DELETED_AUTHOR,
			mine: row.authorUserId.equals(viewerId),
			...(row.conversationId ? { conversationId: row.conversationId.toString() } : {}),
			createdAt: row.createdAt.toISOString(),
			updatedAt: row.updatedAt.toISOString(),
		};
	});
}

/**
 * The "Project memory" block for one project's chats, or `undefined`.
 *
 * Built only from the conversation's own `projectId` — never from anything the
 * viewer supplies — and placed after the personal block, so in a project chat
 * the model reads what it knows about the person first and what the team has
 * written down second. The wording says the notes are shared and may have been
 * written by someone else, so the model does not address them to the person it
 * is talking to.
 */
export async function buildProjectMemoryBlock(
	projectId: ObjectId,
	excludeConversationId?: ObjectId
): Promise<string | undefined> {
	const stored = withoutOwn(await listRows(projectScope(projectId)), excludeConversationId);
	return renderProjectMemoryBlock(stored.map((row) => row.text));
}

/** Pure, like `renderMemoryBlock`: the same text from a snapshot as from a live read. */
export function renderProjectMemoryBlock(texts: string[]): string | undefined {
	if (texts.length === 0) return undefined;
	const { included, omitted } = fitMemoriesToBudget(texts, PROJECT_MEMORY_BLOCK_MAX_CHARS);
	const lines = included.map((index) => `- ${texts[index]}`);
	const notice =
		omitted > 0
			? ` ${omitted} older ${omitted === 1 ? "note is" : "notes are"} stored but omitted here ` +
				"for length, so do not treat this list as everything the project has recorded."
			: "";

	return (
		"Project memory: notes kept by the members of this project, shared between all of them " +
		"and carried into every conversation in it. Any of them may have written any note. Use " +
		"them where they are relevant and ignore them where they are not; do not recite them " +
		`back or mention this list unless asked.${notice}\n\n${lines.join("\n")}`
	);
}

/** As `memoryContext`: never throws, because a worse answer beats none. */
export async function projectMemoryContext(
	projectId: ObjectId | undefined,
	excludeConversationId?: ObjectId
): Promise<string | undefined> {
	if (!projectId) return undefined;
	try {
		return await buildProjectMemoryBlock(projectId, excludeConversationId);
	} catch (err) {
		logger.warn({ err: String(err) }, "project_memory_context_degraded: answering without it");
		return undefined;
	}
}

// ---------------------------------------------------------------------------
// Chat notes
//
// Access is decided by the caller, as for a project: every function takes a
// conversation id it trusts the route (or the running turn) to have resolved
// with the conversation's own access rule (`resolveConversation`). A note id
// is only ever matched together with its conversation, so an id from another
// chat is a miss, not a leak.
// ---------------------------------------------------------------------------

export async function listConversationMemories(
	conversationId: ObjectId
): Promise<ConversationMemory[]> {
	return (await listRows(conversationScope(conversationId))) as ConversationMemory[];
}

export async function conversationMemoryViews(conversationId: ObjectId) {
	return (await listRows(conversationScope(conversationId))).map(viewOf);
}

export async function rememberForConversation(options: {
	conversationId: ObjectId;
	ownerUserId?: User["_id"];
	text: string;
	source: ConversationMemory["source"];
}): Promise<{ memory: ConversationMemory; created: boolean }> {
	const { row, created } = await rememberIn(
		conversationScope(options.conversationId, options.ownerUserId),
		options
	);
	return { memory: row as ConversationMemory, created };
}

export async function updateConversationMemory(
	conversationId: ObjectId,
	id: ObjectId,
	rawText: string
): Promise<ConversationMemory> {
	return (await updateIn(conversationScope(conversationId), id, rawText)) as ConversationMemory;
}

export async function deleteConversationMemory(
	conversationId: ObjectId,
	id: ObjectId
): Promise<boolean> {
	return deleteIn(conversationScope(conversationId), id);
}

export async function forgetForConversation(options: {
	conversationId: ObjectId;
	text: string;
}): Promise<ConversationMemory> {
	return (await forgetIn(
		conversationScope(options.conversationId),
		options.text
	)) as ConversationMemory;
}

/** Remove every note of a deleted chat, or of a set of them. */
export async function deleteConversationMemories(
	conversationId: ObjectId | ObjectId[]
): Promise<number> {
	const ids = Array.isArray(conversationId) ? conversationId : [conversationId];
	if (ids.length === 0) return 0;
	const { deletedCount } = await collections.conversationMemories.deleteMany({
		conversationId: { $in: ids },
	});
	return deletedCount;
}

/**
 * Notes whose chat is gone (a delete that failed after the chat itself went, or a chat removed by
 * another path): the daily orphan sweep removes them, as `deleteConversationStorage` promises.
 */
export async function sweepOrphanConversationNotes(): Promise<number> {
	const ids = (await collections.conversationMemories.distinct("conversationId")) as ObjectId[];
	let removed = 0;
	for (let i = 0; i < ids.length; i += 500) {
		const batch = ids.slice(i, i + 500);
		const live = new Set(
			(
				await collections.conversations
					.find({ _id: { $in: batch } })
					.project<{ _id: ObjectId }>({ _id: 1 })
					.toArray()
			).map((row) => row._id.toString())
		);
		const gone = batch.filter((id) => !live.has(id.toString()));
		if (gone.length > 0) removed += await deleteConversationMemories(gone);
	}
	return removed;
}

// ---------------------------------------------------------------------------
// Agent notes (galopin's memory tools)
//
// Only the machine-call handler and the code panel's routes call these, each
// having resolved the device to its owner first. They never touch the three
// chat scopes, and nothing on the chat's path touches them: separate
// collection, separate functions. The key is a session or a workspace id from
// that one computer.
// ---------------------------------------------------------------------------

export interface AgentNoteKey {
	userId: User["_id"];
	deviceId: string;
	scope: AgentMemoryScope;
	key: string;
}

export async function listAgentNotes(key: AgentNoteKey): Promise<AgentMemory[]> {
	return (await listRows(agentScope(key))) as AgentMemory[];
}

export async function agentNoteViews(key: AgentNoteKey) {
	return (await listRows(agentScope(key))).map(viewOf);
}

export async function rememberAgentNote(
	key: AgentNoteKey,
	options: { text: string; source: AgentMemory["source"] }
): Promise<{ memory: AgentMemory; created: boolean }> {
	const { row, created } = await rememberIn(agentScope(key), options);
	return { memory: row as AgentMemory, created };
}

export async function updateAgentNote(
	key: AgentNoteKey,
	id: ObjectId,
	rawText: string
): Promise<AgentMemory> {
	return (await updateIn(agentScope(key), id, rawText)) as AgentMemory;
}

export async function deleteAgentNote(key: AgentNoteKey, id: ObjectId): Promise<boolean> {
	return deleteIn(agentScope(key), id);
}

export async function forgetAgentNote(key: AgentNoteKey, text: string): Promise<AgentMemory> {
	return (await forgetIn(agentScope(key), text)) as AgentMemory;
}

/** A session's notes go with it. */
export async function deleteAgentSessionNotes(
	userId: User["_id"],
	deviceId: string,
	sessionId: string
): Promise<number> {
	const { deletedCount } = await collections.agentMemories.deleteMany({
		userId,
		deviceId,
		scope: "session",
		key: sessionId,
	});
	return deletedCount;
}

/** A workspace's notes go when the workspace is removed. */
export async function deleteAgentWorkspaceNotes(
	userId: User["_id"],
	deviceId: string,
	workspaceId: string
): Promise<number> {
	const { deletedCount } = await collections.agentMemories.deleteMany({
		userId,
		deviceId,
		scope: "workspace",
		key: workspaceId,
	});
	return deletedCount;
}

/** Every note of a computer that is no longer paired. */
export async function deleteAgentDeviceNotes(
	userId: User["_id"],
	deviceId: string
): Promise<number> {
	const { deletedCount } = await collections.agentMemories.deleteMany({ userId, deviceId });
	return deletedCount;
}
