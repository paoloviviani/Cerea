import type { Message } from "$lib/types/Message";
import { MessageUpdateType } from "$lib/types/MessageUpdate";
import { extractThink, stripThink } from "$lib/utils/stripThink";
import { splitArtifactSegments } from "$lib/utils/artifacts";
import { isMessageToolCallUpdate } from "$lib/utils/messageUpdates";

/**
 * Per-conversation Markdown export.
 *
 * Client-side only: the caller passes the already-loaded, already-visible
 * message branch (the same `messagesPath` the chat renders), so the export
 * trivially matches what the user saw — visible branch only, stopped-run
 * content already clamped by the server, no hidden branches, no replay of
 * `updates`. Nothing is sent anywhere and nothing is stored; the caller
 * triggers a blob-URL download via {@link downloadMarkdown}.
 *
 * Format decisions (all deliberate, all covered by the spec):
 * - One `# <title>` heading, then `## User` / `## Assistant (<model>)`
 *   turns in branch order. `score` votes are excluded (ephemeral UI state),
 *   as are elicitation/plan updates (live interactive state, not transcript).
 * - Reasoning renders FIRST in each assistant turn inside a collapsed
 *   `<details>` section rather than a `> ` blockquote: reasoning routinely
 *   contains fenced code blocks, which break when every line is quote-
 *   prefixed, while `<details>` keeps the markdown verbatim and renders
 *   collapsed on GitHub and elsewhere — mirroring the UI's collapsed
 *   "Thinking" block.
 * - Both reasoning sources are included — the `reasoning` field AND inline
 *   `<think>` blocks — deduplicated: when the UI folded one into the other
 *   the export keeps a single copy.
 * - `<artifact>` tag chrome is dropped and create/rewrite bodies are kept as
 *   fenced code with their language; update operations become a one-line
 *   summary (the diff pairs reference content the reader cannot see without
 *   the panel). Unclosed artifact tags from a stopped run export as fenced
 *   code too — partial bytes are still what the user saw.
 * - Direct-emission file blocks (titled fences, ```markdown title=x.md) are
 *   ordinary message content and pass through verbatim: language and title=
 *   annotation survive, so the file identity survives the export.
 * - Tool calls are summarized to their names with multiplicity
 *   (`_Called 5 tools: `ask_user_question` ×5._`). Arguments and results are
 *   omitted: they can carry huge/base64 payloads and are call internals, not
 *   conversation text.
 * - Attachments and generated files are listed by name; bytes are out of
 *   scope for a text export.
 */

export interface ExportConversationInput {
	title: string;
	conversationId: string;
	/** Messages of the visible branch, in display order. */
	messages: Message[];
	/** Model display name for `## Assistant (…)` headings. */
	model?: string;
}

const LANGUAGE_FOR_ARTIFACT_KIND: Record<string, string> = {
	html: "html",
	svg: "svg",
	code: "",
	markdown: "markdown",
	react: "jsx",
	mermaid: "mermaid",
};

/** `My Chat Title!` → `my-chat-title`; empty titles fall back to `conversation`. */
export function slugifyTitle(title: string): string {
	const slug = title
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 60)
		.replace(/-+$/g, "");
	return slug || "conversation";
}

/** `<slug>-<shortid>.md`, where the short id is the trailing 6 of the conversation id. */
export function exportFilename(title: string, conversationId: string): string {
	const short =
		String(conversationId)
			.replace(/[^a-zA-Z0-9]/g, "")
			.slice(-6) || "export";
	return `${slugifyTitle(title)}-${short}.md`;
}

function normalizeWhitespace(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

/**
 * Merge the two reasoning sources, dropping exact duplicates. The UI folds
 * the `reasoning` field and `<think>` blocks together, so when one already
 * contains the other only a single copy is kept.
 */
export function collectReasoning(message: Message): string[] {
	const parts: string[] = [];
	const seen: string[] = [];
	const push = (text: string) => {
		const trimmed = text.trim();
		if (!trimmed) return;
		const norm = normalizeWhitespace(trimmed);
		if (seen.some((s) => s.includes(norm) || norm.includes(s))) return;
		seen.push(norm);
		parts.push(trimmed);
	};
	if (message.reasoning) push(message.reasoning);
	for (const block of extractThink(message.content)) push(block);
	return parts;
}

/** Every tool call's name in call order, duplicates kept: five `ask_user_question` calls are five calls, not one. */
export function collectToolNames(message: Message): string[] {
	const names: string[] = [];
	for (const update of message.updates ?? []) {
		if (isMessageToolCallUpdate(update)) {
			names.push(update.call.name);
		}
	}
	return names;
}

/**
 * Group call names with multiplicity, keeping first-call order:
 * `["search", "search", "fetch"]` → `` ["`search` ×2", "`fetch`"] ``.
 */
export function formatToolNamesWithCounts(names: string[]): string[] {
	const counts = new Map<string, number>();
	for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
	return [...counts].map(([name, count]) =>
		count === 1 ? `\`${name}\`` : `\`${name}\` ×${count}`
	);
}

/** Names of files the run generated (`file` updates carry name + hash, not bytes). */
export function collectGeneratedFiles(message: Message): string[] {
	const files: string[] = [];
	for (const update of message.updates ?? []) {
		if (update.type === MessageUpdateType.File && !files.includes(update.name)) {
			files.push(update.name);
		}
	}
	return files;
}

/**
 * Render the answer body: `<think>` blocks removed (they live in the
 * reasoning section), `<artifact>` operations converted per the module
 * policy. All other text is verbatim.
 */
export function renderAnswerBody(content: string): string {
	const withoutThink = stripThink(content);
	if (!withoutThink.includes("<artifact")) return withoutThink;
	const rendered: string[] = [];
	for (const segment of splitArtifactSegments(withoutThink)) {
		if (segment.type === "text") {
			rendered.push(segment.content);
			continue;
		}
		const op = segment.op;
		if (op.kind === "create") {
			const fence = op.language?.trim() || LANGUAGE_FOR_ARTIFACT_KIND[op.type] || "";
			rendered.push(
				`**Artifact: ${op.title} (\`${op.identifier}\`)**\n\n\`\`\`${fence}\n${op.content}\n\`\`\``
			);
		} else {
			const count = op.pairs.length;
			rendered.push(
				`_Edited artifact \`${op.identifier}\` (${count} change${count === 1 ? "" : "s"})._`
			);
		}
	}
	return rendered
		.join("")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

function renderUserMessage(message: Message): string {
	const sections: string[] = [message.content.trim()];
	const attachments = (message.files ?? []).map((f) => f.name).filter(Boolean);
	if (attachments.length > 0) {
		sections.push(attachments.map((name) => `- Attachment: ${name}`).join("\n"));
	}
	return `## User\n\n${sections.filter((s) => s.length > 0).join("\n\n")}`;
}

function renderAssistantMessage(message: Message, model?: string): string {
	const heading = model ? `## Assistant (${model})` : "## Assistant";
	const sections: string[] = [];
	const reasoning = collectReasoning(message);
	if (reasoning.length > 0) {
		sections.push(
			`<details>\n<summary>Thinking</summary>\n\n${reasoning.join("\n\n")}\n\n</details>`
		);
	}
	const toolNames = collectToolNames(message);
	if (toolNames.length > 0) {
		sections.push(
			`_Called ${toolNames.length} tool${toolNames.length === 1 ? "" : "s"}: ${formatToolNamesWithCounts(toolNames).join(", ")}._`
		);
	}
	const answer = renderAnswerBody(message.content);
	if (answer) sections.push(answer);
	const generated = collectGeneratedFiles(message);
	if (generated.length > 0) {
		sections.push(generated.map((name) => `- Generated file: ${name}`).join("\n"));
	}
	const attachments = (message.files ?? []).map((f) => f.name).filter(Boolean);
	if (attachments.length > 0) {
		sections.push(attachments.map((name) => `- Attachment: ${name}`).join("\n"));
	}
	if (message.interrupted) sections.push("_Generation stopped._");
	return `${heading}\n\n${sections.filter((s) => s.length > 0).join("\n\n")}`;
}

/** Serialize the visible branch to Markdown, one section per turn in order. */
export function exportConversationToMarkdown(input: ExportConversationInput): string {
	const title = input.title.trim() || "Untitled conversation";
	const turns = input.messages
		.filter((message) => message.from === "user" || message.from === "assistant")
		.map((message) =>
			message.from === "user"
				? renderUserMessage(message)
				: renderAssistantMessage(message, input.model)
		);
	return `# ${title}\n\n${turns.join("\n\n---\n\n")}\n`;
}

/**
 * Download a Markdown export via a blob-URL anchor — the same mechanism as
 * the artifact panel's file download. Client-side only.
 */
export function downloadMarkdown(filename: string, markdown: string): void {
	const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" });
	const url = URL.createObjectURL(blob);
	const a = document.createElement("a");
	a.href = url;
	a.download = filename;
	document.body.appendChild(a);
	a.click();
	a.remove();
	URL.revokeObjectURL(url);
}
