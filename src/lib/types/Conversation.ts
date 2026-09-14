import type { ObjectId } from "mongodb";
import type { Message } from "./Message";
import type { PlanState } from "./Plan";
import type { Timestamps } from "./Timestamps";
import type { User } from "./User";
import type { Assistant } from "./Assistant";
import type { Project } from "./Project";

export interface Conversation extends Timestamps {
	_id: ObjectId;

	sessionId?: string;
	userId?: User["_id"];

	model: string;

	title: string;
	rootMessageId?: Message["id"];
	messages: Message[];

	meta?: {
		fromShareId?: string;
	};

	preprompt?: string;
	assistantId?: Assistant["_id"];

	/**
	 * The project this conversation belongs to, if any. Set at creation and
	 * never changed: a project supplies the standing context every turn is
	 * generated against, so moving a conversation between projects would make
	 * its earlier turns unreproducible.
	 */
	projectId?: Project["_id"];

	/**
	 * Message ids already written into the project's memory base, so a
	 * conversation revisited or branched does not index the same exchange
	 * twice. Only written when the project has `indexPastChats` on.
	 */
	indexedMessageIds?: string[];

	/**
	 * Knowledge bases attached to this conversation by hand, from the
	 * composer's upload menu. Used in addition to any bases the conversation's
	 * project carries, never instead of them, and validated at attach time
	 * against the attacher's own access — every later turn re-checks the
	 * reader's reach at retrieval, so a share revoked after attaching simply
	 * stops contributing passages.
	 */
	knowledgeBaseIds?: string[];

	userAgent?: string;

	/**
	 * Set when the conversation was started in ML Assistant mode. The mode is a
	 * property of the conversation, not of the tab that started it, so reopening
	 * one brings its composer strip back. Only ever written by builds that ship
	 * the feature (see `$lib/utils/mlAssistantFlag`).
	 */
	mlAssistant?: boolean;
	/** The user's web-search consent for this conversation (ADR 0058's plan). */
	webSearch?: boolean;

	/**
	 * Spaces this conversation's artifacts have been deployed to, keyed by the
	 * stable artifact `identifier`. Lets a re-deploy push a new commit to the same
	 * Space instead of creating a new one. Only Spaces created through this app's
	 * OAuth client are reachable (the `contribute-repos` scope), so every entry
	 * here maps to an app-created Space.
	 */
	deployedSpaces?: Record<string, DeployedSpace>;

	/**
	 * Written by the `update_plan` builtin tool with its own targeted `$set`, so
	 * the messages-only writes in the conversation route never clobber it.
	 */
	plan?: PlanState;

	/**
	 * Compute budget for ML Assistant conversations. Absent means no budget is
	 * enforced. Like `plan`, only ever written with targeted operators
	 * (`$push`/`$pull`/`$inc`/`$set` on its own paths) so the messages-only
	 * writes in the conversation route never clobber a concurrent reservation.
	 */
	mlBudget?: MlBudget;
}

/**
 * All amounts are integer micro-USD (1 USD = 1_000_000), matching the unit the
 * Hub's `GET /api/jobs/hardware` prices in, so reserve/settle arithmetic never
 * touches floats.
 */
export interface MlBudget {
	totalMicroUsd: number;
	/** Sum of settled actual costs. */
	spentMicroUsd: number;
	/** Open reservations, each holding its ceiling until settled or released. */
	reservations: MlBudgetReservation[];
}

export interface MlBudgetReservation {
	/** Idempotency key for the submitting tool call: `generationId:toolCallId`. */
	key: string;
	kind: "job" | "sandbox";
	flavor: string;
	/**
	 * Price frozen at reserve time and reused at settle, so a Hub price change
	 * mid-run cannot make the refund disagree with what was reserved.
	 */
	priceMicroUsdPerMinute: number;
	timeoutSeconds: number;
	/** Worst case for this submission: price × timeout, rounded up to the minute. */
	ceilingMicroUsd: number;
	createdAt: Date;
	/** Set once the submission response yielded a job id; unset means the job may never have started. */
	jobId?: string;
	namespace?: string;
}

export interface DeployedSpace {
	/** Full repo id, e.g. `username/my-artifact`. */
	repoId: string;
	createdAt: Date;
	/**
	 * Visibility the Space was created with, preserved so a recreate (after the
	 * user deleted the Space on the Hub) doesn't silently flip a private Space to
	 * public — the update modal hides the visibility control.
	 */
	private: boolean;
}
