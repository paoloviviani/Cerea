import type { Primitive } from "./toolInvocation";

/** Longest JSON text kept for one object or array argument on a tool card. */
export const MAX_PARAM_JSON_CHARS = 20_000;

/**
 * What a tool call argument becomes on the stored Call update (`ToolCall.parameters`
 * holds primitives only). Strings, numbers and booleans pass through. An object or
 * array (a document `spec`, say) used to be dropped, which left the card's "Input"
 * empty of the one thing a failed call needed; it is kept as compact JSON text, cut
 * at MAX_PARAM_JSON_CHARS with a visible "… (N more characters)" rather than lost.
 * The card shows such text pretty-printed. Anything else (null, undefined) is dropped.
 */
export function toPrimitive(value: unknown): Primitive | undefined {
	if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
		return value;
	}
	if (value === null || typeof value !== "object") return undefined;
	let json: string | undefined;
	try {
		json = JSON.stringify(value);
	} catch {
		return undefined;
	}
	if (json === undefined) return undefined;
	if (json.length <= MAX_PARAM_JSON_CHARS) return json;
	return `${json.slice(0, MAX_PARAM_JSON_CHARS)}… (${json.length - MAX_PARAM_JSON_CHARS} more characters)`;
}
