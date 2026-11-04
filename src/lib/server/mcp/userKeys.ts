/**
 * A user's own key for a connector the administrator published as "each user provides their
 * own key" (`auth: "user-key"`).
 *
 * Stored exactly where a per-user OAuth token is: one sealed `mcpTokens` row per
 * `(connectorId, userId)`. That row is already registered for identity merge and erasure
 * (`userKeyedCollections.ts`), removed when the connector or its address goes, and never sent to the
 * browser. The key is opened only by `bearerFor`, for the owner's own calls.
 */

import { ObjectId } from "mongodb";
import { collections } from "$lib/server/database";
import { logger } from "$lib/server/logger";
import type { McpConnector } from "$lib/types/McpConnector";
import { listTools } from "./health";
import { keyHeader } from "./selection";
import { seal } from "./secretBox";

/** How long saving a key waits for the tool listing that proves it works. */
const SAVE_CHECK_MS = 10_000;

export type KeyOutcome = "ok" | "refused" | "unchecked";

/** Store (or replace) this person's key. Clears any earlier refusal. */
export async function storeUserKey(
	connector: McpConnector,
	userId: ObjectId,
	key: string
): Promise<void> {
	const now = new Date();
	await collections.mcpTokens.updateOne(
		{ connectorId: connector._id, userId },
		{
			$set: { accessTokenSealed: seal(key), updatedAt: now },
			$unset: { refusedAt: "", refreshTokenSealed: "", expiresAt: "", scope: "" },
			$setOnInsert: { _id: new ObjectId(), connectorId: connector._id, userId, createdAt: now },
		},
		{ upsert: true }
	);
}

/**
 * List the tools with `key` and record what the server said on this person's row only: a
 * 401/403 marks the key refused. A success clears that, and fills the connector's tool list
 * when nothing has listed it yet (the first check anywhere seeds the shared catalogue; later
 * ones never replace it, since another user's key may see a different set).
 */
export async function checkUserKey(
	connector: McpConnector,
	userId: ObjectId,
	key: string,
	timeoutMs: number = SAVE_CHECK_MS
): Promise<KeyOutcome> {
	let result: Awaited<ReturnType<typeof listTools>>;
	try {
		result = await listTools(connector.url, keyHeader(connector, key), timeoutMs);
	} catch (err) {
		logger.warn({ err: String(err), connector: connector.name }, "mcp_user_key_check_threw");
		return "unchecked";
	}
	if (result.ok) {
		await collections.mcpTokens.updateOne(
			{ connectorId: connector._id, userId },
			{ $unset: { refusedAt: "" } }
		);
		if (!connector.tools?.length) {
			await collections.mcpConnectors.updateOne(
				{ _id: connector._id, "tools.0": { $exists: false } },
				{
					$set: {
						tools: result.tools.map(({ name, description }) => ({ name, description })),
						checkedAt: new Date(),
					},
				}
			);
		}
		return "ok";
	}
	if (result.authRequired) {
		await collections.mcpTokens.updateOne(
			{ connectorId: connector._id, userId },
			{ $set: { refusedAt: new Date() } }
		);
		return "refused";
	}
	return "unchecked";
}
