import { createHash, randomUUID } from "node:crypto";
import type { ObjectId } from "mongodb";
import { collections } from "$lib/server/database";

/** How long an issued approval may wait for the user's click. */
export const PAGE_APPROVAL_TTL_MS = 2 * 60_000;

function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonical);
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([k, v]) => [k, canonical(v)])
		);
	}
	return value;
}

/** What an approval is bound to: the user, the connector, the tool and the exact arguments. */
export function approvalHash(input: {
	userId?: ObjectId;
	connector: string;
	tool: string;
	args: Record<string, unknown>;
}): string {
	return createHash("sha256")
		.update(
			JSON.stringify(
				canonical({
					u: input.userId?.toString() ?? "",
					c: input.connector,
					t: input.tool,
					a: input.args,
				})
			)
		)
		.digest("hex");
}

/**
 * Issues the one approval a page's call may wait on. At most one is pending per conversation: while one
 * is, another page call is refused, so a page cannot stack cards or keep asking. Expired ones are cleared first.
 */
export async function issueApproval(
	conversationId: ObjectId,
	hash: string,
	now = new Date()
): Promise<{ ok: true; id: string } | { ok: false }> {
	await collections.conversations.updateOne(
		{ _id: conversationId },
		{ $pull: { appApprovals: { exp: { $lte: now } } } }
	);
	const id = randomUUID();
	const result = await collections.conversations.updateOne(
		{ _id: conversationId, "appApprovals.0": { $exists: false } },
		{
			$push: {
				appApprovals: { id, hash, exp: new Date(now.getTime() + PAGE_APPROVAL_TTL_MS) },
			},
		}
	);
	return result.modifiedCount === 1 ? { ok: true, id } : { ok: false };
}

/** Spends an approval: true once, only for the call it was issued for, only before it expires. */
export async function consumeApproval(
	conversationId: ObjectId,
	id: string,
	hash: string,
	now = new Date()
): Promise<boolean> {
	const result = await collections.conversations.updateOne(
		{ _id: conversationId, appApprovals: { $elemMatch: { id, hash, exp: { $gt: now } } } },
		{ $pull: { appApprovals: { id } } }
	);
	return result.modifiedCount === 1;
}
