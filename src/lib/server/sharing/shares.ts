import { ObjectId } from "mongodb";
import { collections } from "$lib/server/database";
import { logger } from "$lib/server/logger";
import { collectArtifacts } from "$lib/utils/artifacts";
import type { Message } from "$lib/types/Message";
import type { User } from "$lib/types/User";
import {
	SHARE_EXPIRY_DAYS,
	type SharedArtifact,
	type SharedSnapshot,
	type ShareAudience,
} from "$lib/types/SharedArtifact";
import { hashShareToken, newShareToken, SHARE_TOKEN_PATTERN } from "./tokens";
import { sharingEnabled } from "./settings";

/** A text artifact is copied into its link; this keeps a row well under Mongo's 16 MB. */
export const MAX_SHARED_TEXT_BYTES = 4 * 1024 * 1024;
export const MAX_ACTIVE_SHARES_PER_USER = 200;

export class ShareError extends Error {
	constructor(
		readonly status: 400 | 403 | 404 | 409 | 413,
		message: string
	) {
		super(message);
	}
}

/** What the caller names to share: a text artifact by identifier, or a stored file by hash. */
export type ShareTarget =
	| { kind: "text"; identifier: string; version?: number }
	| { kind: "file"; name: string; sha256: string };

export type ShareStatus = "active" | "expired" | "revoked";

/** One link as the owner and the administrator see it. Never the token. */
export interface ShareListing {
	id: string;
	title: string;
	/** A text artifact's kind ("markdown", "html"...) or a file's MIME type. */
	type: string;
	kind: "text" | "file";
	/** A text artifact's identifier, or a file's name: how the panel finds its link. */
	artifactId: string;
	version?: number;
	conversationId: string;
	conversationTitle: string;
	audience: ShareAudience;
	expiresAt: string | null;
	status: ShareStatus;
	views: number;
	createdAt: string;
	updatedAt: string;
	ownerId: string;
	ownerName: string;
}

export function shareStatus(row: SharedArtifact, now = new Date()): ShareStatus {
	if (row.revokedAt) return "revoked";
	if (row.expiresAt && row.expiresAt.getTime() <= now.getTime()) return "expired";
	return "active";
}

export function toListing(row: SharedArtifact): ShareListing {
	const snapshot = row.snapshot;
	return {
		id: row._id.toString(),
		title: snapshot.kind === "text" ? snapshot.title : snapshot.name,
		type: snapshot.kind === "text" ? snapshot.type : snapshot.mime,
		kind: snapshot.kind,
		artifactId: row.artifactId,
		...(snapshot.version !== undefined ? { version: snapshot.version } : {}),
		conversationId: row.conversationId.toString(),
		conversationTitle: row.conversationTitle,
		audience: row.audience,
		expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
		status: shareStatus(row),
		views: row.views,
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
		ownerId: row.ownerId.toString(),
		ownerName: row.ownerName,
	};
}

export function expiryFromDays(days: number | null | undefined, now = new Date()): Date | null {
	if (days === null || days === undefined) return null;
	if (!(SHARE_EXPIRY_DAYS as readonly number[]).includes(days)) {
		throw new ShareError(400, "Choose 7, 30 or 90 days, or no expiry.");
	}
	return new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
}

function ownerDisplayName(user: Pick<User, "name" | "username">): string {
	return (user.name || user.username || "a user").slice(0, 80);
}

/** Audit events: who, what, when. Never content. */
function audit(event: string, fields: Record<string, unknown>): void {
	logger.info({ audit: "artifact_share", ...fields }, event);
}

/**
 * The frozen snapshot of a target, read from a conversation of the caller's.
 * A text artifact's versions are derived from the conversation's messages, so
 * the chosen version's content is copied; a file is referenced by its hash.
 */
async function snapshotOf(
	ownerId: ObjectId,
	conversationId: ObjectId,
	target: ShareTarget
): Promise<{ snapshot: SharedSnapshot; artifactId: string; conversationTitle: string }> {
	const conversation = await collections.conversations.findOne(
		{ _id: conversationId, userId: ownerId },
		{ projection: { title: 1, messages: { id: 1, from: 1, content: 1 } } }
	);
	if (!conversation) throw new ShareError(404, "No such artifact.");

	if (target.kind === "text") {
		const artifact = collectArtifacts(
			conversation.messages as Array<Pick<Message, "id" | "from" | "content">>
		).artifacts.get(target.identifier);
		const version =
			(target.version ? artifact?.versions[target.version - 1] : undefined) ??
			artifact?.versions.at(-1);
		if (!artifact || !version) throw new ShareError(404, "No such artifact.");
		if (Buffer.byteLength(version.content) > MAX_SHARED_TEXT_BYTES) {
			throw new ShareError(413, "This artifact is too large to share.");
		}
		return {
			artifactId: artifact.identifier,
			conversationTitle: conversation.title,
			snapshot: {
				kind: "text",
				type: version.type,
				title: version.title,
				...(version.language ? { language: version.language } : {}),
				version: version.version,
				content: version.content,
			},
		};
	}

	const row = await collections.codeExecutionOutputs.findOne({
		conversationId,
		sha256: target.sha256,
		name: target.name,
		// An MCP App's stored page is the card's, never something to share.
		tool: { $ne: "mcp_app" },
	});
	if (!row) throw new ShareError(404, "No such artifact.");
	return {
		artifactId: row.name,
		conversationTitle: conversation.title,
		snapshot: {
			kind: "file",
			name: row.name,
			mime: row.mime,
			size: row.size,
			sha256: row.sha256,
			...(row.version ? { version: row.version } : {}),
		},
	};
}

/** The newest version of the same artifact: a text artifact's last, a file name's current row. */
async function latestTarget(row: SharedArtifact): Promise<ShareTarget> {
	if (row.snapshot.kind === "text") {
		return { kind: "text", identifier: row.artifactId };
	}
	const [latest] = await collections.codeExecutionOutputs
		.aggregate<{ sha256: string; name: string }>([
			{ $match: { conversationId: row.conversationId, name: row.snapshot.name } },
			{ $addFields: { liveAt: { $ifNull: ["$latestAt", "$createdAt"] } } },
			{ $sort: { liveAt: -1, _id: -1 } },
			{ $limit: 1 },
		])
		.toArray();
	if (!latest) throw new ShareError(404, "That file is no longer stored.");
	return { kind: "file", name: latest.name, sha256: latest.sha256 };
}

export async function createShare(
	user: Pick<User, "_id" | "name" | "username">,
	input: {
		conversationId: ObjectId;
		target: ShareTarget;
		audience?: ShareAudience;
		expiryDays?: number | null;
	}
): Promise<{ id: string; token: string; listing: ShareListing }> {
	if (!(await sharingEnabled())) throw new ShareError(403, "Sharing is turned off.");
	const { snapshot, artifactId, conversationTitle } = await snapshotOf(
		user._id,
		input.conversationId,
		input.target
	);
	const now = new Date();
	const expiresAt = expiryFromDays(input.expiryDays, now);

	const active = await collections.sharedArtifacts
		.find({ ownerId: user._id, revokedAt: null })
		.project<Pick<SharedArtifact, "conversationId" | "artifactId" | "expiresAt">>({
			conversationId: 1,
			artifactId: 1,
			expiresAt: 1,
		})
		.toArray();
	const live = active.filter((r) => !r.expiresAt || r.expiresAt.getTime() > now.getTime());
	if (
		live.some((r) => r.conversationId.equals(input.conversationId) && r.artifactId === artifactId)
	) {
		throw new ShareError(409, "This artifact already has a link.");
	}
	if (live.length >= MAX_ACTIVE_SHARES_PER_USER) {
		throw new ShareError(409, "You have reached the limit of shared links. Revoke some first.");
	}

	const token = newShareToken();
	const row: SharedArtifact = {
		_id: new ObjectId(),
		tokenHash: hashShareToken(token),
		ownerId: user._id,
		ownerName: ownerDisplayName(user),
		conversationId: input.conversationId,
		conversationTitle,
		artifactId,
		snapshot,
		audience: input.audience ?? "signed_in",
		expiresAt,
		revokedAt: null,
		views: 0,
		createdAt: now,
		updatedAt: now,
	};
	await collections.sharedArtifacts.insertOne(row);
	audit("artifact_share_created", {
		share: row._id.toString(),
		user: user._id.toString(),
		conversation: input.conversationId.toString(),
		artifact: artifactId,
		audience: row.audience,
		expires: expiresAt?.toISOString() ?? null,
	});
	return { id: row._id.toString(), token, listing: toListing(row) };
}

export interface ShareChanges {
	audience?: ShareAudience;
	/** 7, 30, 90, or null for never; counted from now. */
	expiryDays?: number | null;
	/** Point the link at the artifact's latest version. */
	toLatest?: boolean;
	/** Mint a new token and retire the old one (the only way to see a link again). */
	rotate?: boolean;
}

export async function updateShare(
	user: Pick<User, "_id">,
	id: ObjectId,
	changes: ShareChanges
): Promise<{ listing: ShareListing; token?: string }> {
	if (!(await sharingEnabled())) throw new ShareError(403, "Sharing is turned off.");
	const row = await collections.sharedArtifacts.findOne({ _id: id, ownerId: user._id });
	if (!row || row.revokedAt) throw new ShareError(404, "No such link.");

	const now = new Date();
	const set: Partial<SharedArtifact> = { updatedAt: now };
	const touched: string[] = [];
	if (changes.audience !== undefined && changes.audience !== row.audience) {
		set.audience = changes.audience;
		touched.push("audience");
		// Each audience has its own address (signed-in links live on the app's path, anyone's
		// on the share host), and the token is only known when made: a new one gives the new URL.
		changes = { ...changes, rotate: true };
	}
	if (changes.expiryDays !== undefined) {
		set.expiresAt = expiryFromDays(changes.expiryDays, now);
		touched.push("expiry");
	}
	if (changes.toLatest) {
		const { snapshot, artifactId } = await snapshotOf(
			row.ownerId,
			row.conversationId,
			await latestTarget(row)
		);
		if (artifactId !== row.artifactId) throw new ShareError(404, "No such artifact.");
		set.snapshot = snapshot;
		touched.push("version");
	}
	let token: string | undefined;
	if (changes.rotate) {
		token = newShareToken();
		set.tokenHash = hashShareToken(token);
		touched.push("token");
	}
	await collections.sharedArtifacts.updateOne({ _id: row._id }, { $set: set });
	const next = { ...row, ...set } as SharedArtifact;
	audit("artifact_share_updated", {
		share: row._id.toString(),
		user: user._id.toString(),
		changed: touched,
	});
	return { listing: toListing(next), ...(token ? { token } : {}) };
}

/** Revoke one link: the owner's own, or any when `asAdmin`. A revoked link stays as a tombstone. */
export async function revokeShare(
	actor: { id: ObjectId; admin?: boolean },
	id: ObjectId
): Promise<boolean> {
	const filter = actor.admin ? { _id: id } : { _id: id, ownerId: actor.id };
	const now = new Date();
	const res = await collections.sharedArtifacts.updateOne(
		{ ...filter, revokedAt: null },
		{ $set: { revokedAt: now, updatedAt: now } }
	);
	if (res.modifiedCount === 0) return false;
	audit("artifact_share_revoked", {
		share: id.toString(),
		by: actor.id.toString(),
		admin: Boolean(actor.admin),
	});
	return true;
}

export async function listOwnShares(ownerId: ObjectId): Promise<ShareListing[]> {
	const rows = await collections.sharedArtifacts
		.find({ ownerId })
		.sort({ createdAt: -1 })
		.limit(500)
		.toArray();
	return rows.map(toListing);
}

export async function listAllShares(limit = 500): Promise<ShareListing[]> {
	const rows = await collections.sharedArtifacts
		.find({})
		.sort({ createdAt: -1 })
		.limit(limit)
		.toArray();
	return rows.map(toListing);
}

/**
 * The live link a token names, or null for an unknown, revoked or expired token,
 * and for every token while sharing is off (the rows stay, they just do not
 * resolve). All four answer alike, so a response never says which.
 */
export async function findActiveShare(token: string): Promise<SharedArtifact | null> {
	if (!SHARE_TOKEN_PATTERN.test(token)) return null;
	if (!(await sharingEnabled())) return null;
	const row = await collections.sharedArtifacts.findOne({ tokenHash: hashShareToken(token) });
	if (!row || shareStatus(row) !== "active") return null;
	return row;
}

const seenToday = new Map<string, number>();

/** Counts a view, roughly once per viewer per day: an in-process memory, so not exact. */
export async function countShareView(
	row: SharedArtifact,
	viewer: string,
	now = new Date()
): Promise<void> {
	const day = Math.floor(now.getTime() / 86_400_000);
	const key = `${row._id.toString()}:${viewer}`;
	if (seenToday.get(key) === day) return;
	if (seenToday.size > 50_000) seenToday.clear();
	seenToday.set(key, day);
	await collections.sharedArtifacts.updateOne({ _id: row._id }, { $inc: { views: 1 } });
	audit("artifact_share_viewed", { share: row._id.toString() });
}

/** A deleted conversation takes its links with it. */
export async function deleteConversationSharedArtifacts(
	conversationId: ObjectId | ObjectId[]
): Promise<void> {
	const ids = Array.isArray(conversationId) ? conversationId : [conversationId];
	if (ids.length === 0) return;
	const rows = await collections.sharedArtifacts
		.find({ conversationId: { $in: ids } })
		.project<{ _id: ObjectId }>({ _id: 1 })
		.toArray();
	if (rows.length === 0) return;
	await collections.sharedArtifacts.deleteMany({ _id: { $in: rows.map((r) => r._id) } });
	audit("artifact_share_deleted", { shares: rows.length, reason: "conversation_deleted" });
}
