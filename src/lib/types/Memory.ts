import type { ObjectId } from "mongodb";
import type { Timestamps } from "./Timestamps";
import type { User } from "./User";

/**
 * One short standing fact about a person, carried into every conversation.
 *
 * ## Why this is a list and not a vector store
 *
 * The chat already owns a retrieval pipeline — knowledge bases, documents,
 * chunks and vectors (ADR 0070) — and a project already indexes its finished
 * exchanges into one (`Project.memoryBaseId`). That is the corpus-scale
 * answer, and it is built. This is deliberately the other thing: a few dozen
 * short lines, injected **whole** on every turn, with no embedding call and
 * no ranking.
 *
 * The reason is not that retrieval is hard here; it is that retrieval is the
 * wrong tool at this size. Semantic search over forty sentences spends a
 * metered embedding per turn to decide which six of them to show, and gets it
 * wrong often enough to matter — the fact somebody needs is frequently the one
 * that does not resemble their question ("reply in Italian" never matches a
 * question about Postgres). Injecting all of them costs a few hundred tokens
 * and cannot miss. The implementations that have run longest converge on the
 * same conclusion: ChatGPT's saved memories are not vector-searched, and
 * Claude's memory tool has no embeddings at all.
 *
 * It also buys the property the Workspace tab is for. Because the whole list
 * goes in, **the tab shows exactly what the model sees**. A ranked subset
 * would make that screen a guess.
 *
 * The cost, stated because it is real: this does not scale. Past the block's
 * character budget the oldest facts stop being sent, silently from the
 * model's point of view (the tab says so). Somebody who wants a thousand
 * remembered things wants a knowledge base, and the chat has those.
 *
 * ## Provenance is kept, and it is not decoration
 *
 * `source` distinguishes a fact the model wrote from one the person typed.
 * They are not equally trustworthy and should not look identical on the
 * screen where you decide whether to delete one: "I inferred this about you"
 * and "you told me this" are different claims. `conversationId` records where
 * a model-written fact came from, so an odd entry can be traced back to the
 * exchange that produced it rather than merely deleted in puzzlement.
 */
export interface Memory extends Timestamps {
	_id: ObjectId;

	/**
	 * Whose memory this is. Owner-only, with no sharing: a standing fact about
	 * a person is the most personal thing this application stores, and every
	 * sharing design for it we could think of was worse than none.
	 */
	userId: User["_id"];

	/** The fact itself, one short sentence. */
	text: string;

	/**
	 * Who wrote it. `model` came from a `remember` call during a turn;
	 * `user` was typed on the Memory screen.
	 */
	source: "model" | "user";

	/**
	 * The conversation a `model`-written fact came from, so it can be traced
	 * back. Absent on hand-written facts, and on model-written ones whose
	 * conversation has since been deleted — a dangling id is not worth a
	 * cascade.
	 */
	conversationId?: ObjectId;
}

/** A memory as the browser sees it: ids as strings, dates as ISO. */
export interface MemoryView {
	id: string;
	text: string;
	source: "model" | "user";
	conversationId?: string;
	createdAt: string;
	updatedAt: string;
}

/**
 * One fact is a sentence, not a document. The cap is generous enough for a
 * compound preference ("prefers metric units, except for screen sizes") and
 * far too small for somebody to paste a transcript in and call it memory —
 * the failure mode worth designing against, because the whole list is sent
 * on every turn and one pasted page would crowd out everything else.
 */
export const MEMORY_TEXT_MAX_CHARS = 400;

/**
 * The ceiling on stored facts. Well above the block budget on purpose: going
 * over the budget quietly stops sending the oldest facts, which is
 * recoverable and visible on the Memory screen, whereas going over this
 * refuses the write. A hard refusal is the right answer only for runaway
 * accumulation — a model in a loop calling `remember` every turn — not for
 * somebody who has simply collected a lot.
 */
export const MEMORY_MAX_FACTS = 200;

/**
 * How much of the system prompt memory may occupy, in characters (~500
 * tokens at this app's rough three-characters-per-token working figure).
 *
 * A budget is needed because nothing else enforces one: `prepareFiles`
 * reserves a flat `PROMPT_OVERHEAD_TOKENS = 4_000` for the preprompt *and*
 * every tool schema, and never measures what actually goes in. An unbounded
 * memory block would eat that reserve and start silently costing
 * conversation history instead — a regression that surfaces as "the model
 * forgot what we said ten turns ago" and gets blamed on the model.
 *
 * Lives here rather than in the service because the Memory screen needs it
 * too: it is what the screen's "these are no longer being sent" line is
 * measured against, and the two must not drift.
 */
export const MEMORY_BLOCK_MAX_CHARS = 1500;
