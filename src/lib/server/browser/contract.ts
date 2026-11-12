/**
 * The browser runtime contract (ADR 0116 §2): what the runtime on a user's machine speaks, as
 * TypeScript types and zod schemas.
 *
 * The runtime is an MCP server (`cerea-browser`, see `BROWSER_RUNTIME_SERVER`) that Cerea reaches
 * through the local-connector path. Six tools make the protocol; their arguments and results are
 * JSON, returned as the tool's `structuredContent` or, failing that, as one JSON text block.
 * `screenshot` returns an MCP `image` content block instead.
 *
 * Everything the runtime returns is untrusted: it is parsed with the schemas here before any of
 * it is used, and page text is never trusted whatever the schema says.
 *
 * Nothing in this file knows how the runtime is reached (`runtimeClient.ts`) or what Cerea does
 * with it (`loop.ts`), so the engine behind the protocol can change without touching either.
 */

import { z } from "zod";

/**
 * The well-known name a runtime goes by in a machine's `mcp.json`. Identified by name so it is
 * never mixed into the user's own connector list (`isBrowserRuntimeServer`).
 */
export const BROWSER_RUNTIME_SERVER = "cerea-browser";

/** The protocol's tools. */
export const RUNTIME_TOOLS = [
	"snapshot",
	"diff",
	"act",
	"extract",
	"screenshot",
	"download",
	"end_task",
] as const;
export type RuntimeToolName = (typeof RUNTIME_TOOLS)[number];

export function isBrowserRuntimeServer(name: string): boolean {
	return name === BROWSER_RUNTIME_SERVER;
}

// ----- elements and snapshots -------------------------------------------------------------

/**
 * One node of the pruned accessibility tree, with the metadata Cerea classifies actions from.
 * Only what the classifier and the approval card need; the text the model reads is `Snapshot.text`.
 */
export const snapshotElementSchema = z.object({
	/** Stable across snapshots of the same page: the handle an action names. */
	ref: z.string().min(1).max(64),
	/** ARIA role: button, link, textbox, checkbox, combobox, ... */
	role: z.string().max(64),
	/**
	 * The accessible name, as a user sees it ("Pay €120"). For a non-field element the runtime
	 * joins the accessible name and the visible text when they differ ("Show details / Pay €120");
	 * the digest uses the same string.
	 */
	name: z.string().max(500).default(""),
	/** For an input: its `type` (text, password, email, submit, ...). */
	inputType: z.string().max(32).optional(),
	/** The form this element belongs to, when it is in one. */
	form: z.string().max(64).optional(),
	/**
	 * The method of the form this element belongs to or submits. A `get` form only fetches (a
	 * search box), so submitting it reads; `post` or absent (unknown) commits.
	 */
	formMethod: z.enum(["get", "post"]).optional(),
	/** True for a control that submits its form (`type=submit`, or a form's default button). */
	submits: z.boolean().optional(),
	/** A link's target, as written in the page. */
	href: z.string().max(2048).optional(),
	/**
	 * The host a form submits to (its resolved `action`), for a control that submits a form. A
	 * submit whose action host is on another site is a commit that leaves the site.
	 */
	formActionHost: z.string().max(255).optional(),
	/** The link's target domain, when it leaves the current one. */
	linkDomain: z.string().max(255).optional(),
	/** The element downloads a file (a `download` attribute, or a file-type target). */
	download: z.boolean().optional(),
	disabled: z.boolean().optional(),
	/** The runtime could not read this element's metadata: Cerea treats any action on it as a commit. */
	metaUnknown: z.literal(true).optional(),
	/** A field's current value; never for a password field. */
	value: z.string().max(500).optional(),
});
export type SnapshotElement = z.infer<typeof snapshotElementSchema>;

export const snapshotSchema = z.object({
	url: z.string().max(4096),
	title: z.string().max(500).default(""),
	/** The pruned tree as text, one line per node with its ref ("[e12] button "Pay"). */
	text: z.string(),
	elements: z.array(snapshotElementSchema).max(2000),
	/** Rows the runtime folded away ("... and 37 more rows like this; use extract"). */
	collapsed: z.number().int().nonnegative().optional(),
});
export type Snapshot = z.infer<typeof snapshotSchema>;

export const diffSchema = z.object({
	url: z.string().max(4096),
	title: z.string().max(500).default(""),
	/** The page was navigated since the last snapshot: `snapshot` then holds a full one. */
	navigated: z.boolean().default(false),
	added: z.array(snapshotElementSchema).max(2000).default([]),
	changed: z.array(snapshotElementSchema).max(2000).default([]),
	removed: z.array(z.string().max(64)).max(2000).default([]),
	/** The diff as text for the model. */
	text: z.string().default(""),
	snapshot: snapshotSchema.optional(),
});
export type Diff = z.infer<typeof diffSchema>;

// ----- actions ----------------------------------------------------------------------------

export const browserActionSchema = z.discriminatedUnion("type", [
	z.object({ type: z.literal("click"), ref: z.string().min(1).max(64) }),
	z.object({
		type: z.literal("fill"),
		ref: z.string().min(1).max(64),
		text: z.string().max(5000),
		/** Press Enter after typing. */
		submit: z.boolean().optional(),
	}),
	z.object({
		type: z.literal("select"),
		ref: z.string().min(1).max(64),
		value: z.string().max(500),
	}),
	z.object({
		type: z.literal("press"),
		// No control characters: a line break is not a way to say Enter.
		key: z
			.string()
			.min(1)
			.max(32)
			// eslint-disable-next-line no-control-regex
			.regex(/^[^\u0000-\u001f\u007f]+$/, "a key name, not a control character"),
		ref: z.string().min(1).max(64).optional(),
	}),
	z.object({
		type: z.literal("scroll"),
		direction: z.enum(["up", "down"]).default("down"),
		amount: z.number().int().positive().max(20).optional(),
	}),
	z.object({
		type: z.literal("wait_for"),
		text: z.string().max(200).optional(),
		ms: z.number().int().positive().max(30_000).optional(),
	}),
	z.object({ type: z.literal("navigate"), url: z.string().min(1).max(4096) }),
]);
export type BrowserAction = z.infer<typeof browserActionSchema>;

/**
 * Cerea's grant for one action of a batch. The runtime refuses a commit-class action that has no
 * grant that is signed, unexpired and bound to the exact action it is about to run (ADR 0116 §4,
 * defence in depth).
 *
 * - `digest` binds the grant to the action: the first 32 hex characters of SHA-256 over
 *   `JSON.stringify([kind, ref, value, url, name, reason, targetHost, download])`, where
 *   - `kind` is the action's `type`;
 *   - `ref` is the action's element ref, or "";
 *   - `value` is `fill`: the text, plus "\n#submit" when `submit` is set; `select`: the value;
 *     `press`: the normalised key; `navigate`: the url as given; `scroll`: direction, a colon,
 *     amount or ""; `wait_for`: text or the ms as a string; `click`: "";
 *   - `url` is the page's URL when the action runs, **without its fragment** (`#...`);
 *   - `name` is the element's accessible name as the runtime reports it in the snapshot, or "";
 *   - `reason`, `targetHost` and `download` are the facts that decided the action's class:
 *     the classification's `reason` ("submit", "verb", "download", "new-domain", "unclassified",
 *     "unknown-element", "bad-url") or "", its `targetHost` or "", and "1" when the element is
 *     marked `download`, else "0". A page that rewrites an href or a form action after the
 *     approval therefore no longer matches. `press` values use the normalised key
 *     (`normalizeKey`): `\n`, `\r`, Return and NumpadEnter are "enter", and a modified key adds "+mod".
 * - `exp` is the epoch milliseconds after which the grant is void (10 minutes after approval).
 * - `sig` is lowercase hex HMAC-SHA256, keyed by the device's browser key, over the UTF-8 string
 *   `id|digest|exp`. The key is a per-device 32-byte secret Cerea generates and the runtime
 *   fetches over the authenticated link with the machine call `browser.key`
 *   (PROTOCOL.md section 10.7). The runtime recomputes both, compares `sig` in constant time,
 *   and checks `exp` against its own clock.
 * Reference implementations: `actionDigest` in `classifier.ts`, `signGrant` in `grants.ts`.
 */
export const approvalGrantSchema = z.object({
	/** Index of the action in the batch this grant covers. */
	index: z.number().int().nonnegative(),
	/** Opaque id Cerea issued (the approval's elicitation id, or `site:<host>` for an allow-listed site). */
	id: z.string().min(1).max(128),
	digest: z.string().min(8).max(128),
	exp: z.number().int().positive(),
	sig: z.string().regex(/^[0-9a-f]{64}$/),
});
export type ApprovalGrant = z.infer<typeof approvalGrantSchema>;

export const actionResultSchema = z.object({
	ok: z.boolean(),
	/** What happened, in a few words ("clicked", "typed 12 characters", "navigated"). */
	outcome: z.string().max(300).optional(),
	error: z.string().max(1000).optional(),
	/** The runtime refused it: a commit-class action with no matching approval. */
	refused: z
		.enum(["approval_required", "approval_mismatch", "approval_expired", "scheme_refused"])
		.optional(),
});
export type ActionResult = z.infer<typeof actionResultSchema>;

export const actResultSchema = z.object({
	/** One entry per action that was attempted, in order; the batch stops at the first failure. */
	results: z.array(actionResultSchema).max(100),
	url: z.string().max(4096),
	title: z.string().max(500).default(""),
	/**
	 * Files the page offered for download during the batch (fetch them with `download`). Each says
	 * which action of the batch produced it and the id of the grant that action ran under, so Cerea
	 * keeps only files an approved download action made.
	 */
	downloads: z
		.array(
			z.object({
				name: z.string().max(255),
				mime: z.string().max(128).optional(),
				actionIndex: z.number().int().nonnegative(),
				grantId: z.string().max(128).optional(),
			})
		)
		.max(20)
		.optional(),
});
export type ActResult = z.infer<typeof actResultSchema>;

// ----- extract, screenshot, download ------------------------------------------------------

/**
 * `extract` is model-free: the runtime reads tables, lists and text off the page and returns them
 * as they are. Mapping them onto a caller's JSON Schema happens in Cerea's sub-agent, never in
 * the runtime (which has no model).
 */
export const extractRequestSchema = z.object({
	/** Limit it to the region under this element; absent means the whole page. */
	ref: z.string().min(1).max(64).optional(),
	/** What to read. `auto` returns tables and lists, and the region's text when `ref` is set. */
	mode: z.enum(["auto", "tables", "lists", "text"]).default("auto"),
});
export type ExtractRequest = z.input<typeof extractRequestSchema>;

export const extractResultSchema = z.object({
	tables: z
		.array(
			z.object({
				/** Not relied on: a runtime may leave it out, and cell links lose their hrefs. */
				ref: z.string().max(64).optional(),
				caption: z.string().max(300).optional(),
				headers: z.array(z.string().max(300)).max(100),
				rows: z.array(z.array(z.string().max(2000)).max(100)).max(2000),
				/** Rows left out ("... and 37 more rows"). */
				truncated: z.number().int().nonnegative().optional(),
			})
		)
		.max(50)
		.default([]),
	lists: z
		.array(
			z.object({
				ref: z.string().max(64).optional(),
				items: z.array(z.string().max(2000)).max(2000),
				truncated: z.number().int().nonnegative().optional(),
			})
		)
		.max(50)
		.default([]),
	/** The region's visible text (with `ref`, or `mode: "text"`). */
	text: z.string().max(100_000).optional(),
});
export type ExtractResult = z.infer<typeof extractResultSchema>;

export const screenshotResultSchema = z.object({
	mime: z.string().max(64),
	/** Base64, without a data: prefix. */
	base64: z.string(),
});
export type ScreenshotResult = z.infer<typeof screenshotResultSchema>;

/** The most bytes of one captured file Cerea takes from the runtime. */
export const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024;

/**
 * `download` returns, by default, only the files that have provenance (an action of this task
 * and the grant it ran under). `all` asks for every captured file; Cerea never sets it.
 */
export const downloadRequestSchema = z.object({ all: z.boolean().optional() });
export type DownloadRequest = z.infer<typeof downloadRequestSchema>;

/**
 * `end_task()` closes the task's pages and forgets its refs. Cerea calls it whenever a task ends,
 * whatever the reason (result, stop, budget, error). It takes no arguments.
 */
export const endTaskResultSchema = z.object({ closed: z.boolean() });
export type EndTaskResult = z.infer<typeof endTaskResultSchema>;

export const downloadResultSchema = z.object({
	files: z
		.array(
			z.object({
				name: z.string().min(1).max(255),
				mime: z.string().max(128).default("application/octet-stream"),
				size: z.number().int().nonnegative(),
				/** Base64 bytes. Absent when the runtime left the file out (too large). */
				base64: z
					.string()
					.max(Math.ceil((MAX_DOWNLOAD_BYTES * 4) / 3) + 8)
					.optional(),
				/** The action that produced it and the grant it ran under; absent for a file with no approved source. */
				actionIndex: z.number().int().nonnegative().optional(),
				grantId: z.string().max(128).optional(),
				/** Why it has no bytes. */
				skipped: z.string().max(300).optional(),
			})
		)
		.max(20),
});
export type DownloadResult = z.infer<typeof downloadResultSchema>;

// ----- the runtime, as Cerea calls it -----------------------------------------------------

/**
 * What the loop needs from a runtime. Two implementations: `McpBrowserRuntime` (the machine, over
 * MCP) and `FakeBrowserRuntime` (tests).
 */
export interface BrowserRuntime {
	snapshot(signal?: AbortSignal): Promise<Snapshot>;
	diff(signal?: AbortSignal): Promise<Diff>;
	act(
		actions: BrowserAction[],
		approvals: ApprovalGrant[] | undefined,
		signal?: AbortSignal
	): Promise<ActResult>;
	extract(request: ExtractRequest, signal?: AbortSignal): Promise<ExtractResult>;
	screenshot(ref?: string, signal?: AbortSignal): Promise<ScreenshotResult>;
	download(signal?: AbortSignal): Promise<DownloadResult>;
	/** Close the task's pages (ends of every kind). */
	endTask(signal?: AbortSignal): Promise<EndTaskResult>;
	/**
	 * Keep the connection to the runtime alive while the task waits (an approval can take an
	 * hour): the machine closes a channel with no traffic after 10 minutes, and the pages with it.
	 */
	keepAlive?(): Promise<void>;
}

/** The runtime could not be reached, or answered something that is not the protocol. */
export class BrowserRuntimeError extends Error {
	constructor(
		message: string,
		readonly kind: "unavailable" | "protocol" | "tool" = "tool"
	) {
		super(message);
		this.name = "BrowserRuntimeError";
	}
}
