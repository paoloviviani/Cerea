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
	/** The accessible name, as a user sees it ("Pay €120"). */
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
	/** The link's target domain, when it leaves the current one. */
	linkDomain: z.string().max(255).optional(),
	/** The element downloads a file (a `download` attribute, or a file-type target). */
	download: z.boolean().optional(),
	disabled: z.boolean().optional(),
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
		key: z.string().min(1).max(32),
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
 * grant whose `digest` matches the action it is about to run (ADR 0116 §4, defence in depth).
 */
export const approvalGrantSchema = z.object({
	/** Index of the action in the batch this grant covers. */
	index: z.number().int().nonnegative(),
	/** Opaque id Cerea issued (the approval's elicitation id, or `site:<host>` for an allow-listed site). */
	id: z.string().min(1).max(128),
	/** `actionDigest` of the action as Cerea classified it: the exact action, not "some click". */
	digest: z.string().min(8).max(128),
});
export type ApprovalGrant = z.infer<typeof approvalGrantSchema>;

export const actionResultSchema = z.object({
	ok: z.boolean(),
	/** What happened, in a few words ("clicked", "typed 12 characters", "navigated"). */
	outcome: z.string().max(300).optional(),
	error: z.string().max(1000).optional(),
	/** The runtime refused it: a commit-class action with no matching approval. */
	refused: z.enum(["approval_required", "approval_mismatch"]).optional(),
});
export type ActionResult = z.infer<typeof actionResultSchema>;

export const actResultSchema = z.object({
	/** One entry per action that was attempted, in order; the batch stops at the first failure. */
	results: z.array(actionResultSchema).max(100),
	url: z.string().max(4096),
	title: z.string().max(500).default(""),
	/** Files the page offered for download during the batch (fetch them with `download`). */
	downloads: z
		.array(z.object({ name: z.string().max(255), mime: z.string().max(128).optional() }))
		.max(20)
		.optional(),
});
export type ActResult = z.infer<typeof actResultSchema>;

// ----- extract, screenshot, download ------------------------------------------------------

export const extractResultSchema = z.object({ data: z.unknown() });
export type ExtractResult = z.infer<typeof extractResultSchema>;

export const screenshotResultSchema = z.object({
	mime: z.string().max(64),
	/** Base64, without a data: prefix. */
	base64: z.string(),
});
export type ScreenshotResult = z.infer<typeof screenshotResultSchema>;

/** The most bytes of one captured file Cerea takes from the runtime. */
export const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024;

export const downloadResultSchema = z.object({
	files: z
		.array(
			z.object({
				name: z.string().min(1).max(255),
				mime: z.string().max(128).default("application/octet-stream"),
				size: z.number().int().nonnegative(),
				/** Base64 bytes. Absent when the runtime left the file out (too large). */
				base64: z.string().optional(),
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
	extract(schema: Record<string, unknown>, signal?: AbortSignal): Promise<ExtractResult>;
	screenshot(ref?: string, signal?: AbortSignal): Promise<ScreenshotResult>;
	download(signal?: AbortSignal): Promise<DownloadResult>;
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
