import type { ObjectId } from "mongodb";
import type { Timestamps } from "./Timestamps";
import type { User } from "./User";

/**
 * An agent, chat-side since ADR 0067.
 *
 * An agent used to live in the gateway, addressed as `agent:<name>` on
 * `/v1/models`, so that any OpenAI-compatible client could pick one without
 * knowing what it was. The decision that moved it here reverses that premise:
 * agents are a *chat* construction — assembled from this application's model
 * picker, applied in this application's generation loop, owned by the person
 * who made them, and shared with nobody — so the gateway no longer knows they
 * exist, and the name it used to serve as a model is now an agreement between
 * this application's picker and its own pipeline.
 *
 * The shape is the gateway's old one, minus sharing and minus the gateway's
 * ownership columns. What an agent still is not: a provider, a price, or a
 * metering path. The turn is billed against `model` exactly as a direct call
 * would be; what the agent changes is the payload — the system prompt and the
 * passages its knowledge bases contribute — and both land in the prompt the
 * gateway meters.
 */
export interface Agent extends Timestamps {
	_id: ObjectId;

	/** The owner. Only they see, use, edit or delete it — no sharing. */
	userId: User["_id"];

	/** Unique per owner; becomes the wire name `agent:<name>`. */
	name: string;
	description?: string;

	/** A chat model's id from the catalogue — never another agent. */
	model: string;
	system_prompt: string;

	/** Gateway knowledge base ids. Access re-checked per turn, as ever. */
	knowledgeBaseIds: string[];

	/** How many passages retrieval may put in front of the model per turn. */
	retrievalLimit: number;

	/** Below this similarity a passage is noise, not context. */
	retrievalMinScore: number;
}
