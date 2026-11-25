import { createHash } from "node:crypto";
import type { ObjectId } from "mongodb";
import { getClient, releaseClient, retainClient } from "../clientPool";
import { listMcpServerTools } from "../tools";
import { resolveConnectors } from "../turnConnectors";
import type { ResolvedServer } from "../selection";
import { logger } from "$lib/server/logger";
import {
	MAX_APP_HTML_BYTES,
	isMcpAppMime,
	isUiResourceUri,
	sanitizeAppCsp,
	type McpAppCsp,
} from "$lib/utils/mcpApp";
import { appsAllowedFor } from "../appsPolicy";

/** Why a page was not read; the tool's own result is never affected by it. */
export type McpAppErrorCode =
	"not-allowed" | "unknown-connector" | "bad-uri" | "unreadable" | "empty" | "mime" | "size";

export class McpAppError extends Error {
	constructor(
		readonly code: McpAppErrorCode,
		message: string
	) {
		super(message);
		this.name = "McpAppError";
	}
}

/** A page as read from its connector, validated and ready to store. */
export interface UiResource {
	uri: string;
	html: string;
	bytes: number;
	/** What the resource declared, cleaned: only origins that pass validation remain. */
	csp: McpAppCsp;
	/** Declared origins that failed validation (for the audit log, never rendered). */
	dropped: string[];
	prefersBorder?: boolean;
}

const READ_TIMEOUT_MS = 15_000;
const LISTING_TIMEOUT_MS = 5_000;
const CACHE_TTL_MS = 60_000;
const CACHE_MAX = 50;
const cache = new Map<string, { at: number; value: UiResource }>();

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `_meta.ui` of a content item or a listing entry. */
function uiMetaOf(entry: unknown): Record<string, unknown> | undefined {
	if (!isRecord(entry) || !isRecord(entry._meta)) return undefined;
	return isRecord(entry._meta.ui) ? entry._meta.ui : undefined;
}

/** A cache key that holds no credential: the headers go in as a hash. */
function cacheKey(server: ResolvedServer, uri: string, userId?: ObjectId): string {
	const headers = createHash("sha256")
		.update(JSON.stringify(Object.entries(server.headers ?? {}).sort()))
		.digest("hex")
		.slice(0, 16);
	return `${server.url}|${headers}|${userId?.toString() ?? ""}|${uri}`;
}

/**
 * The connector as a callable server, for this user, through the resolver a turn uses (ADR 0104):
 * on for them, signed in, and allowed to show apps. Local connectors arrive the same way.
 */
export async function resolveAppServer(
	connectorRef: string,
	userId: ObjectId | undefined
): Promise<ResolvedServer> {
	const { connectors } = await resolveConnectors(userId);
	const connector = connectors.find((c) => c.key === connectorRef);
	if (!connector) throw new McpAppError("unknown-connector", "That connector is not available.");
	// Apps are a signed-in feature: without a user the answer is no (the policy is per user).
	if (!userId || !(await appsAllowedFor(connectorRef, userId))) {
		throw new McpAppError("not-allowed", "Apps are not allowed for this connector.");
	}
	const opened = await connector.open();
	if (!("server" in opened)) throw new McpAppError("unknown-connector", opened.unavailable);
	return { ...opened.server, key: connectorRef };
}

/**
 * Reads a `ui://` page from a connector with the connector's own credential: `resources/read` over the
 * pooled client, then the checks that decide whether it may be rendered (scheme, MIME, size). The CSP it
 * declares (the content item first, the listing entry as the fallback, as the spec says) is cleaned here.
 *
 * `connector` is the connector's key, resolved for `userId` (so a local connector works the same way), or
 * a server the caller already resolved (it must carry its `key`, which `appsAllowedFor` is asked about).
 * Throws `McpAppError`; never touches the conversation.
 */
export async function readUiResource(
	connector: string | ResolvedServer,
	uri: string,
	{ userId, signal }: { userId?: ObjectId; signal?: AbortSignal } = {}
): Promise<UiResource> {
	if (!isUiResourceUri(uri))
		throw new McpAppError("bad-uri", "The page address is not a ui:// address.");
	let server: ResolvedServer;
	if (typeof connector === "string") {
		server = await resolveAppServer(connector, userId);
	} else {
		if (connector.key && (!userId || !(await appsAllowedFor(connector.key, userId)))) {
			throw new McpAppError("not-allowed", "Apps are not allowed for this connector.");
		}
		server = connector;
	}

	// Only a page a tool of this same connector names is ever read: never another URI or scheme.
	const declared = await listMcpServerTools(server, { signal }).catch(() => []);
	if (!declared.some((tool) => tool.ui?.resourceUri === uri)) {
		throw new McpAppError("bad-uri", "No tool of this connector links to that page.");
	}

	const key = cacheKey(server, uri, userId);
	const hit = cache.get(key);
	if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

	const client = await getClient(
		{ name: server.name, url: server.url, headers: server.headers },
		signal
	);
	retainClient(client);
	let result: Awaited<ReturnType<typeof client.readResource>>;
	let listingMeta: Record<string, unknown> | undefined;
	try {
		try {
			result = await client.readResource(
				{ uri },
				{ ...(signal ? { signal } : {}), timeout: READ_TIMEOUT_MS }
			);
		} catch (err) {
			throw new McpAppError(
				"unreadable",
				`The page could not be read: ${err instanceof Error ? err.message : String(err)}`
			);
		}
		const contents = Array.isArray(result?.contents) ? result.contents : [];
		const item = (contents.find((c) => c?.uri === uri) ?? contents[0]) as
			(Record<string, unknown> & { uri?: string }) | undefined;
		if (!item) throw new McpAppError("empty", "The connector returned no page.");
		if (!isMcpAppMime(item.mimeType)) {
			throw new McpAppError(
				"mime",
				"The resource is not an MCP App page (text/html;profile=mcp-app)."
			);
		}
		// The listing entry is only asked for when the content item declared no CSP of its own.
		if (!uiMetaOf(item)?.csp) {
			listingMeta = await client
				.listResources({}, { ...(signal ? { signal } : {}), timeout: LISTING_TIMEOUT_MS })
				.then((listing) => uiMetaOf(listing.resources?.find((r) => r.uri === uri)))
				.catch(() => undefined);
		}
		const html = decodePage(item);
		const meta = { ...listingMeta, ...uiMetaOf(item) };
		const { csp, dropped } = sanitizeAppCsp(meta.csp, {
			ownOrigins: process.env.ORIGIN ? [process.env.ORIGIN] : [],
		});
		if (dropped.length > 0) {
			logger.warn(
				{ connector: server.name, uri, dropped },
				"[mcp-app] dropped invalid CSP origins"
			);
		}
		const value: UiResource = {
			uri,
			html,
			bytes: Buffer.byteLength(html, "utf8"),
			csp,
			dropped,
			...(typeof meta.prefersBorder === "boolean" ? { prefersBorder: meta.prefersBorder } : {}),
		};
		cache.set(key, { at: Date.now(), value });
		while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string);
		logger.info(
			{ connector: server.name, uri, bytes: value.bytes, csp: value.csp },
			"[mcp-app] page read"
		);
		return value;
	} finally {
		releaseClient(client);
	}
}

/** The page's text from `text` or a base64 `blob`, size-checked before anything is decoded. */
function decodePage(item: Record<string, unknown>): string {
	if (typeof item.text === "string") {
		if (Buffer.byteLength(item.text, "utf8") > MAX_APP_HTML_BYTES) {
			throw new McpAppError("size", "The page is larger than the 2 MiB limit.");
		}
		if (item.text.trim() === "") throw new McpAppError("empty", "The page is empty.");
		return item.text;
	}
	if (typeof item.blob === "string") {
		if (Math.floor((item.blob.length * 3) / 4) > MAX_APP_HTML_BYTES + 3) {
			throw new McpAppError("size", "The page is larger than the 2 MiB limit.");
		}
		const buffer = Buffer.from(item.blob, "base64");
		if (buffer.byteLength > MAX_APP_HTML_BYTES) {
			throw new McpAppError("size", "The page is larger than the 2 MiB limit.");
		}
		let text: string;
		try {
			text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
		} catch {
			throw new McpAppError("empty", "The page is not valid UTF-8 text.");
		}
		if (text.trim() === "") throw new McpAppError("empty", "The page is empty.");
		return text;
	}
	throw new McpAppError("empty", "The connector returned no page content.");
}

/** For tests: forget what was read. */
export function resetUiResourceCache(): void {
	cache.clear();
}
