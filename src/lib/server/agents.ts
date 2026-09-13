/**
 * Agents, chat-side (ADR 0067).
 *
 * Everything here is the owner's own: the list is theirs, the edit is theirs,
 * the delete is theirs, and there is no sharing to check — an agent names a
 * principal kind of one, the person who made it. The two pieces that still
 * reach the gateway do so **as the user**, never as this application: the
 * knowledge-base search (retrieval runs with the reader's token, so an agent
 * can only ever offer passages its user could read themselves) and nothing
 * else. The model an agent points at is just a catalogue id; the gateway
 * stays the authority on whether that model may be used, and refuses at send
 * time as it would for a direct call.
 *
 * **Retrieval never fails a turn** — the projects rule, kept: an unreachable
 * base degrades to an ordinary answer, logged as `agent_retrieval_degraded`.
 */
import { ObjectId } from "mongodb";
import { collections } from "$lib/server/database";
import { logger } from "$lib/server/logger";
import { type GatewaySearchHit } from "$lib/server/gatewayServer";
import { callerFrom, searchBase, type Caller } from "$lib/server/knowledge/service";
import type { Agent } from "$lib/types/Agent";
import type { Conversation } from "$lib/types/Conversation";
import type { User } from "$lib/types/User";

/**
 * The agent this conversation is wrapped by.
 *
 * An agent is a passthrough wrapper on a plain model (ADR 0067, as clarified
 * 2026-09-13): the conversation's `model` is the underlying one, and the
 * wrapper contributes its system prompt and knowledge bases to each request.
 * The wrapper applies **live**, not as a snapshot — an agent whose prompt or
 * knowledge was edited changes what its existing conversations retrieve,
 * which is what "adds them to the request" means. A deleted agent is not an
 * error: the wrapper is gone and the conversation remains a plain chat.
 *
 * Ownership is inherent to the lookup — agents are per-user and shared with
 * nobody — so one person's conversation never reads another's agent.
 */
export async function resolveForConversation(
	agentId: NonNullable<Conversation["agentId"]>,
	userId: User["_id"]
): Promise<Agent | null> {
	return await collections.agents.findOne({ _id: agentId, userId });
}

export async function listForUser(userId: User["_id"]): Promise<Agent[]> {
	return await collections.agents.find({ userId }).sort({ updatedAt: -1 }).toArray();
}

async function nameTaken(userId: User["_id"], name: string): Promise<boolean> {
	return (await collections.agents.countDocuments({ userId, name })) > 0;
}

export async function create(
	userId: User["_id"],
	input: Omit<Agent, "_id" | "userId" | "createdAt" | "updatedAt">
): Promise<Agent> {
	const now = new Date();
	const agent: Agent = { ...input, userId, _id: new ObjectId(), createdAt: now, updatedAt: now };
	const result = await collections.agents.insertOne(agent);
	agent._id = result.insertedId;
	return agent;
}

export async function update(
	userId: User["_id"],
	id: ObjectId,
	patch: Partial<Omit<Agent, "_id" | "userId" | "createdAt">>
): Promise<Agent | null> {
	// Renaming is a re-key: the wire name carries the agent's name, so a
	// conversation still set to the old name would resolve to nothing. It is
	// the owner's call and the refusal says so.
	if (patch.name !== undefined) {
		const current = await collections.agents.findOne({ _id: id, userId });
		if (current && current.name !== patch.name && (await nameTaken(userId, patch.name))) {
			throw new AgentNameTaken(patch.name);
		}
	}
	const result = await collections.agents.findOneAndUpdate(
		{ _id: id, userId },
		{ $set: { ...patch, updatedAt: new Date() } },
		{ returnDocument: "after" }
	);
	return (result as unknown as { value: Agent | null })?.value ?? null;
}

export async function remove(userId: User["_id"], id: ObjectId): Promise<boolean> {
	const result = await collections.agents.deleteOne({ _id: id, userId });
	return result.deletedCount > 0;
}

export class AgentNameTaken extends Error {
	constructor(name: string) {
		super(`You already have an agent named "${name}".`);
	}
}

/**
 * The system-prompt addition for one turn with an agent: its instructions, and
 * whatever its knowledge bases offer for the question being asked.
 *
 * Appended after the agent's own prompt by the caller (the agent persona is
 * the point of the agent; the conversation's extras follow it), and `undefined`
 * when there is nothing to add — not an empty string, which would tell the
 * model there was material and it was blank.
 */
export async function agentContext(options: {
	agent: Agent;
	question: string;
	token: string | undefined;
	/** The generation's locals: who is asking, for the store's reach checks. */
	locals: App.Locals | undefined;
}): Promise<string | undefined> {
	const { agent, question, token, locals } = options;
	const parts: string[] = [];
	if (agent.system_prompt.trim()) parts.push(agent.system_prompt.trim());

	if (token && agent.knowledgeBaseIds.length > 0 && question.trim() && locals?.user) {
		// The caller is the reader: the store's reach checks run against this
		// person, and the query's embedding is metered to their token.
		const caller = await callerFrom(locals);
		const passages = await retrieve({
			bases: agent.knowledgeBaseIds,
			question,
			limit: agent.retrievalLimit,
			minScore: agent.retrievalMinScore,
			token,
			agentName: agent.name,
			caller,
		});
		if (passages.length > 0) {
			const rendered = passages
				.map((hit) => `## ${hit.title || "untitled"}\n${hit.text}`)
				.join("\n\n");
			parts.push(
				"The following passages come from this agent's knowledge. Use them where " +
					"they are relevant and say which one you used; ignore them where they are " +
					`not.\n\n${rendered}`
			);
		}
	}

	return parts.length > 0 ? parts.join("\n\n") : undefined;
}

async function retrieve(options: {
	bases: string[];
	question: string;
	limit: number;
	minScore: number;
	token: string;
	agentName: string;
	caller: Caller;
}): Promise<GatewaySearchHit[]> {
	const { bases, question, limit, minScore, token, agentName, caller } = options;
	const hits: GatewaySearchHit[] = [];
	for (const baseId of bases) {
		try {
			// The chat's own store, since ADR 0070: an in-process search, with the
			// query's embedding metered to this caller's token.
			const answer = await searchBase(baseId, caller, token, {
				query: question,
				max_num_results: limit,
				// Below the floor a passage is noise; the store scores, so the
				// filter is its parameter, spelled the way its search accepts.
				...(minScore > 0 ? { min_score: minScore } : {}),
			});
			hits.push(...answer.data);
		} catch (err) {
			logger.warn(
				{ err, agent: agentName, base: baseId },
				"agent_retrieval_degraded: answering without this base"
			);
		}
	}
	// Best first, then bounded across every base rather than per base — the
	// same arithmetic the projects retriever runs, for the same reason: the
	// cost of a prompt is the person's own.
	hits.sort((a, b) => b.score - a.score);
	return hits.slice(0, limit);
}
