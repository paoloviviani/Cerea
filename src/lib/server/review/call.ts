/**
 * One call to the gateway's decision route (ADR 0100): `POST /v1/decisions` with one predicate
 * question; the answer is `answers[0].probability`. Anything that is not a probability is an
 * `error` with a reason the log and the card can say; the caller escalates on every one of them.
 */
import { isQuotaError } from "$lib/server/gatewayErrors";
import { config } from "$lib/server/config";
import { gateway, GatewayCallFailed, GatewayTimeout } from "$lib/server/gatewayServer";
import { decisionBody, type AskFields } from "./frame";

export type DecisionResult =
	| { ok: true; probability: number }
	| { ok: false; kind: "refusal" | "unreachable" | "malformed"; detail: string };

export function reviewTimeoutMs(): number {
	const s = Number(config.AUTO_REVIEW_TIMEOUT_SECONDS);
	return (Number.isFinite(s) && s >= 1 ? s : 20) * 1000;
}

export async function askDecisionModel(args: {
	token: string;
	modelId: string;
	instructions: string;
	fields: AskFields;
	timeoutMs?: number;
}): Promise<DecisionResult> {
	let answer: unknown;
	try {
		answer = await gateway.post<unknown>(
			args.token,
			"decisions",
			decisionBody(args.modelId, args.instructions, args.fields),
			{ timeoutMs: args.timeoutMs ?? reviewTimeoutMs() }
		);
	} catch (err) {
		if (err instanceof GatewayTimeout)
			return { ok: false, kind: "unreachable", detail: "timed out" };
		if (err instanceof GatewayCallFailed) {
			if (isQuotaError(err)) {
				return { ok: false, kind: "unreachable", detail: "the usage quota is used up" };
			}
			return { ok: false, kind: "unreachable", detail: `the gateway answered ${err.status}` };
		}
		return { ok: false, kind: "unreachable", detail: "the gateway could not be reached" };
	}
	const first = (answer as { answers?: unknown[] } | null)?.answers?.[0] as
		{ type?: string; probability?: unknown } | undefined;
	if (!first || typeof first !== "object") {
		return { ok: false, kind: "malformed", detail: "no answer" };
	}
	if (first.type === "refusal") return { ok: false, kind: "refusal", detail: "the model declined" };
	const p = first.probability;
	if (
		first.type !== "predicate" ||
		typeof p !== "number" ||
		!Number.isFinite(p) ||
		p < 0 ||
		p > 1
	) {
		return { ok: false, kind: "malformed", detail: "not a probability" };
	}
	return { ok: true, probability: p };
}
