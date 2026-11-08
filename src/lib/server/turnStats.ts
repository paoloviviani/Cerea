/**
 * The numbers behind an answer's info dot: what each model call of a turn
 * reported, the time it took, and what the gateway's redaction did (the
 * Pystino "redaction visibility" contract, ADR 0112 there).
 *
 * Cerea asks for the summary with `x-pystino-redaction-summary: 1` (and the
 * values with `x-pystino-redaction-values: 1` while the user's "Show hidden
 * values" is on). A gateway with no redaction answers without a
 * `pystino_redaction` object, which is a valid answer, not an error.
 *
 * The gateway-nulls rule applies: every field of the object may arrive as
 * `null`, so every field here is `.nullish()`.
 */
import { z } from "zod";
import type {
	RedactionEntity,
	RedactionValue,
	TurnRedaction,
	TurnStats,
} from "$lib/types/TurnStats";

export const REDACTION_SUMMARY_HEADER = "x-pystino-redaction-summary";
export const REDACTION_VALUES_HEADER = "x-pystino-redaction-values";

/** The headers a chat completion to the gateway carries, for this user. */
export function redactionRequestHeaders(
	locals: { showRedactionValues?: boolean } | undefined
): Record<string, string> {
	return {
		[REDACTION_SUMMARY_HEADER]: "1",
		...(locals?.showRedactionValues === true ? { [REDACTION_VALUES_HEADER]: "1" } : {}),
	};
}

const entitySchema = z.object({
	type: z.string().nullish(),
	count: z.number().nullish(),
	mode: z.string().nullish(),
	rule: z
		.object({
			id: z.string().nullish(),
			name: z.string().nullish(),
			owner: z.string().nullish(),
		})
		.nullish(),
	sources: z.array(z.string().nullish()).nullish(),
});

const valueSchema = z.object({
	type: z.string().nullish(),
	original: z.string().nullish(),
	placeholder: z.string().nullish(),
});

const redactionSchema = z.object({
	applied: z.boolean().nullish(),
	request_id: z.string().nullish(),
	blocked: z.boolean().nullish(),
	entities: z.array(entitySchema).nullish(),
	values: z.array(valueSchema).nullish(),
});

/** The `pystino_redaction` object of one response, or undefined when absent or unreadable. */
export function parseRedaction(raw: unknown): TurnRedaction | undefined {
	if (raw === null || raw === undefined || typeof raw !== "object") return undefined;
	const parsed = redactionSchema.safeParse(raw);
	if (!parsed.success) return undefined;
	const { applied, blocked, entities, values } = parsed.data;
	const out: TurnRedaction = {
		applied: applied === true,
		blocked: blocked === true,
		entities: [],
	};
	for (const e of entities ?? []) {
		if (!e.type) continue;
		const owner = e.rule?.owner === "admin" || e.rule?.owner === "user" ? e.rule.owner : undefined;
		out.entities.push({
			type: e.type,
			count: typeof e.count === "number" && e.count > 0 ? Math.floor(e.count) : 1,
			...(e.mode ? { mode: e.mode } : {}),
			...(e.rule?.name || e.rule?.id || owner
				? {
						rule: {
							...(e.rule?.id ? { id: e.rule.id } : {}),
							...(e.rule?.name ? { name: e.rule.name } : {}),
							...(owner ? { owner } : {}),
						},
					}
				: {}),
			sources: (e.sources ?? []).filter((s): s is string => typeof s === "string" && s !== ""),
		});
	}
	const kept: RedactionValue[] = [];
	for (const v of values ?? []) {
		if (!v.type || typeof v.original !== "string") continue;
		kept.push({
			type: v.type,
			original: v.original,
			...(v.placeholder ? { placeholder: v.placeholder } : {}),
		});
	}
	if (kept.length > 0) out.values = kept;
	return out;
}

/** `pystino_cost` is a string; anything else is not a cost. */
export function parseCost(raw: unknown): string | undefined {
	return typeof raw === "string" && raw.trim() !== "" ? raw.trim() : undefined;
}

/**
 * One turn, many calls (the tool loop): add the counts, keep each rule's
 * name, and block the turn if any call was blocked. Entities merge on
 * type + rule + mode; sources union.
 */
export function aggregateRedaction(calls: TurnRedaction[]): TurnRedaction | undefined {
	if (calls.length === 0) return undefined;
	const merged = new Map<string, RedactionEntity>();
	const values: RedactionValue[] = [];
	let applied = false;
	let blocked = false;
	for (const call of calls) {
		applied ||= call.applied;
		blocked ||= call.blocked;
		for (const e of call.entities) {
			const key = [
				e.type,
				e.rule?.id ?? e.rule?.name ?? "",
				e.rule?.owner ?? "",
				e.mode ?? "",
			].join("\u0000");
			const have = merged.get(key);
			if (!have) {
				merged.set(key, { ...e, sources: [...e.sources] });
				continue;
			}
			have.count += e.count;
			for (const s of e.sources) if (!have.sources.includes(s)) have.sources.push(s);
		}
		for (const v of call.values ?? []) values.push(v);
	}
	return {
		applied,
		blocked,
		entities: [...merged.values()],
		...(values.length > 0 ? { values } : {}),
	};
}

/** What one model call reported, read from a usage chunk or a response body. */
export type CallReport = {
	inputTokens?: number;
	outputTokens?: number;
	reasoningTokens?: number;
	cost?: string;
	redaction?: TurnRedaction;
};

const num = (v: unknown): number | undefined =>
	typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;

/** Reads the usage, cost and redaction fields off a chunk or a body (both shapes carry them top-level). */
export function readCallReport(body: unknown): CallReport {
	if (body === null || typeof body !== "object") return {};
	const b = body as Record<string, unknown>;
	const usage = (b.usage ?? undefined) as Record<string, unknown> | undefined;
	const details = (usage?.completion_tokens_details ?? undefined) as
		Record<string, unknown> | undefined;
	return {
		inputTokens: num(usage?.prompt_tokens),
		outputTokens: num(usage?.completion_tokens),
		reasoningTokens: num(details?.reasoning_tokens),
		cost: parseCost(b.pystino_cost),
		redaction: parseRedaction(b.pystino_redaction),
	};
}

/** What a later chunk reports wins over what an earlier one did; a gap never erases. */
export function mergeCallReport(prev: CallReport, next: CallReport): CallReport {
	return {
		inputTokens: next.inputTokens ?? prev.inputTokens,
		outputTokens: next.outputTokens ?? prev.outputTokens,
		reasoningTokens: next.reasoningTokens ?? prev.reasoningTokens,
		cost: next.cost ?? prev.cost,
		redaction: next.redaction ?? prev.redaction,
	};
}

/** One model call being timed: from the request to the first token, then to the last. */
export class CallTimer {
	private firstAt: number | undefined;
	private lastAt: number | undefined;
	report: CallReport = {};
	constructor(
		private readonly now: () => number,
		readonly startedAt: number
	) {}
	/** Call on every token (or tool-call delta): the first and the last are kept. */
	token(): void {
		const at = this.now();
		this.firstAt ??= at;
		this.lastAt = at;
	}
	absorb(body: unknown): void {
		this.report = mergeCallReport(this.report, readCallReport(body));
	}
	get firstTokenMs(): number | undefined {
		return this.firstAt === undefined ? undefined : this.firstAt - this.startedAt;
	}
	get generationMs(): number | undefined {
		return this.firstAt === undefined || this.lastAt === undefined
			? undefined
			: this.lastAt - this.firstAt;
	}
}

const sumOf = (xs: (number | undefined)[]): number | undefined => {
	const known = xs.filter((x): x is number => x !== undefined);
	return known.length === 0 ? undefined : known.reduce((a, b) => a + b, 0);
};

/**
 * The gateway's costs are strings ("0.0042 USD"). Several calls add up only
 * when they share the same prefix and suffix around one number; otherwise the
 * total is unknown, and the overlay shows a gap rather than a wrong figure.
 */
export function sumCosts(costs: string[]): string | undefined {
	if (costs.length === 0) return undefined;
	const parts = costs.map((c) => /^(\D*?)(\d+(?:\.\d+)?)(\D*)$/.exec(c));
	if (parts.some((p) => p === null)) return costs.length === 1 ? costs[0] : undefined;
	const rows = parts as RegExpExecArray[];
	if (rows.some((r) => r[1] !== rows[0][1] || r[3] !== rows[0][3])) return undefined;
	const decimals = Math.max(...rows.map((r) => (r[2].split(".")[1] ?? "").length));
	const total = rows.reduce((sum, r) => sum + Number(r[2]), 0);
	return `${rows[0][1]}${total.toFixed(decimals)}${rows[0][3]}`;
}

/**
 * The turn's stats, built call by call. `snapshot()` is cumulative, so it can
 * be emitted after every call and the last one stands, however the turn ends.
 */
export class TurnStatsCollector {
	private readonly calls: CallTimer[] = [];
	private readonly startedAt: number;
	constructor(private readonly opts: { model?: string; now?: () => number } = {}) {
		this.startedAt = this.now();
	}
	private now = (): number => (this.opts.now ?? Date.now)();

	begin(): CallTimer {
		const call = new CallTimer(() => this.now(), this.now());
		this.calls.push(call);
		return call;
	}

	snapshot(): TurnStats {
		const first = this.calls.find((c) => c.firstTokenMs !== undefined);
		const outTokens = sumOf(this.calls.map((c) => c.report.outputTokens));
		// Speed over the time spent generating only: the pauses for tools
		// between calls are not the model's.
		const timed = this.calls.filter(
			(c) => c.generationMs !== undefined && c.report.outputTokens !== undefined
		);
		const genMs = sumOf(timed.map((c) => c.generationMs));
		const genTokens = sumOf(timed.map((c) => c.report.outputTokens));
		const tokensPerSecond =
			genMs && genMs > 0 && genTokens !== undefined
				? Math.round((genTokens / (genMs / 1000)) * 10) / 10
				: undefined;
		const redaction = aggregateRedaction(
			this.calls.map((c) => c.report.redaction).filter((r): r is TurnRedaction => r !== undefined)
		);
		const cost = sumCosts(this.calls.map((c) => c.report.cost).filter((c): c is string => !!c));
		const stats: TurnStats = {
			model: this.opts.model,
			inputTokens: sumOf(this.calls.map((c) => c.report.inputTokens)),
			outputTokens: outTokens,
			reasoningTokens: sumOf(this.calls.map((c) => c.report.reasoningTokens)),
			firstTokenMs: first?.firstTokenMs,
			tokensPerSecond,
			cost,
			at: this.startedAt,
			redaction,
		};
		// No undefined keys: the database would store them as null.
		return Object.fromEntries(
			Object.entries(stats).filter(([, v]) => v !== undefined && v !== "")
		) as TurnStats;
	}
}

/** Drops the hidden values from every message's stats: for exports and anything shared. */
export function stripRedactionValues<T extends { stats?: TurnStats }>(messages: T[]): T[] {
	return messages.map((message) => {
		const redaction = message.stats?.redaction;
		if (!redaction || !("values" in redaction)) return message;
		const rest = { ...redaction };
		delete rest.values;
		return { ...message, stats: { ...message.stats, redaction: rest } };
	});
}
