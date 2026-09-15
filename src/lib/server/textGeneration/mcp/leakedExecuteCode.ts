import { randomUUID } from "crypto";
import { EXECUTE_CODE_TOOL_NAME } from "../builtinTools/executeCodeTool";
import type { NormalizedToolCall } from "./toolInvocation";

/**
 * How many leaked `execute_code` calls one generation run may recover. One,
 * deliberately: recovery exists for the model that writes the call as markup
 * instead of making it, and a reply carrying two such blocks is as likely to be
 * an illustration of the syntax as two intended calls — running the first and
 * silently dropping the second would fabricate a success the code never had.
 * Ambiguity does nothing (the callers log when the markup was seen but not
 * recovered), which leaves the turn exactly where it would have been without
 * this path.
 */
export const MAX_RECOVERED_EXECUTE_CODE_CALLS = 1;

/**
 * A well-formed block: an opening tag (attributes optional — the live failure
 * wrote `<execute_code lang="python">`), a closing tag, and non-empty code
 * between them. An opening tag without its closer is not a call that can run,
 * so it never recovers.
 */
const EXECUTE_CODE_BLOCK = /<execute_code(?:\s[^>]*)?>\r?\n?([\s\S]*?)\r?\n?<\/execute_code>/g;
const FENCED_BLOCK = /```[\s\S]*?```/g;
const INLINE_CODE_SPAN = /`[^`\n]*`/g;

/**
 * Recover the `execute_code` call a model wrote as markup instead of making.
 *
 * Recorded live (2026-09-15, glm-5.3-flash through the gateway): the same
 * prompt that made a real tool call in one conversation produced, two hours
 * later in a fresh one, two consecutive replies where the model wrote the call
 * as `<execute_code lang="python">…</execute_code>` text — the persisted
 * updates show the second round replacing the first, and the model's own
 * reasoning quotes the leaked-markup correction, so the retry mechanism fired
 * and the model still could not comply. A correction can only fix a model that
 * knows how; this one kept re-inventing an XML dialect from the tool's name.
 * Parsing the block out of the reply and dispatching it as an ordinary tool
 * call gives that model the same outcome a compliant one gets: the code runs
 * in the person's browser, the result comes back, and the turn continues.
 *
 * The dispatch (runMcpFlow) routes the returned call through executeToolCalls
 * like any other, so recovery reuses the parking row, the CodeExecution card,
 * the per-turn call cap and the resume machinery unchanged — there is no
 * second execution path here, only a second way a call can arrive.
 *
 * Deliberately conservative, because every false positive runs code the model
 * never meant to run:
 *
 * - the tool must have been offered this run (a markup imitation of a tool the
 *   model was never given is not a call to honor);
 * - markup inside a fenced code block or an inline code span is illustration,
 *   not an attempt — the fence channel already runs fenced code for the person
 *   on its own terms, and quoting the syntax must not trigger execution;
 * - exactly one well-formed block outside those constructs. Zero is no call;
 *   two or more is the ambiguity the cap above refuses to guess through;
 * - the caller additionally only consults this when the round produced no real
 *   tool calls, and never for a round whose tool calls were discarded as
 *   truncated.
 *
 * `content` must be the round's visible text — reasoning stripped by the
 * caller — so a block the model merely discussed inside its thinking never
 * runs.
 */
export function recoverLeakedExecuteCodeCall(params: {
	content: string;
	toolOffered: boolean;
}): NormalizedToolCall | null {
	if (!params.toolOffered) return null;

	// Remove complete fenced blocks first, then inline spans from what remains,
	// then treat a fence opener with no closer as swallowing the rest of the
	// reply — a renderer would render it that way, so an attempt the reader
	// cannot distinguish from an example is not recovered either.
	let outsideFences = params.content.replace(FENCED_BLOCK, "");
	const unterminatedFence = outsideFences.indexOf("```");
	if (unterminatedFence !== -1) outsideFences = outsideFences.slice(0, unterminatedFence);
	const outsideCode = outsideFences.replace(INLINE_CODE_SPAN, "");

	const matches = [...outsideCode.matchAll(EXECUTE_CODE_BLOCK)];
	if (matches.length !== 1) return null;
	const code = (matches[0][1] ?? "").trim();
	if (!code) return null;

	return {
		id: randomUUID(),
		name: EXECUTE_CODE_TOOL_NAME,
		arguments: JSON.stringify({ code }),
	};
}
