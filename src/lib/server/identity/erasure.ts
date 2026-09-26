/**
 * Delete a person, everywhere in the chat (ADR 0093 §9.2, §9.3): the gateway
 * calls `POST /internal/erasure` (and, for the confirmation dialog, `POST
 * /internal/erasure/preview`) with its own service credential
 * (`CHAT_ERASURE_TOKEN`) after it has erased its own rows and inserted a
 * `pending` `chat_erasures` row, retrying with backoff until the chat
 * confirms. Both endpoints live under `/internal/*` — never reachable from
 * the edge (the routes themselves refuse a proxy header; the Caddyfile's own
 * 404 for that path is cerea-deploy's half).
 *
 * **Resolving "the person".** Not just `gatewayUserId == gateway_user_id`:
 * also every unkeyed legacy account the gateway's `identities` names
 * (`gatewayLogin.ts`'s `findStrays`, the same query the login callback and
 * the session check's background fold use), and — a crash-safety edge case
 * — any account still mid-merge (`mergedInto` set, row not yet deleted) into
 * one of those. Every collection entry then runs once per resolved id.
 *
 * **Idempotent and resumable**, via the `erasures` collection keyed by
 * `erasure_id`: a repeat after `doneAt` returns the recorded counts without
 * doing anything; a first call (or a resume after a crash) resolves — or
 * reloads — the person's user ids, conversation ids and device ids *before*
 * deleting anything, exactly the order the design requires, so a
 * conversation-keyed collection (and the live-link close-out) can still be
 * swept correctly even after the conversations and devices themselves are
 * gone. Every registry `erase` is itself a delete-by-owner, so a resumed
 * pass is safe to simply redo; the `counts` this run's response (and the
 * stored record) reports are this pass's own totals, not a sum across a
 * crash and its resume — the design's safety property is "nothing is missed
 * and nothing errors", not a perfectly provenanced running tally, and nothing
 * left to redo means the totals below are already the true final ones.
 */
import { ObjectId } from "mongodb";

import { collections } from "$lib/server/database";
import { logger } from "$lib/server/logger";
import { dropMachineConnection } from "$lib/server/code/machines";
import { ReviewStatus } from "$lib/types/Review";
import type { ProjectShare } from "$lib/types/Project";
import type { VectorStoreShare } from "$lib/types/VectorStore";
import { findStrays } from "./gatewayLogin";
import {
	type EraseContext,
	previewErasureCounts,
	USER_KEYED_COLLECTIONS,
} from "./userKeyedCollections";

export interface IdentityRef {
	issuer: string;
	subject: string;
}

/** Every chat user row this gateway identity's erasure (or preview) touches:
 * the resolved target, any legacy stray never folded in via a login, and
 * anyone still mid-merge into one of those. */
export async function resolvePersonUserIds(
	gatewayUserId: string,
	identities: IdentityRef[]
): Promise<ObjectId[]> {
	const ids = new Map<string, ObjectId>();
	const target = await collections.users.findOne({ gatewayUserId });
	if (target) ids.set(target._id.toString(), target._id);
	const strays = await findStrays(collections.users, [], identities);
	for (const stray of strays) ids.set(stray._id.toString(), stray._id);
	if (ids.size > 0) {
		const midMerge = await collections.users
			.find({ mergedInto: { $in: [...ids.values()] } })
			.toArray();
		for (const row of midMerge) ids.set(row._id.toString(), row._id);
	}
	return [...ids.values()];
}

async function conversationIdsFor(userIds: ObjectId[]): Promise<ObjectId[]> {
	if (userIds.length === 0) return [];
	return collections.conversations
		.find({ userId: { $in: userIds } })
		.project<{ _id: ObjectId }>({ _id: 1 })
		.toArray()
		.then((rows) => rows.map((r) => r._id));
}

async function deviceIdsFor(userIds: ObjectId[]): Promise<ObjectId[]> {
	if (userIds.length === 0) return [];
	return collections.codeDevices
		.find({ userId: { $in: userIds } })
		.project<{ _id: ObjectId }>({ _id: 1 })
		.toArray()
		.then((rows) => rows.map((r) => r._id));
}

/** One resource of the person that someone else can see, named, with who can
 * see it — the confirmation dialog's "shared with others" section (ADR 0093
 * §9.2: "every resource of the user that someone else can see, named, with
 * who can see it"). Four sources, each only while it actually has an
 * audience: a share-link row always does (its whole purpose is the link);
 * a project or knowledge base only when its own `shares` list is non-empty;
 * an assistant only once `review` is `APPROVED` — this fork wires no
 * publish/browse route for assistants, but the field is the only fact this
 * codebase has for "everyone can see it", so an approved row is read as
 * published rather than inventing a second flag for the same thing. */
export interface SharedResource {
	kind: "shared_conversation" | "project" | "knowledge_base" | "assistant";
	id: string;
	title: string;
	audience: string;
}

/** `shares: {kind: "user"|"group", ...}[]` names exactly who was invited —
 * never how many people that resolves to, since resolving a group's
 * membership would mean asking the gateway "who is in group X" on a bearer
 * token, which nothing in this codebase does (`Project.ts`'s own docs on
 * this). A person-only list can be counted; a group's true reach cannot, so
 * a share list including a group is reported as "everyone" rather than
 * printing a person-count this codebase cannot stand behind. */
function audienceFor(shares: Pick<ProjectShare | VectorStoreShare, "kind">[]): string {
	if (shares.some((share) => share.kind === "group")) return "everyone";
	return `${shares.length} ${shares.length === 1 ? "person" : "people"}`;
}

async function sharedResourcesFor(userIds: ObjectId[]): Promise<SharedResource[]> {
	if (userIds.length === 0) return [];
	const resources: SharedResource[] = [];

	const links = await collections.sharedConversations
		.find({ userId: { $in: userIds } })
		.project<{ _id: string; title: string }>({ _id: 1, title: 1 })
		.toArray();
	for (const row of links) {
		resources.push({
			kind: "shared_conversation",
			id: row._id,
			title: row.title,
			audience: "anyone with the link",
		});
	}

	const projects = await collections.projects
		.find({ userId: { $in: userIds }, "shares.0": { $exists: true } })
		.project<{ _id: ObjectId; name: string; shares: ProjectShare[] }>({
			_id: 1,
			name: 1,
			shares: 1,
		})
		.toArray();
	for (const row of projects) {
		resources.push({
			kind: "project",
			id: row._id.toString(),
			title: row.name,
			audience: audienceFor(row.shares),
		});
	}

	const bases = await collections.vectorStores
		.find({ ownerId: { $in: userIds }, "shares.0": { $exists: true } })
		.project<{ _id: ObjectId; name: string; shares: VectorStoreShare[] }>({
			_id: 1,
			name: 1,
			shares: 1,
		})
		.toArray();
	for (const row of bases) {
		resources.push({
			kind: "knowledge_base",
			id: row._id.toString(),
			title: row.name,
			audience: audienceFor(row.shares),
		});
	}

	const assistants = await collections.assistants
		.find({ createdById: { $in: userIds }, review: ReviewStatus.APPROVED })
		.project<{ _id: ObjectId; name: string }>({ _id: 1, name: 1 })
		.toArray();
	for (const row of assistants) {
		resources.push({
			kind: "assistant",
			id: row._id.toString(),
			title: row.name,
			audience: "everyone",
		});
	}

	return resources;
}

export interface ErasurePreview {
	counts: Record<string, number>;
	/** A caveat, not a per-person count: shares made before
	 * `SharedConversation.userId` existed that the startup backfill could not
	 * attribute to anyone (`database.ts`'s `backfillLegacySharedConversationOwners`)
	 * — the orchestrator's decision that the preview surface this whenever
	 * any exist, system-wide, since they can never be tied to a person by
	 * this or any later run. */
	unattributedLegacyShares: number;
	/** Named and audienced, per `SharedResource`'s own doc comment. */
	shared: SharedResource[];
}

export async function previewErasure(
	gatewayUserId: string,
	identities: IdentityRef[]
): Promise<ErasurePreview> {
	const userIds = await resolvePersonUserIds(gatewayUserId, identities);
	const conversationIds = await conversationIdsFor(userIds);
	const ctx: EraseContext = { conversationIds };

	const counts: Record<string, number> = {};
	for (const entry of USER_KEYED_COLLECTIONS) counts[entry.name] = 0;
	for (const userId of userIds) {
		const perUser = await previewErasureCounts(userId, ctx);
		for (const [name, n] of Object.entries(perUser)) counts[name] = (counts[name] ?? 0) + n;
	}
	counts.users = userIds.length;

	const unattributedLegacyShares = await collections.sharedConversations.countDocuments({
		userId: { $exists: false },
	});

	const shared = await sharedResourcesFor(userIds);

	return { counts, unattributedLegacyShares, shared };
}

export interface ErasureResult {
	erasureId: string;
	counts: Record<string, number>;
}

export async function runErasure(
	erasureId: string,
	gatewayUserId: string,
	identities: IdentityRef[]
): Promise<ErasureResult> {
	let record = await collections.erasures.findOne({ _id: erasureId });
	if (record?.doneAt) {
		return { erasureId, counts: record.counts };
	}

	if (!record) {
		const userIds = await resolvePersonUserIds(gatewayUserId, identities);
		const conversationIds = await conversationIdsFor(userIds);
		const deviceIds = await deviceIdsFor(userIds);
		const toInsert = {
			_id: erasureId,
			gatewayUserId,
			identities,
			userIds: userIds.map((id) => id.toString()),
			conversationIds: conversationIds.map((id) => id.toString()),
			deviceIds: deviceIds.map((id) => id.toString()),
			startedAt: new Date(),
			doneAt: null,
			counts: {},
		};
		await collections.erasures.insertOne(toInsert);
		record = toInsert;
	}

	const userIds = record.userIds.map((id) => new ObjectId(id));
	const ctx: EraseContext = {
		conversationIds: record.conversationIds.map((id) => new ObjectId(id)),
	};

	// Close live links before (not after) the registry runs: a device row
	// mid-delete is still enough to identify and drop its connection, and a
	// live socket left open a few seconds longer than necessary is a smaller
	// problem than one this run forgets because a later step threw.
	for (const deviceId of record.deviceIds) {
		dropMachineConnection(deviceId, 4403, "this account was erased");
	}

	const counts: Record<string, number> = {};
	for (const entry of USER_KEYED_COLLECTIONS) counts[entry.name] = 0;
	for (const userId of userIds) {
		for (const entry of USER_KEYED_COLLECTIONS) {
			counts[entry.name] += await entry.erase(userId, ctx);
		}
	}

	// The account row itself, last: everything it owned is already gone, and
	// nothing above reads `users` again. Not a USER_KEYED_COLLECTIONS entry
	// (that registry is for a person's *content*, not the account), but
	// leaving a bare row behind — name, hfUserId, gatewayUserId — after
	// erasing everything else would keep exactly the identifying fact the
	// erasure exists to remove. The design's own "Removed" list (§9.2) does
	// not spell this line item out; flagged in the report for confirmation.
	let usersDeleted = 0;
	if (userIds.length > 0) {
		const { deletedCount } = await collections.users.deleteMany({ _id: { $in: userIds } });
		usersDeleted = deletedCount;
	}
	counts.users = usersDeleted;

	await collections.erasures.updateOne(
		{ _id: erasureId },
		{ $set: { doneAt: new Date(), counts } }
	);

	logger.info({ erasureId, gatewayUserId, counts }, "chat_user_erased");

	return { erasureId, counts };
}
