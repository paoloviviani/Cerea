/**
 * Projects: access, standing context, and retrieval over their own past chats.
 *
 * Read `$lib/types/Project` first — it carries why a project lives here rather
 * than in the gateway, and why sharing is decided against the *viewer's* own
 * identity. This file is the machinery.
 *
 * ## Three things that are easy to get wrong
 *
 * **Retrieval runs as the viewer, never as the owner.** Every search goes
 * through the gateway with the reader's own token, so a project shared with a
 * colleague retrieves only from bases that colleague can already read. The
 * knowledge bases are named here by id and their access is not this
 * application's to decide.
 *
 * **Failure to retrieve does not fail the turn.** A base still indexing, an
 * embedding provider that is down, a base whose share was revoked — each of
 * these degrades to an ordinary answer, logged as `project_retrieval_degraded`.
 * The gateway makes the same judgement, for the same reason: a
 * slightly worse answer beats no answer. It is logged rather than silent
 * because "the assistant stopped using my documents" is otherwise undebuggable.
 *
 * **Indexing a conversation is idempotent by handle.** The transcript is
 * written under `source_ref = chat:conversation:<id>`, and re-posting that
 * handle replaces the document rather than adding another copy. A conversation
 * grows one turn at a time; without this a ten-turn thread would leave ten
 * overlapping transcripts in the base and every search would return all of
 * them.
 *
 * **The memory base belongs to the project, not to whoever spoke first.** It
 * is created owned by the project's owner, and read and written *as its own
 * owner* by everyone the project is shared with: a member's conversation is
 * in a workspace they were given, and "everyone who can see a project sees
 * every conversation in it" already holds for the transcripts. Nobody gets a
 * share on the base itself, so unsharing the project ends a member's access
 * to the memory with no second thing to revoke. Only the server ever sets
 * `Project.memoryBaseId`, which is what makes acting as the base's owner safe.
 */

import { ObjectId } from "mongodb";
import { error } from "@sveltejs/kit";
import { z } from "zod";
import { collections } from "$lib/server/database";
import { logger } from "$lib/server/logger";
import { gateway, type GatewayGroup, type GatewaySearchHit } from "$lib/server/gatewayServer";
import { knowledgeEnabled } from "$lib/server/knowledgeEnabled";
import { conversationSourceRef } from "$lib/server/knowledge/deleteDerived";
import {
	callerFrom,
	reachableStores,
	searchBase,
	type Caller,
} from "$lib/server/knowledge/service";
import type { Project, ProjectView } from "$lib/types/Project";
import type { Conversation } from "$lib/types/Conversation";
import type { Message } from "$lib/types/Message";
import type { User } from "$lib/types/User";

/** How a viewer is named in a share: their address, and their groups. */
export interface ViewerPrincipals {
	email?: string;
	groups: string[];
}

/**
 * The name a knowledge base travels under, since ADR 0070: one of this chat's
 * own store ids, 24 hex characters. It was a gateway uuid once, and the routes
 * still asking for that reject every base the Knowledge screen lists before
 * the project is even touched.
 */
export const knowledgeBaseId = z
	.string()
	.regex(/^[0-9a-f]{24}$/, "That knowledge base id is not one of this chat's store ids.");

/**
 * The viewer's own groups, as the gateway reports them for their token.
 *
 * `GET /v1/billing/groups` is the only group list a bearer token can read, and
 * it deliberately reports the caller's own memberships and nothing else
 * (ADR 0061). That is exactly enough to decide "is this project shared with a
 * group I am in", and it is why deciding it needs no privileged surface.
 *
 * An unreachable gateway yields no groups rather than an error: the effect is
 * that group-shared projects are briefly invisible, which is the safe
 * direction to fail.
 */
export async function viewerPrincipals(
	user: User | undefined,
	token: string | undefined
): Promise<ViewerPrincipals> {
	const principals: ViewerPrincipals = { groups: [] };
	if (user?.email) principals.email = user.email.toLowerCase();
	if (!token) return principals;
	try {
		const answer = await gateway.get<{ data: GatewayGroup[] }>(token, "billing/groups");
		principals.groups = answer.data.map((group) => group.name);
	} catch (err) {
		logger.info({ err }, "project_groups_unavailable: group-shared projects will not be listed");
	}
	return principals;
}

/** The Mongo clause matching projects shared with this viewer. */
function sharedClause(principals: ViewerPrincipals): Record<string, unknown>[] {
	const clauses: Record<string, unknown>[] = [];
	if (principals.email) {
		clauses.push({ shares: { $elemMatch: { kind: "user", email: principals.email } } });
	}
	if (principals.groups.length > 0) {
		clauses.push({
			shares: { $elemMatch: { kind: "group", name: { $in: principals.groups } } },
		});
	}
	return clauses;
}

/** Projects this person owns or has been given, newest activity first. */
export async function listProjects(
	userId: User["_id"],
	principals: ViewerPrincipals
): Promise<Project[]> {
	const clauses: Record<string, unknown>[] = [{ userId }, ...sharedClause(principals)];
	return collections.projects.find({ $or: clauses }).sort({ updatedAt: -1 }).limit(200).toArray();
}

export interface ProjectAccess {
	project: Project;
	owned: boolean;
}

/**
 * One project, if this person may see it.
 *
 * `null` for both "does not exist" and "not shared with you", deliberately: a
 * project id is guessable in the sense that any id is, and distinguishing the
 * two would confirm that somebody else's project exists.
 */
export async function projectAccess(
	id: string,
	userId: User["_id"],
	principals: ViewerPrincipals
): Promise<ProjectAccess | null> {
	if (!ObjectId.isValid(id)) return null;
	const project = await collections.projects.findOne({ _id: new ObjectId(id) });
	if (!project) return null;
	if (project.userId.equals(userId)) return { project, owned: true };
	const shared = project.shares.some((share) =>
		share.kind === "user"
			? principals.email !== undefined && share.email === principals.email
			: principals.groups.includes(share.name)
	);
	return shared ? { project, owned: false } : null;
}

/**
 * The project of a request, for a route open to everyone who can see it —
 * 401 without an account, 404 (never 403) for a project that is not theirs, as
 * `projectAccess` explains. Routes that only the owner may use check `owned`
 * themselves.
 */
export async function requireProjectAccess(
	locals: App.Locals,
	id: string | undefined
): Promise<ProjectAccess & { user: User }> {
	if (!locals.user) error(401, "Login required");
	const principals = await viewerPrincipals(locals.user, locals.token);
	const access = await projectAccess(id as string, locals.user._id, principals);
	if (!access) error(404, "No such project.");
	return { ...access, user: locals.user };
}

/**
 * The conversation's project, if the person running this turn may still see it.
 * The re-check behind everything the *members* write into the prompt (project
 * memory, context documents): reading a project's instructions after a share was
 * withdrawn is a stale convenience, but sending what other members wrote into a
 * former member's prompt is not. `undefined` rather than throwing: this is on
 * the generation path.
 */
export async function projectForMember(
	projectId: ObjectId | undefined,
	locals: App.Locals | undefined
): Promise<Project | undefined> {
	const user = locals?.user;
	if (!projectId || !user) return undefined;
	try {
		const project = await collections.projects.findOne({ _id: projectId });
		if (!project) return undefined;
		if (project.userId.equals(user._id)) return project;
		const principals = await viewerPrincipals(user, locals?.token);
		const access = await projectAccess(projectId.toString(), user._id, principals);
		return access?.project;
	} catch (err) {
		logger.warn({ err: String(err) }, "project_member_access_degraded: continuing without it");
		return undefined;
	}
}

/**
 * The conversation's project, if its project memory may be used this turn:
 * the deployment flag is on, the conversation belongs to a project, and the
 * person running it is still its owner or someone it is shared with.
 *
 * The membership re-check is what separates this from `projectContext`, which
 * trusts the conversation's `projectId`: reading a project's instructions after
 * a share was withdrawn is a stale convenience, but *writing* into every
 * member's prompt after it was withdrawn is not, and the block carries what
 * the other members wrote. One answer for both the block and the tools, so
 * they cannot disagree. `undefined` rather than throwing: this is on the
 * generation path.
 */
export async function projectForMemory(
	projectId: ObjectId | undefined,
	locals: App.Locals | undefined
): Promise<Project | undefined> {
	if (!projectId || !locals?.user) return undefined;
	const { memoryEnabled } = await import("$lib/server/memoryEnabled");
	if (!memoryEnabled()) return undefined;
	return projectForMember(projectId, locals);
}

export async function projectView(access: ProjectAccess): Promise<ProjectView> {
	const { project, owned } = access;
	const conversationCount = await collections.conversations.countDocuments({
		projectId: project._id,
	});
	return {
		id: project._id.toString(),
		name: project.name,
		description: project.description ?? "",
		instructions: project.instructions,
		knowledgeBaseIds: project.knowledgeBaseIds,
		indexPastChats: project.indexPastChats,
		hasMemory: Boolean(project.memoryBaseId),
		retrievalLimit: project.retrievalLimit,
		...(typeof project.defaultWebSearch === "boolean"
			? { defaultWebSearch: project.defaultWebSearch }
			: {}),
		...(Array.isArray(project.defaultMcpConnectorIds)
			? { defaultMcpConnectorIds: project.defaultMcpConnectorIds }
			: {}),
		owned,
		// Only the owner is shown the share list. Somebody a project was shared
		// with has no business reading who else it went to.
		shares: owned
			? project.shares.map((share) => ({
					kind: share.kind,
					principal: share.kind === "user" ? share.email : share.name,
				}))
			: [],
		conversationCount,
		updatedAt: project.updatedAt.toISOString(),
	};
}

/**
 * The system-prompt addition for one turn, built from the **five context
 * levels** of a project, always in this order:
 *
 * 1. **standing instructions** — in full;
 * 2. **context documents** — in full, every readable file the members attached;
 * 3. **project memory** — in full, the members' shared notes;
 * 4. **knowledge bases** — searched: passages from the project's bases, plus
 *    any attached to the conversation itself;
 * 5. **past chats** — searched: passages from the project's own earlier
 *    conversations, when it indexes them.
 *
 * The first three are sent whole on every turn and are paid for on every turn
 * (which is why documents have a budget); the last two are retrieved for the
 * question being asked. The order is part of the contract: what the project
 * *is* first, what its members *wrote down* next, what was *found* last. The
 * project page's explainer lists the same five, and `projectContext.spec`
 * asserts the order.
 *
 * Levels 2 and 3 are what members write into each other's prompts, so they
 * re-check that the person running the turn can still see the project
 * (`projectForMember`); level 1 trusts the conversation's `projectId`, as it
 * always has. A level that cannot be read logs and is skipped: a worse answer
 * beats none.
 *
 * The two searched levels are **additive**: a conversation's own bases join the
 * project's candidate pool, they never replace it, so a base attached from
 * the composer cannot silently switch off the standing context the
 * conversation's project was built around. They also share one retrieval
 * budget, bounded best-first across every base, for the reason the `retrieve`
 * comment states — the cost of a prompt is the person's own. The passages are
 * then rendered as two blocks, knowledge before past chats.
 *
 * `project` may be absent: a conversation attached to no project retrieves
 * from its own bases alone, at the same default limit a project would start
 * with.
 *
 * `undefined` when there is nothing to add. Not an empty string: an empty
 * context block tells a model there was material and it was blank, which is
 * worse than saying nothing.
 */
export const DEFAULT_RETRIEVAL_LIMIT = 6;

export async function projectContext(options: {
	/** The conversation's project, when it belongs to one. */
	project?: Project;
	/** Bases attached to the conversation itself, additive to the project's. */
	knowledgeBaseIds?: string[];
	question: string;
	token: string | undefined;
	/** The generation's locals: who is asking, for the store's reach checks. */
	locals: App.Locals | undefined;
}): Promise<string | undefined> {
	const { project, question, token, locals } = options;
	const parts: string[] = [];

	// 1. Standing instructions.
	if (project?.instructions.trim()) parts.push(project.instructions.trim());

	if (project) {
		// 2. Context documents.
		try {
			const { buildProjectDocumentsBlock } = await import("$lib/server/projectDocuments");
			const member = await projectForMember(project._id, locals);
			const block = member ? await buildProjectDocumentsBlock(member._id) : undefined;
			if (block) parts.push(block);
		} catch (err) {
			logger.warn({ err: String(err) }, "project_documents_degraded: answering without them");
		}

		// 3. Project memory (its own deployment flag, and its own try/catch).
		try {
			const member = await projectForMemory(project._id, locals);
			if (member) {
				const { projectMemoryContext } = await import("$lib/server/memory/service");
				const block = await projectMemoryContext(member._id);
				if (block) parts.push(block);
			}
		} catch (err) {
			logger.warn({ err: String(err) }, "[memory] project memory failed; continuing without it");
		}
	}

	const conversationBases = options.knowledgeBaseIds ?? [];
	// The memory base is searched only while the feature is on, so turning it
	// off stops retrieval without detaching anything a person attached by hand.
	const bases = [...(project?.knowledgeBaseIds ?? []), ...conversationBases];
	const memoryId = project?.indexPastChats ? project.memoryBaseId : undefined;
	if (memoryId) bases.push(memoryId);
	// Deduped: a base attached to both the project and the conversation must
	// not be searched twice — its passages would crowd the budget with copies.
	const uniqueBases = [...new Set(bases)];

	// The caller is the reader: reach checks run against this person, and the
	// query's embedding is metered to their token. No signed-in user means
	// nothing to check against and nothing to bill — no retrieval.
	if (token && uniqueBases.length > 0 && question.trim() && knowledgeEnabled() && locals?.user) {
		const caller = await callerFrom(locals);
		const passages = await retrieve({
			bases: uniqueBases,
			question,
			limit: project?.retrievalLimit ?? DEFAULT_RETRIEVAL_LIMIT,
			token,
			projectName: project?.name,
			caller,
			memory:
				project && memoryId
					? { baseId: memoryId, caller: await memoryCaller(memoryId, project) }
					: undefined,
		});
		const render = (hits: GatewaySearchHit[]) =>
			hits.map((hit) => `## ${hit.title || "untitled"}\n${hit.text}`).join("\n\n");

		// 4. Knowledge bases.
		const fromKnowledge = passages.filter((hit) => hit.baseId !== memoryId);
		if (fromKnowledge.length > 0) {
			// The conversation's own bases say "this conversation's knowledge":
			// with no project there is no project to name, and with both, the
			// project's bases belong to this conversation anyway.
			const source =
				conversationBases.length > 0 ? "this conversation's knowledge" : "this project's knowledge";
			parts.push(
				`The following passages come from ${source}. Use them where ` +
					"they are relevant and say which one you used; ignore them where they are " +
					`not.\n\n${render(fromKnowledge)}`
			);
		}

		// 5. Past chats.
		const fromPastChats = passages.filter((hit) => hit.baseId === memoryId);
		if (fromPastChats.length > 0) {
			parts.push(
				"The following passages come from this project's own past conversations. Use them " +
					"where they are relevant and say which one you used; ignore them where they are " +
					`not.\n\n${render(fromPastChats)}`
			);
		}
	}

	return parts.length > 0 ? parts.join("\n\n") : undefined;
}

/** A passage, and the base it came from — the split between levels 4 and 5. */
type RetrievedPassage = GatewaySearchHit & { baseId: string };

async function retrieve(options: {
	bases: string[];
	question: string;
	limit: number;
	token: string;
	projectName: string | undefined;
	caller: Caller;
	/** The project's memory base, read as its owner (see the header). */
	memory?: { baseId: string; caller: Caller | undefined };
}): Promise<RetrievedPassage[]> {
	const { bases, question, limit, token, projectName, caller, memory } = options;
	const hits: RetrievedPassage[] = [];
	// The chat's own store, since ADR 0070: an in-process search.
	for (const baseId of bases) {
		try {
			const answer = await searchBase(
				baseId,
				memory?.caller && baseId === memory.baseId ? memory.caller : caller,
				token,
				{ query: question, max_num_results: limit }
			);
			hits.push(...answer.data.map((hit) => ({ ...hit, baseId })));
		} catch (err) {
			logger.warn(
				{ err, project: projectName, base: baseId },
				"project_retrieval_degraded: answering without this base"
			);
		}
	}
	// Best first, then bounded across every base rather than per base: four
	// bases at a limit of six would otherwise put twenty-four passages in front
	// of the model, and the cost of a prompt is the person's own.
	hits.sort((a, b) => b.score - a.score);
	return hits.slice(0, limit);
}

/** A caller that is `ownerId` and nothing more: the memory base's own owner. */
function asOwner(ownerId: ObjectId): Caller {
	return { userId: ownerId, email: null, groups: [], isAdmin: false };
}

/**
 * The identity a project's memory base is read and written as: the project's
 * owner, and only for a base that owner owns. A base made before the base
 * belonged to the project is owned by whichever member spoke first; acting as
 * *them* on everyone's behalf would keep writing the whole project's
 * transcripts into one member's personal base, where they outlive that
 * member's place in the project. Such a legacy base yields `undefined`: the
 * writer replaces it, and a reader meets it only as themselves.
 */
async function memoryCaller(baseId: string, project: Project): Promise<Caller | undefined> {
	if (!ObjectId.isValid(baseId)) return undefined;
	const base = await collections.vectorStores.findOne(
		{ _id: new ObjectId(baseId) },
		{ projection: { ownerId: 1 } }
	);
	return base?.ownerId.equals(project.userId) ? asOwner(project.userId) : undefined;
}

/**
 * Write a conversation's exchange into its project's memory base.
 *
 * Called after a turn finishes, and it is deliberately not awaited by the
 * generation: a failure here must not cost somebody their answer. The whole
 * function is therefore its own try/catch; its outward sign is a log line and,
 * where the base exists, a `failed` document row in it — the same status and
 * the same place a failed file shows up.
 *
 * The base is created on demand and named after the project, because a base
 * called "Chat memory" in a list of a person's knowledge bases is a mystery.
 * It is an ordinary knowledge base, visible on the Knowledge screen, and that
 * is on purpose: the transcripts are in a store somebody can inspect, empty
 * and delete like any other.
 */
export async function indexConversation(options: {
	project: Project;
	conversation: Conversation;
	messages: Message[];
	token: string | undefined;
	/** The turn's locals: whose memory base this is, for ownership and reach. */
	locals: App.Locals | undefined;
}): Promise<void> {
	const { project, conversation, messages, token, locals } = options;
	// No pipeline, no memory: with the deployment switch off there is no store
	// to write to, and answering the turn never depended on this anyway.
	if (!project.indexPastChats || !token || !knowledgeEnabled()) return;

	if (!locals?.user) return;
	const sourceRef = conversationSourceRef(conversation._id);
	const title = conversation.title || "Untitled conversation";
	// Known once the base exists, so a failure can be put where the person
	// looks: the base's own document list.
	let failedInto: ObjectId | undefined;
	try {
		// The chat's own store, since ADR 0070: the memory base is created
		// here, owned by the *project's* owner whoever is talking, and written
		// in-process as its owner (see the header).
		const { createStore, addText } = await import("$lib/server/knowledge/service");
		let writer = project.memoryBaseId
			? await memoryCaller(project.memoryBaseId, project)
			: undefined;
		let baseId = project.memoryBaseId;
		if (!writer) {
			// Never made, deleted from the Knowledge screen ("safe to empty; it
			// refills as you talk"), or a legacy base some member owns: make one
			// the project's owner owns, and stop writing to the legacy one. The claim is conditional, so two
			// members finishing a first turn together end up with one base.
			const created = await createStore(asOwner(project.userId), {
				name: `${project.name} — past chats`,
				description:
					"Transcripts of this project's own conversations, written by the chat " +
					"and searched in later turns. Safe to empty; it refills as you talk.",
			});
			const claimed = await collections.projects.updateOne(
				{
					_id: project._id,
					memoryBaseId: project.memoryBaseId ?? { $exists: false },
				},
				{ $set: { memoryBaseId: created.id, updatedAt: new Date() } }
			);
			baseId = created.id;
			if (claimed.modifiedCount === 0) {
				const { deleteDerived } = await import("$lib/server/knowledge/deleteDerived");
				await deleteDerived({ storeIds: new ObjectId(created.id), dropStores: true });
				const current = await collections.projects.findOne({ _id: project._id });
				baseId = current?.memoryBaseId;
			}
			writer = baseId ? await memoryCaller(baseId, project) : undefined;
		}
		if (!baseId || !writer) throw new Error("The project has no memory base to write to.");
		failedInto = new ObjectId(baseId);

		// The whole thread, not the last turn: a transcript is only useful as
		// a unit, and `source_ref` makes rewriting it cheap and idempotent.
		const transcript = messages
			.filter((message) => message.from === "user" || message.from === "assistant")
			.map((message) => `${message.from === "user" ? "Asked" : "Answered"}: ${message.content}`)
			.filter((line) => line.length > 8)
			.join("\n\n");
		if (transcript.trim().length < 40) {
			// Nothing worth retrieving — and nothing worth keeping either: a
			// transcript shortened under the minimum (an edit, a message
			// delete) must not leave its longer predecessor retrievable.
			const { deleteDerived } = await import("$lib/server/knowledge/deleteDerived");
			await deleteDerived({ conversationId: conversation._id });
			return;
		}

		await addText(baseId, writer, token, { text: transcript, title, source_ref: sourceRef });

		// The conversation may have been deleted mid-index (the route deletes
		// the row before calling deleteDerived). Without this the write above
		// resurrects its transcript in the base.
		const gone = await collections.conversations.countDocuments(
			{ _id: conversation._id },
			{ limit: 1 }
		);
		if (gone === 0) {
			const { deleteDerived } = await import("$lib/server/knowledge/deleteDerived");
			await deleteDerived({ conversationId: conversation._id });
		}
	} catch (err) {
		logger.warn(
			{ err, project: project.name, conversation: conversation._id.toString() },
			"project_memory_index_failed: this exchange will not be retrievable"
		);
		// An ingest failure is already on the document's row; this is for the
		// rest (the write itself refused, the store unreachable).
		// Not for a conversation deleted mid-index: that would recreate a row
		// carrying its title.
		const stillThere = await collections.conversations.countDocuments(
			{ _id: conversation._id },
			{ limit: 1 }
		);
		if (failedInto && stillThere > 0) {
			const { markIndexFailed, KnowledgeError } = await import("$lib/server/knowledge/service");
			await markIndexFailed(
				failedInto,
				sourceRef,
				title,
				err instanceof KnowledgeError ? err.message : "Indexing this conversation failed."
			);
		}
	}
}

/**
 * Validate a client-supplied list of knowledge bases to attach to one
 * conversation, and hand back the ids — or `undefined` when the field was
 * absent, so an endpoint can tell "not sent" from "sent empty".
 *
 * The schema is the project create schema's (`knowledgeBaseId`, at most
 * twenty), and the access rule is stricter than a project create's in one
 * deliberate way: every id must name a base the *sender* can already read.
 * A project stores well-formed ids and leaves the checking to retrieval,
 * which is right for a one-time configuration — but an attach is a live
 * action on a list the picker has just shown, so storing an id that names
 * nothing would make every later turn retrieve from a base that is not
 * there, discoverable only through the degraded-retrieval log. Refusing
 * here turns that silent degradation into an error the person can act on.
 * Retrieval still re-checks the reader on every turn, so a share revoked
 * after attaching degrades exactly as a project's would.
 *
 * Attaching needs a signed-in account, like starting a conversation in a
 * project does: retrieval runs as the reader, and an anonymous session has
 * no reader to be.
 */
export async function parseAttachedKnowledgeBaseIds(
	value: unknown,
	locals: App.Locals
): Promise<string[] | undefined> {
	const parsed = z.array(knowledgeBaseId).max(20).optional().safeParse(value);
	if (!parsed.success) {
		error(400, parsed.error.issues[0]?.message ?? "Those knowledge bases are not valid.");
	}
	if (!parsed.data) return undefined;
	if (!parsed.data.length) return parsed.data;
	// The UI hides attaching when the pipeline is off, so a non-empty list
	// here names bases a deployment without a store cannot check — refuse
	// rather than storing ids every later turn would silently skip. 404, not
	// 400: the feature does not exist in this deployment.
	if (!knowledgeEnabled()) {
		error(404, "Knowledge bases are not enabled in this deployment.");
	}
	if (!locals.user) {
		error(401, "Knowledge bases need a signed-in account.");
	}
	const caller = await callerFrom(locals);
	try {
		await reachableStores(parsed.data, caller);
	} catch {
		error(400, "One of those knowledge bases is not available to you.");
	}
	return parsed.data;
}

/**
 * A conversation's attached bases as `{id, name}` pairs, in stored order,
 * for the composer's removable chips.
 *
 * Names resolve against the store as it exists now: a base deleted since it
 * was attached is simply left out of what the composer shows, while its id
 * stays on the conversation until the next attach or detach rewrites the
 * list — retrieval already skips it, logged.
 */
export async function knowledgeBaseViews(
	ids: string[] | undefined
): Promise<{ id: string; name: string }[]> {
	if (!ids || ids.length === 0) return [];
	const objectIds = ids.filter((id) => ObjectId.isValid(id)).map((id) => new ObjectId(id));
	if (objectIds.length === 0) return [];
	const rows = await collections.vectorStores
		.find({ _id: { $in: objectIds } }, { projection: { name: 1 } })
		.toArray();
	const names = new Map(rows.map((row) => [row._id.toString(), row.name]));
	return ids.filter((id) => names.has(id)).map((id) => ({ id, name: names.get(id) as string }));
}
