import { createHash } from "node:crypto";
import type { ObjectId } from "mongodb";
import { logger } from "$lib/server/logger";
import { MCP_APP_FILE_TOOL, storeDeliverable } from "$lib/server/execution/deliverables";
import type { McpServerConfig } from "../httpClient";
import { getToolUiMeta } from "../tools";
import type { McpAppSnapshot } from "$lib/utils/mcpApp";
import { McpAppError, readUiResource } from "./resource";

export { MCP_APP_FILE_TOOL };

/**
 * The page a tool linked to (`_meta.ui.resourceUri`), read and kept for the card (docs/dev/adr-mcp-apps.md,
 * section 4): the reference the message stores, or nothing. **Never throws and never delays the tool's
 * result more than the read itself**: a page that cannot be had (no link, apps blocked, wrong type, too
 * large, the server unreachable) leaves the text result standing, as on a host that has no apps at all.
 */
export async function appSnapshotFor(input: {
	server: McpServerConfig;
	/** The MCP tool's own name. */
	tool: string;
	conversationId?: ObjectId;
	userId?: ObjectId;
	messageId?: string;
	signal?: AbortSignal;
}): Promise<McpAppSnapshot | undefined> {
	const { server, tool, conversationId, userId, messageId, signal } = input;
	// Without a key the page could not name its connector again, and without a conversation there is
	// nowhere to keep it.
	if (!server.key || !conversationId) return undefined;
	try {
		const { ui } = await getToolUiMeta(server, tool, { signal });
		if (!ui?.resourceUri) return undefined;
		const page = await readUiResource({ ...server, key: server.key }, ui.resourceUri, {
			userId,
			signal,
		});
		const bytes = Buffer.from(page.html, "utf8");
		const digest = createHash("sha256").update(bytes).digest("hex");
		const stored = await storeDeliverable({
			conversationId,
			userId,
			name: `mcp-app-${digest.slice(0, 12)}.html`,
			mime: "text/html",
			bytes,
			tool: MCP_APP_FILE_TOOL,
			// Recorded on the server: the routes read the connector back from here, never from the browser.
			appPage: { connector: server.key, uri: page.uri },
			messageId,
		});
		if (!stored.ok) {
			logger.info(
				{ connector: server.name, reason: stored.error },
				"[mcp-app] page not kept, the text result stands"
			);
			return undefined;
		}
		return {
			connector: server.key,
			server: server.name,
			tool,
			uri: page.uri,
			sha256: stored.ref.sha256,
			size: stored.ref.size,
			...(Object.keys(page.csp).length > 0 ? { csp: page.csp } : {}),
			...(page.prefersBorder !== undefined ? { prefersBorder: page.prefersBorder } : {}),
		};
	} catch (err) {
		if (err instanceof McpAppError && err.code === "not-allowed") return undefined;
		logger.info(
			{ connector: server.name, tool, err: err instanceof Error ? err.message : String(err) },
			"[mcp-app] no page for this result, the text result stands"
		);
		return undefined;
	}
}
