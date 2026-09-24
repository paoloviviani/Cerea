/**
 * System prompt teaching models how to emit artifacts: substantial,
 * self-contained content rendered in chat-ui's side panel with live preview
 * and version history. Parsed client-side by `$lib/utils/artifacts`.
 *
 * Opt-in per model: set `supportsArtifacts: true` on a model entry in the
 * MODELS overrides config.
 */
export const ARTIFACTS_SYSTEM_PROMPT = `## Artifacts

You can create artifacts: substantial, self-contained content (apps, pages, components, documents, diagrams, longer code) shown to the user in a dedicated side panel with live preview and version history, next to the conversation.

Create an artifact when the content is over ~15 lines AND the user is likely to edit, iterate on, or reuse it (web pages, apps, components, documents, diagrams, scripts). Do NOT use artifacts for short snippets, explanations, lists, or answers that depend on the conversation context — keep those in your normal reply.

To create an artifact, emit exactly this tag structure directly in your reply. NEVER wrap the tags in a markdown code fence, and never repeat the artifact content elsewhere in your reply:

<artifact identifier="kebab-case-id" type="html" title="Short human-readable title">
...the complete content, never truncated...
</artifact>

Allowed type values:
- "html": a complete self-contained HTML page (inline CSS/JS). Rendered live. Script sources from the CDNs cdn.tailwindcss.com, unpkg.com and cdn.jsdelivr.net are allowed; scripts from any other host are blocked by the preview's security policy.
- "svg": an SVG image with an <svg> root element. Rendered live.
- "react": a single React function component, with \`export default\`. Hooks are available without imports, Tailwind classes work, but NO other libraries. Rendered live.
- "mermaid": a Mermaid diagram definition. Rendered live.
- "code": code in any programming language; add language="..." to the tag. Python code cells are executed automatically in the user's browser (Pyodide); other languages are shown with syntax highlighting only.
- "markdown": a formatted document (README, essay, report, guide). Rendered as rich text.

Live previews (html/react) run in a sandboxed iframe with no same-origin access: \`localStorage\`, \`sessionStorage\`, and cookies are unavailable and throw on access — keep state in in-memory JS variables instead of persisting to browser storage. The sandbox DOES allow: pointer lock (mouse-look games — request it in a click handler), fullscreen, device motion/orientation sensors (mobile tilt controls; call \`DeviceMotionEvent.requestPermission()\` from a tap where defined), gamepad input, clipboard writes, and media autoplay. Still blocked — never build features that depend on them: popups (\`window.open\` returns null), file downloads, camera, microphone, geolocation, and \`alert\`/\`confirm\`/\`prompt\` (silent no-ops — render status and confirmations with in-page UI instead).

Editing an artifact you created earlier in the conversation:
- For small changes (fewer than ~20 lines and fewer than 5 locations), DO NOT re-emit the whole artifact. Emit a targeted update with find/replace pairs:

<artifact identifier="same-id" type="update" title="optional updated title">
<old_str>exact text from the latest version</old_str>
<new_str>replacement text</new_str>
</artifact>

For example, to recolor a button in an existing "signup-form" artifact, emit exactly:

<artifact identifier="signup-form" type="update">
<old_str>background: #16a34a;</old_str>
<new_str>background: #2563eb;</new_str>
</artifact>

- Each old_str must match the latest version EXACTLY (including whitespace/indentation) and must be unique within it. Copy it verbatim from the latest version; do not retype, reformat, or re-indent it. To change the title, set title="New Title" on the artifact update tag — never put the artifact's opening tag inside an old_str.
- Close each tag with its OWN matching tag: old_str with </old_str>, new_str with </new_str>. Do not swap them or omit a closing tag.
- Every update block must contain at least one complete old_str/new_str pair — never emit an empty type="update" block. If you can't produce exact old_str text, re-emit the full artifact instead (same identifier).
- Emit at most ONE update block per reply, with all the pairs (up to 4) inside that single block — never one block per pair.
- For larger changes, re-emit the full artifact with the SAME identifier (this creates a new version).
- Keep the identifier BYTE-IDENTICAL across every version, even when the title or content changes (renaming a green button to blue keeps the same identifier). Use a new identifier only for a genuinely different artifact.
- Do not call tools while creating or editing an artifact; emit the artifact in your reply first, then use tools in a later turn if needed.

Around the tags, briefly tell the user in plain text what you built or changed.`;

/** Append the artifacts instructions to a conversation's system prompt. */
export function injectArtifactsPrompt(preprompt?: string): string {
	const base = preprompt?.trim();
	return base ? `${base}\n\n${ARTIFACTS_SYSTEM_PROMPT}` : ARTIFACTS_SYSTEM_PROMPT;
}

/**
 * Whether this turn carries the artifacts instructions: the ML Assistant
 * preset force-enables them, otherwise they stay opt-in per model with a
 * per-model user override. Single source of truth for both the system-prompt
 * assembly (`resolvePreprompt`) and the tool loop, which needs to know the
 * same answer to place the artifact/tool rule next to the tool guidance.
 */
export function artifactsEnabledForTurn(input: {
	mlAssistant: boolean;
	artifactsOverride?: boolean;
	supportsArtifacts?: boolean;
}): boolean {
	return input.mlAssistant || (input.artifactsOverride ?? input.supportsArtifacts ?? false);
}

/**
 * One-sentence restatement of the artifact/tool rule for the tool preprompt.
 * The full instruction lives in {@link ARTIFACTS_SYSTEM_PROMPT} (buried in
 * the conversation preprompt, after the tool guidance in the merged system
 * message), so a turn that offers tools repeats the rule where the model
 * reads the tool list — both together, not pages apart.
 *
 * Tags mode only. In tool mode the model must never write tags, so this is
 * replaced by {@link ARTIFACT_TOOL_POINTER}.
 */
export const ARTIFACT_TOOL_RULE =
	"Never call a tool in the step that creates or edits an artifact: emit the artifact first, use tools in a later turn.";

/** Per-model artifact surface: the `artifact` tool, or inline `<artifact>` tags. */
export type ArtifactsMode = "tool" | "tags";

/**
 * Which artifact surface this turn uses. An explicit per-model `artifactsMode`
 * wins; otherwise `"tool"` when artifacts are enabled for the turn and tools
 * are enabled too, else `"tags"`. The ML Assistant preset force-enables
 * artifacts, and tool mode applies there too when the model supports tools.
 */
export function artifactsModeForTurn(input: {
	mlAssistant: boolean;
	artifactsOverride?: boolean;
	supportsArtifacts?: boolean;
	/** Effective tool-calling for the turn (`forceTools ?? supportsTools`). */
	toolsEnabled?: boolean;
	/** Explicit per-model override; presets may set one. */
	artifactsMode?: ArtifactsMode;
}): ArtifactsMode {
	if (input.artifactsMode === "tool" || input.artifactsMode === "tags") return input.artifactsMode;
	if (!artifactsEnabledForTurn(input)) return "tags";
	return input.toolsEnabled ? "tool" : "tags";
}

/**
 * One-line pointer shown next to the tool guidance in tool mode, where the
 * full contract lives on the tool description and the model must never write
 * tags. Tags mode shows {@link ARTIFACT_TOOL_RULE} instead.
 */
export const ARTIFACT_TOOL_POINTER =
	"Use the artifact tool to create or edit artifacts; never emit <artifact> tags directly.";

/**
 * The tool description in tool mode. Carries what the tag grammar used to:
 * when to make an artifact, the types, the sandbox allow/block list, deliver
 * first (never followed by `ask_user_question` in the same step), and that
 * earlier artifacts appear as `<artifact>` blocks to change with
 * update/rewrite, never by writing tags.
 */
export const ARTIFACT_TOOL_GUIDANCE =
	`When to make an artifact: substantial, self-contained content (apps, pages, components, documents, diagrams, longer code) the user is likely to edit, iterate on, or reuse — over ~15 lines. Do NOT use it for short snippets, explanations, lists, or answers that depend on the conversation context; keep those in your normal reply. ` +
	`Types: "html" (a complete self-contained page with inline CSS/JS; script sources from cdn.tailwindcss.com, unpkg.com and cdn.jsdelivr.net are allowed, any other host is blocked), "react" (a single React function component with export default; hooks without imports, Tailwind classes, no other libraries), "svg" (an SVG image with an <svg> root), "mermaid" (a Mermaid diagram), "code" (any language; set language="..."; Python cells auto-run in the user's browser via Pyodide, other languages are highlighted only), "markdown" (a formatted document). ` +
	`Sandbox: live previews (html/react) run in a sandboxed iframe with no same-origin access — localStorage, sessionStorage and cookies are unavailable and throw; keep state in in-memory JS variables. Allowed: pointer lock (request in a click handler), fullscreen, device motion/orientation sensors (request permission from a tap where defined), gamepad input, clipboard writes, media autoplay. Blocked — never build features depending on them: popups (window.open returns null), file downloads, camera, microphone, geolocation, alert/confirm/prompt (silent no-ops; render status with in-page UI). ` +
	`Deliver first: briefly tell the user what you built or changed in plain text, and never follow an artifact call with ask_user_question in the same step — deliver, and let the user reply in chat. ` +
	`Earlier artifacts appear in the conversation as <artifact> blocks; change them with update (small edits: old_str must occur exactly once in the latest version, copied verbatim) or rewrite (larger changes, same identifier), never by writing tags yourself.`;
