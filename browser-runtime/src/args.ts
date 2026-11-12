/**
 * Lenient parsing of tool arguments. The caller is a model, and weak models send malformed calls:
 * a JSON string where an array belongs, a lone object instead of a list, a number where text is
 * wanted. What can be read unambiguously is accepted; the rest fails whole, with a message that
 * says what to send, and nothing runs.
 */

import { z } from "zod";
import { approvalGrantSchema, type ApprovalGrant } from "./contract.ts";
import { ToolError } from "./errors.ts";
import { runtimeActionSchema, type RuntimeAction } from "./extensions.ts";

const MAX_ACTIONS = 12;

function maybeJson(value: unknown): unknown {
	if (typeof value !== "string") return value;
	const text = value.trim();
	if (!text || !/^[[{]/.test(text)) return value;
	try {
		return JSON.parse(text);
	} catch {
		return value;
	}
}

export function asObject(args: unknown): Record<string, unknown> {
	const value = maybeJson(args ?? {});
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new ToolError("The arguments must be a JSON object.");
	}
	return value as Record<string, unknown>;
}

const ACTION_TYPES = runtimeActionSchema.options.map((o) => o.shape.type.value);

function describeIssue(issue: z.ZodIssue): string {
	const where = issue.path.length > 0 ? issue.path.join(".") : "action";
	if (issue.code === "invalid_union_discriminator") {
		return `${where}: unknown type (use one of ${ACTION_TYPES.join(", ")})`;
	}
	if (issue.code === "invalid_type" && issue.received === "undefined") {
		return `${where} is required`;
	}
	return `${where}: ${issue.message}`;
}

export function parseActions(raw: unknown): RuntimeAction[] {
	let value = maybeJson(raw);
	if (value && typeof value === "object" && !Array.isArray(value)) value = [value];
	if (!Array.isArray(value)) {
		throw new ToolError(
			`act needs "actions": a list such as [{"type":"click","ref":"e5"}]. Types: ${ACTION_TYPES.join(", ")}.`
		);
	}
	if (value.length === 0) throw new ToolError("act needs at least one action.");
	if (value.length > MAX_ACTIONS) throw new ToolError(`At most ${MAX_ACTIONS} actions per call.`);
	return value.map((item, i) => {
		const coerced = coerceAction(maybeJson(item));
		const parsed = runtimeActionSchema.safeParse(coerced);
		if (!parsed.success) {
			throw new ToolError(
				`actions[${i}] is not valid (${describeIssue(parsed.error.issues[0])}). Nothing was run.`
			);
		}
		return parsed.data;
	});
}

/** Numbers where text is meant, and `ref` sent as `[ref=e5]` or `@e5`. */
function coerceAction(item: unknown): unknown {
	if (!item || typeof item !== "object" || Array.isArray(item)) return item;
	const out: Record<string, unknown> = { ...(item as Record<string, unknown>) };
	for (const key of ["text", "value"]) {
		if (typeof out[key] === "number") out[key] = String(out[key]);
	}
	if (typeof out.ref === "string") {
		const match = /^\s*(?:\[ref=|@|\[)?([A-Za-z0-9_-]+)\]?\s*$/.exec(out.ref);
		if (match) out.ref = match[1];
	}
	return out;
}

export function parseApprovals(raw: unknown): ApprovalGrant[] | undefined {
	if (raw === undefined || raw === null) return undefined;
	let value = maybeJson(raw);
	if (value && typeof value === "object" && !Array.isArray(value)) value = [value];
	const parsed = z.array(approvalGrantSchema).max(MAX_ACTIONS).safeParse(value);
	if (!parsed.success) {
		throw new ToolError(
			'approvals must be a list of {"index": number, "id": string, "digest": string}. Nothing was run.'
		);
	}
	return parsed.data;
}

const extractSchema = z.object({
	ref: z.string().min(1).max(64).optional(),
	mode: z.enum(["auto", "tables", "lists", "text"]).optional(),
});

/**
 * The contract's request is `{ref?, mode?}`. A request nested under `schema` (an earlier draft of
 * the contract) is accepted too; any JSON Schema in it is ignored: the runtime has no model.
 */
export function parseExtract(raw: unknown): {
	ref?: string;
	mode?: "auto" | "tables" | "lists" | "text";
} {
	const args = asObject(raw);
	const inner = maybeJson(args.schema);
	const source: Record<string, unknown> = {
		...(inner && typeof inner === "object" && !Array.isArray(inner)
			? (inner as Record<string, unknown>)
			: {}),
		...args,
	};
	const picked = {
		ref: typeof source.ref === "string" && source.ref ? coerceRef(source.ref) : undefined,
		mode: typeof source.mode === "string" ? source.mode : undefined,
	};
	const parsed = extractSchema.safeParse(picked);
	if (!parsed.success) {
		throw new ToolError('extract takes optional "ref" and "mode" (auto, tables, lists or text).');
	}
	return parsed.data;
}

function coerceRef(ref: string): string {
	return /^\s*(?:\[ref=|@|\[)?([A-Za-z0-9_-]+)\]?\s*$/.exec(ref)?.[1] ?? ref;
}

const screenshotSchema = z.object({
	ref: z.string().min(1).max(64).optional(),
	format: z.enum(["png", "jpeg"]).optional(),
});
export function parseScreenshot(raw: unknown): { ref?: string; format?: "png" | "jpeg" } {
	const args = asObject(raw);
	const parsed = screenshotSchema.safeParse({
		ref: typeof args.ref === "string" && args.ref ? coerceRef(args.ref) : undefined,
		format: args.format,
	});
	if (!parsed.success)
		throw new ToolError('screenshot takes an optional "ref" and "format" (png or jpeg).');
	return parsed.data;
}
