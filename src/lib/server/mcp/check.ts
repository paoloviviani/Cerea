/**
 * Listing a connector's tools with its own credential, and recording the answer
 * on its row, so the row always says what it offers or why it does not.
 *
 * Used by the Check button, and automatically when an administrator adds a
 * connector or changes its address or credential: a connector whose tools were
 * never listed reads to the assistant as "its tools are listed when you load
 * it" and, with no tool names to go on, is rarely loaded at all.
 */

import type { ObjectId } from "mongodb";
import { collections } from "$lib/server/database";
import { logger } from "$lib/server/logger";
import type { McpConnector } from "$lib/types/McpConnector";
import { listTools } from "./health";
import { credentialHeaders } from "./selection";

export type CheckOutcome = "listed" | "failed" | "no credential";

/**
 * Tools on success, the server's error on failure: the one check that tells a
 * working key from a wrong one, which an anonymous probe cannot.
 *
 * Writes only `tools` (on success), `checkedAt`, `lastError` and `updatedAt`. Never throws
 * for a server that misbehaves: that is what `lastError` is for. "no
 * credential" (an OAuth connector nobody here has signed in to) writes nothing.
 */
export async function checkConnectorTools(
	connector: McpConnector,
	userId: ObjectId,
	/** Give up sooner than the default: the check an add or a save waits on. */
	timeoutMs?: number
): Promise<CheckOutcome> {
	const headers = await credentialHeaders({ connector, userId });
	if (!headers) return "no credential";
	let result: Awaited<ReturnType<typeof listTools>>;
	try {
		result = await listTools(connector.url, headers, timeoutMs);
	} catch (err) {
		logger.warn({ err: String(err), connector: connector.name }, "mcp_check_threw");
		result = {
			ok: false,
			error: err instanceof Error ? err.message : String(err),
			authRequired: false,
		};
	}
	await collections.mcpConnectors.updateOne(
		{ _id: connector._id },
		{
			$set: {
				checkedAt: new Date(),
				updatedAt: new Date(),
				// Names and descriptions only. An input schema is large, is
				// not shown, and would put arbitrary third-party JSON in a
				// document we read on every listing. A failed check keeps the
				// tools the last good one found: a server being down for a
				// minute must not make the assistant forget what it offers.
				...(result.ok
					? { tools: result.tools.map(({ name, description }) => ({ name, description })) }
					: { lastError: result.error.slice(0, 500) }),
			},
			// `$unset` rather than `$set: undefined`: the driver does not
			// drop undefined by default, so that writes a literal null and
			// the field stops matching its own `string | undefined` type.
			...(result.ok ? { $unset: { lastError: "" } } : {}),
		}
	);
	return result.ok ? "listed" : "failed";
}
