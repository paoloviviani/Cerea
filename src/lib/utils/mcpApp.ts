/**
 * MCP Apps (ADR: docs/dev/adr-mcp-apps.md), the parts the server and the browser share: the extension
 * constants, how a tool's UI link is read, and the page's Content-Security-Policy and document.
 *
 * Pure and dependency-free so a client component and a server module use the same code: what the
 * server stored and what the browser enforces must never be built by two different readers.
 */

/** The extension identifier a client advertises at `initialize`. */
export const MCP_APP_EXTENSION_ID = "io.modelcontextprotocol/ui";

/** The one resource type a page may have. */
export const MCP_APP_MIME = "text/html;profile=mcp-app";

/** A page larger than this (HTML bytes) is not rendered; the tool's text result stands. */
export const MAX_APP_HTML_BYTES = 2 * 1024 * 1024;

/** How many origins one CSP directive may carry; a longer list is cut. */
const MAX_DOMAINS_PER_DIRECTIVE = 32;

/** What a resource declares it needs (`_meta.ui.csp`), as the spec names the keys. */
export interface McpAppCsp {
	connectDomains?: string[];
	resourceDomains?: string[];
	frameDomains?: string[];
	baseUriDomains?: string[];
}

/**
 * What the message keeps of a rendered page: a reference to the stored HTML, not the HTML. The tool's
 * input is the call's own arguments and its result is the result's own content, both already in the message.
 */
export interface McpAppSnapshot {
	/** The connector's key (`base:<name>`, `connector:<id>`, or a local one): what the server resolves again. */
	connector: string;
	/** The connector's name, for the cards. */
	server: string;
	/** The MCP tool that linked the page (its own name, not the model-facing one). */
	tool: string;
	/** The `ui://` address the HTML was read from. */
	uri: string;
	/** sha256 of the stored HTML, in the conversation's file store. */
	sha256: string;
	size: number;
	/** What the resource declared; validated again whenever a CSP is built from it. */
	csp?: McpAppCsp;
	prefersBorder?: boolean;
}

/** A tool's link to a page: `_meta.ui.resourceUri` (the old flat `_meta["ui/resourceUri"]` still counts). */
export interface ToolUiMeta {
	resourceUri?: string;
	/** Who may call the tool. Absent means both. */
	visibility?: Array<"model" | "app">;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A `ui://` address with something after the scheme, no longer than a URL ought to be. */
export function isUiResourceUri(value: unknown): value is string {
	return typeof value === "string" && value.length <= 2048 && /^ui:\/\/[^\s]+$/i.test(value);
}

/** Reads a tool's `_meta` for its page link and visibility. Anything malformed reads as absent. */
export function readToolUiMeta(meta: unknown): ToolUiMeta | undefined {
	if (!isRecord(meta)) return undefined;
	const ui = isRecord(meta.ui) ? meta.ui : undefined;
	const out: ToolUiMeta = {};
	const nested = ui?.resourceUri;
	const flat = meta["ui/resourceUri"];
	const uri = isUiResourceUri(nested) ? nested : isUiResourceUri(flat) ? flat : undefined;
	if (uri) out.resourceUri = uri;
	if (Array.isArray(ui?.visibility)) {
		const seen = (ui.visibility as unknown[]).filter(
			(v): v is "model" | "app" => v === "model" || v === "app"
		);
		out.visibility = [...new Set(seen)];
	}
	return out.resourceUri || out.visibility ? out : undefined;
}

/** Whether the model may be offered the tool (an app-only tool is not). */
export function visibleToModel(ui: ToolUiMeta | undefined): boolean {
	return !ui?.visibility || ui.visibility.includes("model");
}

/** Whether a page may call the tool. */
export function visibleToApp(ui: ToolUiMeta | undefined): boolean {
	return !ui?.visibility || ui.visibility.includes("app");
}

/** Resource MIME as the spec writes it, comparing the type and the `profile` parameter and nothing else. */
export function isMcpAppMime(mime: unknown): boolean {
	if (typeof mime !== "string") return false;
	const [type, ...params] = mime.split(";").map((part) => part.trim().toLowerCase());
	if (type !== "text/html") return false;
	return params.some((p) => p.replace(/\s+/g, "").replace(/"/g, "") === "profile=mcp-app");
}

// https or wss, an optional `*.` first label (then at least two more labels, so `*.com` never passes),
// an optional port. Nothing else: no path, no scheme-only source, no keyword, no quote or separator.
const DOMAIN_SOURCE =
	/^(?:https|wss):\/\/(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?::\d{1,5})?$/i;

/** Where Cerea itself is served (`location.origin`, the configured origin): a page may never be given it. */
export interface DomainOptions {
	ownOrigins?: string[];
}

function hostAndPort(source: string): { host: string; port: string } | undefined {
	const match = /^(?:https?|wss?):\/\/([^/:]+)(?::(\d+))?$/i.exec(source.trim());
	return match ? { host: match[1].toLowerCase(), port: match[2] ?? "" } : undefined;
}

/** Whether a declared source (possibly `*.` wildcard) would let the page reach one of Cerea's own origins. */
export function coversOwnOrigin(source: string, ownOrigins: string[]): boolean {
	const declared = hostAndPort(source.replace("://*.", "://"));
	if (!declared) return false;
	const wildcard = source.includes("://*.");
	return ownOrigins.some((origin) => {
		const own = hostAndPort(origin);
		if (!own) return false;
		const samePort =
			declared.port === own.port ||
			(declared.port === "" && (own.port === "" || own.port === "443" || own.port === "80")) ||
			(own.port === "" && (declared.port === "443" || declared.port === "80"));
		if (!samePort && !wildcard) return false;
		return wildcard
			? own.host === declared.host || own.host.endsWith("." + declared.host)
			: own.host === declared.host;
	});
}

/** Keeps the origins a CSP may carry, in order and without repeats; reports what it dropped. */
export function cleanDomains(
	list: unknown,
	options: DomainOptions = {}
): { kept: string[]; dropped: string[] } {
	const kept: string[] = [];
	const dropped: string[] = [];
	if (!Array.isArray(list)) return { kept, dropped };
	for (const raw of list) {
		if (typeof raw !== "string") {
			dropped.push(String(raw));
			continue;
		}
		const value = raw.trim();
		if (value.length > 253 || !DOMAIN_SOURCE.test(value)) {
			dropped.push(value.slice(0, 80));
			continue;
		}
		// A page that may reach this site's own origin could be handed one of its endpoints.
		if (coversOwnOrigin(value, options.ownOrigins ?? [])) {
			dropped.push(value);
			continue;
		}
		if (!kept.includes(value) && kept.length < MAX_DOMAINS_PER_DIRECTIVE) kept.push(value);
	}
	return { kept, dropped };
}

const CSP_KEYS = ["connectDomains", "resourceDomains", "frameDomains", "baseUriDomains"] as const;

/** A resource's declared CSP, reduced to the origins that pass validation. `dropped` is for the audit log. */
export function sanitizeAppCsp(
	declared: unknown,
	options: DomainOptions = {}
): { csp: McpAppCsp; dropped: string[] } {
	const csp: McpAppCsp = {};
	const dropped: string[] = [];
	if (!isRecord(declared)) return { csp, dropped };
	for (const key of CSP_KEYS) {
		const cleaned = cleanDomains(declared[key], options);
		dropped.push(...cleaned.dropped);
		if (cleaned.kept.length > 0) csp[key] = cleaned.kept;
	}
	return { csp, dropped };
}

/**
 * The page's Content-Security-Policy, from what the resource declared. Nothing declared gives the
 * spec's restrictive default (no network, inline script and style, `data:` images), plus no form posts;
 * declared origins are validated here again, so a stored value that was not clean never reaches a header.
 * `unsafe-eval` and `blob:` are not granted.
 */
export function buildMcpAppCsp(declared?: McpAppCsp | null, options: DomainOptions = {}): string {
	const { csp } = sanitizeAppCsp(declared ?? {}, options);
	const resource = csp.resourceDomains?.join(" ") ?? "";
	const withResource = (base: string) => (resource ? `${base} ${resource}` : base);
	return [
		"default-src 'none'",
		withResource("script-src 'unsafe-inline'"),
		withResource("style-src 'unsafe-inline'"),
		withResource("img-src data:"),
		withResource("media-src data:"),
		withResource("font-src data:"),
		`connect-src ${csp.connectDomains?.join(" ") || "'none'"}`,
		`frame-src ${csp.frameDomains?.join(" ") || "'none'"}`,
		"object-src 'none'",
		`base-uri ${csp.baseUriDomains?.join(" ") || "'none'"}`,
		"form-action 'none'",
	].join("; ");
}

function escapeAttribute(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/**
 * The page's document for the sandboxed iframe: the policy comes first, and the page's own markup is
 * concatenated after it, so nothing in the page can run before the policy applies (its `<!doctype>` and
 * repeated `<html>`/`<head>` tags are ignored or merged by the parser).
 */
export function buildMcpAppSrcdoc(
	html: string,
	declared?: McpAppCsp | null,
	options: DomainOptions = {}
): string {
	return (
		"<!doctype html><html><head>" +
		`<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(buildMcpAppCsp(declared, options))}">` +
		html
	);
}

/** The iframe's `sandbox`: scripts only (`form-action 'none'` makes `allow-forms` moot); never `allow-same-origin`, popups, downloads, modals or top navigation. */
export const MCP_APP_SANDBOX = "allow-scripts";
