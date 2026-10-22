import { isoDateIn } from "./clock";
import type { OpenAiTool } from "$lib/server/mcp/tools";
import type { BuiltinTool } from "../builtinTools/types";
import { ARTIFACT_TOOL_POINTER, ARTIFACT_TOOL_RULE } from "../artifacts";
import type { ArtifactsMode } from "../artifacts";

export function buildToolPreprompt(
	tools: OpenAiTool[],
	timezone?: string,
	builtins?: Array<Pick<BuiltinTool, "name" | "preprompt" | "exemptFromToolRestraint">>,
	/**
	 * `artifacts` repeats the artifact/tool rule beside the tool guidance. The
	 * full artifacts instructions travel in the conversation preprompt, which the
	 * caller merges AFTER this text — so without this the model reads the tool
	 * list first and the "don't call tools while emitting an artifact" rule much
	 * later, and drafts artifacts inside a tool-called turn. Set it exactly when
	 * the turn carries the artifacts prompt in tags mode; with no tools on offer
	 * this whole builder returns "" anyway, so the rule can never appear
	 * tool-less. In tool mode (`artifactsMode: "tool"`) the tag grammar is gone
	 * and the contract lives on the artifact tool's description, so the rule is
	 * replaced by a one-line pointer to the tool instead.
	 */
	options?: { artifacts?: boolean; artifactsMode?: ArtifactsMode }
): string {
	if (!Array.isArray(tools) || tools.length === 0) return "";
	const names = tools
		.map((t) => (t?.function?.name ? String(t.function.name) : ""))
		.filter((s) => s.length > 0);
	if (names.length === 0) return "";
	// "Now" is not stated here: `resolvePreprompt` puts the one current-time line
	// in the system prompt for every turn, tools or not. What this paragraph
	// needs is today's date in the person's zone, for the search guidance.
	const now = new Date();
	const isoDate = isoDateIn(now, timezone);
	const year = isoDate.slice(0, 4);
	// Only builtins actually on offer this turn contribute guidance.
	const offered = (builtins ?? []).filter((builtin) => names.includes(builtin.name));
	const exemptNames = offered
		.filter((builtin) => builtin.exemptFromToolRestraint)
		.map((builtin) => builtin.name);
	const builtinGuidance = offered
		.map((builtin) => builtin.preprompt?.trim() ?? "")
		.filter((text) => text.length > 0);
	const restraint = `IMPORTANT: Do NOT call a tool unless the user's request requires capabilities you lack (e.g., real-time data, image generation, code execution) or external information you do not have. For tasks like writing code, creative writing, math, or building apps, respond directly without tools. When in doubt, do not use a tool.${
		exemptNames.length > 0
			? ` This does not apply to ${exemptNames.join(" or ")}, covered below.`
			: ""
	}`;
	const general = [
		`You have access to these tools: ${names.join(", ")}.`,
		restraint,
		// Right after the restraint paragraph, never anywhere else: the rule only
		// works read together with the tool guidance, not restated pages later.
		// Tool mode replaces the tags rule with a pointer — the contract lives
		// on the tool description and the model must never write tags.
		...(options?.artifactsMode === "tool"
			? [ARTIFACT_TOOL_POINTER]
			: options?.artifacts
				? [ARTIFACT_TOOL_RULE]
				: []),
		...builtinGuidance,
		`PARALLEL TOOL CALLS: When multiple tool calls are needed and they are independent of each other (i.e., one does not need the result of another), call them all at once in a single response instead of one at a time. Only chain tool calls sequentially when a later call depends on an earlier call's output.`,
		`SEARCH: Use 3-6 precise keywords. For historical events, include the year the event occurred. For recent or current topics, use today's year (${year}). When a tool accepts date-range parameters (e.g., startPublishedDate, endPublishedDate), always use today's date (${isoDate}) as the end date unless the user specifies otherwise. For multi-part questions, search each part separately. If the results only partially cover the question, run a follow-up search or crawl the most relevant result URL instead of answering from memory.`,
		`GROUNDING: When you answer from tool results, the results are your only source of facts. Do not supplement them with specifics from your own knowledge — details not present in the results are likely wrong, even when they sound plausible. If a fact is missing, search again or say you could not verify it. Attribute key facts to their sources with markdown links to the result URLs. If results conflict, say so. Never fabricate URLs, citations, or facts.`,
		`INTERACTIVE APPS: When asked to build an interactive application, game, or visualization without a specific language/framework preference, create a single self-contained HTML file with embedded CSS and JavaScript.`,
		`If a tool generates an image, you can inline it directly: ![alt text](image_url).`,
		`If a tool needs an image, set its image field ("input_image", "image", or "image_url") to a reference like "image_1", "image_2", etc. (ordered by when the user uploaded them).`,
		`Default to image references; only use a full http(s) URL when the tool description explicitly asks for one, or reuse a URL a previous tool returned.`,
	].join(" ");

	return general;
}

/**
 * What the model is told about connectors the person picked that did not load.
 *
 * Without it the model sees a request for a service and no tool for it, and
 * reaches for the one general tool it has — code execution — which has no
 * network and can only fake the answer. Named, it can say what is wrong and
 * where to fix it. Empty when everything loaded.
 */
export function unavailableConnectorsNotice(
	unavailable: Array<{ name: string; reason: string }>
): string {
	if (unavailable.length === 0) return "";
	const lines = unavailable.map(({ name, reason }) => `- ${name}: ${reason}`).join("\n");
	return [
		"UNAVAILABLE CONNECTORS: these MCP connectors are enabled for this chat, but their tools could not be loaded this turn:",
		lines,
		"If the request needs one of them, say plainly that it is unavailable and why, and tell the person to fix it under Workspace → MCP servers (sign in, add or correct the token, then Re-check). Do not imitate a missing connector with another tool: code execution in particular has no network access, so it cannot reach that service, and made-up output presented as its result is worse than saying it is missing. Anything the request needs that the available tools can genuinely do, do as usual.",
	].join("\n");
}
