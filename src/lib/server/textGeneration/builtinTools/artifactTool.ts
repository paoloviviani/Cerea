import { z } from "zod";
import { collections } from "$lib/server/database";
import { logger } from "$lib/server/logger";
import type { Message } from "$lib/types/Message";
import { MessageUpdateType } from "$lib/types/MessageUpdate";
import { collectArtifacts, type ArtifactKind } from "$lib/utils/artifacts";
import { ARTIFACT_TOOL_GUIDANCE } from "../artifacts";
import type { BuiltinTool } from "./types";

export const ARTIFACT_TOOL_NAME = "artifact";

const ARTIFACT_TYPES = ["html", "react", "svg", "mermaid", "markdown", "code"] as const;
type ArtifactType = (typeof ARTIFACT_TYPES)[number];

const IDENTIFIER_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAX_IDENTIFIER_CHARS = 64;
const MAX_TITLE_CHARS = 200;

export const artifactToolDefinition = {
	type: "function" as const,
	function: {
		name: ARTIFACT_TOOL_NAME,
		description:
			"Create or edit a live artifact in the side panel (apps, pages, components, documents, diagrams, longer code). " +
			"Every call creates a new version with history. The result is short and never echoes the content. " +
			ARTIFACT_TOOL_GUIDANCE,
		parameters: {
			type: "object",
			properties: {
				command: {
					type: "string",
					enum: ["create", "update", "rewrite"],
					description:
						"create makes a new artifact (identifier must be new); update edits the latest version with an exact old_str/new_str pair; rewrite replaces the whole content of an existing artifact (same identifier).",
				},
				identifier: {
					type: "string",
					description:
						"Kebab-case id for the artifact, BYTE-IDENTICAL across every version (e.g. signup-form). A new identifier only for a genuinely different artifact.",
				},
				type: {
					type: "string",
					enum: [...ARTIFACT_TYPES],
					description:
						'Required for create. One of "html", "react", "svg", "mermaid", "markdown", "code".',
				},
				language: {
					type: "string",
					description: 'For type "code" only: the programming language (e.g. python, typescript).',
				},
				title: {
					type: "string",
					description:
						'Short human-readable title. Required for create; optional for update/rewrite (sets a new title when present). Never put markup in it. For update, never put the artifact opening tag inside old_str to rename — set title="New Title" on the call instead.',
				},
				content: {
					type: "string",
					description:
						"The complete artifact content for create/rewrite, never truncated. Never wrap it in a markdown code fence, and never repeat it elsewhere in your reply.",
				},
				old_str: {
					type: "string",
					description:
						"For update: exact text from the latest version to replace. Must occur EXACTLY once — copy it verbatim, including whitespace and indentation. If you cannot, use rewrite with the full content instead.",
				},
				new_str: {
					type: "string",
					description: "For update: the replacement text.",
				},
			},
			required: ["command"],
		},
	},
};

const baseArgsSchema = z.object({
	command: z.enum(["create", "update", "rewrite"]),
	identifier: z.string().optional(),
	type: z.string().optional(),
	language: z.string().optional(),
	title: z.string().optional(),
	content: z.string().optional(),
	old_str: z.string().optional(),
	new_str: z.string().optional(),
});

export type ArtifactArgs = z.infer<typeof baseArgsSchema>;

export type ResolvedArtifactOp =
	| { ok: true; block: string; resultText: string; version: number; identifier: string }
	| { ok: false; error: string };

type HistoryMessage = Pick<Message, "id" | "from" | "content">;

function invalidIdentifier(value: unknown): string | null {
	if (typeof value !== "string" || value.length === 0)
		return "identifier must be a non-empty string";
	if (value.length > MAX_IDENTIFIER_CHARS)
		return `identifier must be at most ${MAX_IDENTIFIER_CHARS} characters`;
	if (!IDENTIFIER_RE.test(value))
		return "identifier must start with a letter or digit and contain only letters, digits, ., _, - (e.g. signup-form)";
	return null;
}

function invalidTitle(value: unknown, required: boolean): string | null {
	if (value === undefined) return required ? "title is required for create" : null;
	if (typeof value !== "string" || value.trim().length === 0)
		return "title must be a non-empty string";
	if (value.length > MAX_TITLE_CHARS) return `title must be at most ${MAX_TITLE_CHARS} characters`;
	if (value.includes('"') || value.includes("<") || value.includes(">"))
		return "title must not contain '\"', '<' or '>'";
	return null;
}

function escapeAttr(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

function countOccurrences(haystack: string, needle: string): number {
	if (needle.length === 0) return 0;
	let count = 0;
	let from = 0;
	for (;;) {
		const idx = haystack.indexOf(needle, from);
		if (idx === -1) return count;
		count += 1;
		from = idx + needle.length;
	}
}

/**
 * Pure core of the tool: validate one call against the conversation's artifact
 * history and build the canonical inline block to append to the assistant
 * message's content. `history` is the earlier assistant messages (think
 * already stripped by the shared parser) plus, for later rounds of the same
 * turn, the blocks this turn already appended — in order.
 *
 * The same sink serves the follow-up MCP `ui://` / `text/html` slice: an
 * embedded resource becomes a `{command: "create"...}`-equivalent here (type
 * html, identifier from the URI, title from the resource or tool name) and is
 * appended the same way, through the same validation.
 */
export function resolveArtifactOp(
	history: HistoryMessage[],
	args: ArtifactArgs
): ResolvedArtifactOp {
	const identifierError = invalidIdentifier(args.identifier);
	if (identifierError) {
		return { ok: false, error: `${identifierError}. Retry with a corrected identifier.` };
	}
	const identifier = args.identifier as string;

	const registry = collectArtifacts(history.filter((m) => m.from === "assistant"));
	const existing = registry.artifacts.get(identifier);
	const latest = existing?.versions.at(-1);
	const nextVersion = (existing?.versions.length ?? 0) + 1;

	if (args.command === "create") {
		if (existing) {
			return {
				ok: false,
				error: `Artifact "${identifier}" already exists (v${existing.versions.length}). Use rewrite to replace it or update for a targeted edit, keeping the identifier byte-identical.`,
			};
		}
		const titleError = invalidTitle(args.title, true);
		if (titleError) return { ok: false, error: `${titleError}. Retry with a corrected call.` };
		if (
			typeof args.type !== "string" ||
			!(ARTIFACT_TYPES as readonly string[]).includes(args.type)
		) {
			return {
				ok: false,
				error: `type must be one of ${ARTIFACT_TYPES.join("|")}. Retry with a corrected call.`,
			};
		}
		if (typeof args.content !== "string" || args.content.length === 0) {
			return {
				ok: false,
				error: "content must be a non-empty string. Retry with the full content.",
			};
		}
		if (args.content.includes("</artifact>")) {
			return {
				ok: false,
				error:
					"content must not contain a literal </artifact>. Rephrase or drop that sequence and retry.",
			};
		}
		const type = args.type as ArtifactType;
		const language =
			typeof args.language === "string" && args.language.trim().length > 0
				? args.language.trim()
				: undefined;
		const block =
			`<artifact identifier="${escapeAttr(identifier)}" type="${type}" title="${escapeAttr(args.title as string)}"` +
			(language && type === "code" ? ` language="${escapeAttr(language)}"` : "") +
			`>${args.content}</artifact>`;
		return {
			ok: true,
			block,
			resultText: `created ${identifier} v1 (${type})`,
			version: nextVersion,
			identifier,
		};
	}

	if (args.command === "rewrite") {
		if (!existing || !latest) {
			return {
				ok: false,
				error: `Artifact "${identifier}" does not exist yet. Use create to make it.`,
			};
		}
		const titleError = invalidTitle(args.title, false);
		if (titleError) return { ok: false, error: `${titleError}. Retry with a corrected call.` };
		if (typeof args.content !== "string" || args.content.length === 0) {
			return {
				ok: false,
				error: "content must be a non-empty string. Retry with the full content.",
			};
		}
		if (args.content.includes("</artifact>")) {
			return {
				ok: false,
				error:
					"content must not contain a literal </artifact>. Rephrase or drop that sequence and retry.",
			};
		}
		const title = (args.title as string | undefined) ?? latest.title;
		const kind: ArtifactKind = latest.type;
		const language = latest.language;
		const block =
			`<artifact identifier="${escapeAttr(existing.identifier)}" type="${kind}" title="${escapeAttr(title)}"` +
			(language && kind === "code" ? ` language="${escapeAttr(language)}"` : "") +
			`>${args.content}</artifact>`;
		return {
			ok: true,
			block,
			resultText: `rewrote ${existing.identifier} → v${nextVersion}`,
			version: nextVersion,
			identifier: existing.identifier,
		};
	}

	// update
	if (!existing || !latest) {
		return {
			ok: false,
			error: `Artifact "${identifier}" does not exist yet. Use create to make it.`,
		};
	}
	const titleError = invalidTitle(args.title, false);
	if (titleError) return { ok: false, error: `${titleError}. Retry with a corrected call.` };
	if (typeof args.old_str !== "string" || args.old_str.length === 0) {
		return {
			ok: false,
			error:
				"old_str must be a non-empty string copied verbatim from the latest version, or use rewrite with the full content.",
		};
	}
	if (typeof args.new_str !== "string") {
		return { ok: false, error: "new_str is required for update. Retry with a corrected call." };
	}
	if (args.new_str.includes("</artifact>")) {
		return {
			ok: false,
			error:
				"new_str must not contain a literal </artifact>. Rephrase or drop that sequence and retry.",
		};
	}
	const matches = countOccurrences(latest.content, args.old_str);
	if (matches !== 1) {
		return {
			ok: false,
			error:
				`old_str occurs ${matches} times in the latest version (v${latest.version}); it must occur exactly once. ` +
				"Copy old_str verbatim from the latest version, make it longer so it is unique, or use rewrite with the full content.",
		};
	}
	const titleAttr = typeof args.title === "string" ? ` title="${escapeAttr(args.title)}"` : "";
	const block =
		`<artifact identifier="${escapeAttr(existing.identifier)}" type="update"${titleAttr}>` +
		`<old_str>${args.old_str}</old_str><new_str>${args.new_str}</new_str></artifact>`;
	return {
		ok: true,
		block,
		resultText: `updated ${existing.identifier} → v${nextVersion}`,
		version: nextVersion,
		identifier: existing.identifier,
	};
}

/**
 * The `artifact` builtin: one tool with `command` create/update/rewrite.
 *
 * Execution writes a canonical inline block into the assistant message's
 * content — via a Stream `extraUpdate`, the least invasive path: the route's
 * `applyUpdateToMessage` and the client's `consumeMessageUpdates` already
 * append Stream tokens to `content`, so the existing parser, panel, version
 * history and markdown export all work unchanged with no new update type and
 * no persistence change. The result itself stays short and never echoes
 * content.
 *
 * It never parks the turn (`mayPark` unset) and is exempt from the blanket
 * tool restraint, so the "do not use tools" guidance names it as covered
 * elsewhere.
 */
export function createArtifactTool(params: { turnBlocks?: string[] } = {}): BuiltinTool {
	const turnBlocks = params.turnBlocks ?? [];
	return {
		name: ARTIFACT_TOOL_NAME,
		definition: artifactToolDefinition,
		exemptFromToolRestraint: true,
		preprompt:
			`ARTIFACTS: ${ARTIFACT_TOOL_GUIDANCE} ` +
			`Make at most one artifact call per step; independent artifacts go in separate steps.`,
		async execute(args, ctx) {
			const parsed = baseArgsSchema.safeParse(args);
			if (!parsed.success) {
				const issue = parsed.error.issues[0];
				const path = issue?.path.join(".") ?? "";
				return {
					error: `Invalid artifact arguments${path ? ` at ${path}` : ""}: ${issue?.message ?? "unknown"}. Retry with a corrected call.`,
				};
			}
			let history: HistoryMessage[] = [];
			try {
				if (ctx.conversationId) {
					const conv = await collections.conversations.findOne(
						{ _id: ctx.conversationId },
						{ projection: { messages: 1 } }
					);
					const stored = (conv?.messages ?? []) as Array<Pick<Message, "id" | "from" | "content">>;
					history = stored.filter((m) => m?.from === "assistant");
				}
			} catch (err) {
				logger.warn({ err: String(err) }, "[artifact] failed to load conversation history");
				return { error: "The conversation history could not be read. Retry the call." };
			}
			if (ctx.messageId && turnBlocks.length > 0) {
				history = [
					...history,
					{ id: ctx.messageId, from: "assistant" as const, content: turnBlocks.join("\n\n") },
				];
			}
			const resolved = resolveArtifactOp(history, parsed.data);
			if (!resolved.ok) return { error: resolved.error };
			turnBlocks.push(resolved.block);
			return {
				resultText: resolved.resultText,
				extraUpdates: [{ type: MessageUpdateType.Stream, token: `\n\n${resolved.block}` }],
			};
		},
	};
}
