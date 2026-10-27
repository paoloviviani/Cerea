import type { OpenAI } from "openai";
import type {
	ChatCompletionCreateParamsNonStreaming,
	ChatCompletionCreateParamsStreaming,
	ChatCompletionMessageParam,
} from "openai/resources/chat/completions";
import { logger } from "$lib/server/logger";
import type { McpToolMapping, OpenAiTool } from "$lib/server/mcp/tools";
import type { McpServerConfig } from "$lib/server/mcp/httpClient";
import { MessageToolUpdateType, MessageUpdateType } from "$lib/types/MessageUpdate";
import { recordNestedAgentCalls, type LoggedCall } from "./nestedAgentCallLog";
import { executeToolCalls, type NormalizedToolCall } from "../mcp/toolInvocation";
import { createSchemaPreflightGuard } from "$lib/server/mcp/preflightGuard";
import { composeGuards, type ToolCallGuard } from "../mcp/toolGuard";
import { parseToolArguments, withParseableArguments } from "../mcp/toolArgs";
import { stripLoneSurrogates } from "../utils/loneSurrogates";
import { isRateLimitError, withUpstreamRetry } from "../utils/upstreamRetry";
import type { BuiltinTool, BuiltinToolContext, BuiltinToolResult } from "./types";
import { LOAD_TOOLS_TOOL_NAME } from "./loadToolsTool";
import { toPrimitive } from "../mcp/toolParams";

/**
 * The loop behind a sub-agent tool: a complete nested agent run on a fresh
 * message array, against a tool allowlist, whose only trace in the parent
 * conversation is the string it returns.
 *
 * Extracted from the research tool when a second sub-agent arrived. Everything
 * here is the machinery neither agent should have to reimplement — the context
 * budget and its forced summary, the iteration cap, the repetition guard, the
 * wire-safe message rebuild, output truncation, backoff. What differs between
 * agents is the spec below: the prompts, the allowlist, and the limits.
 *
 * One invariant is not expressed in the types and matters: a sub-agent's tool
 * calls do not pass through the parent's guard chain (budget, preflight,
 * repeat). An allowlist may therefore only contain tools that spend nothing and
 * create nothing — reads, and work inside a resource the parent already made.
 */

const CONTEXT_WARN_FRACTION = 0.85;
const CONTEXT_MAX_FRACTION = 0.95;
const FALLBACK_CONTEXT_WINDOW = 200_000;
const NESTED_CALL_TIMEOUT_MS = 120_000;
/** A call repeated this many times with identical arguments earns the nudge. */
const REPETITION_THRESHOLD = 3;
/** Two cuts and the run reports what it has rather than looping on the limit. */
const MAX_LENGTH_CUT_RETRIES = 2;

export type NestedCompletionBase = Omit<ChatCompletionCreateParamsStreaming, "messages"> & {
	reasoning_effort?: "low" | "medium" | "high";
};

export interface NestedAgentDeps {
	openai: OpenAI;
	/**
	 * The main loop's request base. The nested loop swaps stream/tools/messages
	 * and inherits everything else — model, sampling, reasoning effort.
	 */
	completionBase: NestedCompletionBase;
	requestHeaders: Record<string, string>;
	servers: McpServerConfig[];
	/**
	 * The turn's connectors, when some are loaded on demand (ADR 0104). `version` goes up when
	 * tools were added to `servers`, `mapping` and `mcpTools`, which are changed in place; a
	 * sub-agent allowed `load_tools` then offers itself the new ones.
	 */
	connectors?: { readonly version: number };
	mapping: Record<string, McpToolMapping>;
	mcpTools: OpenAiTool[];
	/** Every builtin offered this turn; filtered by the spec's allowlist here. */
	hostBuiltinTools: BuiltinTool[];
	contextLengthTokens?: number;
	/**
	 * The turn's tool-approval state (ADR 0075). A sub-agent cannot park the turn
	 * on a question the way the main loop does, so under the `manual` policy it
	 * may only call an MCP tool the conversation has already approved; anything
	 * else is refused, never run. Absent means `manual` with nothing approved.
	 */
	toolApproval?: {
		policy: "always-allow" | "manual";
		approvedTools: ReadonlySet<string>;
	};
}

/** What a run reports as it goes, for a surface that shows it live. */
export interface NestedAgentObserver {
	/** A round of calls is about to run. */
	calling?(calls: Array<{ id: string; name: string; arguments: string }>): void;
	/** One call finished, or was refused. */
	step?(step: {
		id: string;
		name: string;
		arguments: string;
		outcome: "ok" | "error" | "refused";
		error?: string;
	}): void;
	/** Anything else worth a status line (a retry, wrapping up). */
	activity?(text: string): void;
}

export interface NestedAgentSpec {
	/** Lowercase, for log prefixes: `[research]`, `[sandbox]`. */
	label: string;
	/** Sentence-cased, for model-facing error text: "Research agent LLM error". */
	displayName: string;
	systemPrompt: string;
	/** The single user message the run starts from. */
	task: string;
	allowedTools: ReadonlySet<string>;
	/**
	 * Where an allowlisted MCP tool has to come from, when the name alone is not
	 * proof. Any selected server may export a tool called `hf_sandbox_exec`, and
	 * a name only gets a collision suffix when two servers offer it at once — so
	 * if the Hub's listing omits it or fails, a custom server's tool inherits the
	 * bare name and clears a name-only allowlist. The sub-agent would then hand
	 * that server a Hub sandbox handle, outside the parent's guard chain.
	 *
	 * Omitted where an agent's tools legitimately span servers and are read-only.
	 */
	requireToolServer?: (server: McpServerConfig) => boolean;
	/**
	 * An extra gate, composed after the schema preflight. For a restriction the
	 * name-based allowlist cannot express — never the budget guard, whose
	 * absence the allowlist is what compensates for.
	 */
	guard?: ToolCallGuard;
	maxIterations: number;
	/**
	 * Cumulative tokens (every request's `total_tokens`, summed) after which the
	 * run stops working and answers with what it has. Absent means no budget
	 * beyond the context window.
	 */
	maxTotalTokens?: number;
	/** Wall-clock limit for the whole run, in ms; the run then answers with what it has. */
	deadlineMs?: number;
	observer?: NestedAgentObserver;
	truncateOutput(text: string): string;
	/** Injected to steer the loop when it has to stop or is going in circles. */
	stop: {
		contextWarn: string;
		contextMax: string;
		iterationLimit: string;
		repetition: string;
		/** Falls back to `iterationLimit` when absent. */
		budget?: string;
		timeLimit?: string;
	};
	/** Returned when a run ends with nothing usable. */
	failure: {
		noTools: string;
		contextMax: string;
		iterationLimit: string;
		noSummary: string;
		rateLimited: string;
		budget?: string;
		timeLimit?: string;
	};
	progress: { start: string; done: string };
}

/**
 * A builtin whose definition is static but whose loop needs the turn's request
 * plumbing. runMcpFlow binds every one of these with the same deps, so a new
 * sub-agent is registered in one place and wired in none.
 */
export interface NestedAgentBuiltinTool extends BuiltinTool {
	bind(deps: NestedAgentDeps): void;
}

export function isNestedAgentTool(tool: BuiltinTool): tool is NestedAgentBuiltinTool {
	return typeof (tool as { bind?: unknown }).bind === "function";
}

/** What a sub-agent's refusal of an unapproved MCP tool starts with; the card and the caller key off it. */
export const APPROVAL_REFUSAL_PREFIX = "This tool needs the person's approval";

/**
 * The gate that stands in for the approval card inside a sub-agent. The main
 * loop meets an unapproved tool by parking the turn on a question and resuming
 * it when the person answers (`toolApproval.ts`, `resumeElicitation.ts`); a
 * sub-agent is an in-memory loop inside one tool call and cannot be parked, so
 * it never gets to ask. It may use a tool the conversation already approved
 * (or any tool under `always-allow`), and is told plainly about the rest, so
 * that it can carry on without it and say so in its answer.
 */
export function createSubAgentApprovalGuard(
	mapping: Record<string, McpToolMapping>,
	approval: NestedAgentDeps["toolApproval"]
): ToolCallGuard {
	return {
		allowParking: false,
		async before(call) {
			if (approval?.policy === "always-allow") return { allow: true };
			const entry = mapping[call.fnName];
			const qualified = entry ? `${entry.server}:${entry.tool}` : call.fnName;
			if (approval?.approvedTools.has(qualified)) return { allow: true };
			return {
				allow: false,
				message:
					`${APPROVAL_REFUSAL_PREFIX} (${qualified}), and a sub-agent cannot ask for it. ` +
					"Do not retry it. Carry on with the other tools, or say in your answer that this step needs the person's approval.",
			};
		},
		async after() {
			return undefined;
		},
	};
}

/** Head and tail, because the head carries the finding and the tail the totals. */
export function makeTruncator(maxChars: number, head: number, tail: number) {
	return (output: string): string => {
		if (output.length <= maxChars) return output;
		// Both slice points can land mid-surrogate-pair; see loneSurrogates.ts for
		// why one such character 400s every request that carries the message.
		return stripLoneSurrogates(
			output.slice(0, head) + "\n...(truncated)...\n" + output.slice(-tail)
		);
	};
}

/** JSON with object keys sorted at every depth, so arg order can't defeat the repetition check. */
const stableStringify = (value: unknown): string =>
	JSON.stringify(value, (_key, val: unknown) =>
		val && typeof val === "object" && !Array.isArray(val)
			? Object.fromEntries(
					Object.entries(val as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
				)
			: val
	) ?? "";

export async function runNestedAgent(
	spec: NestedAgentSpec,
	ctx: BuiltinToolContext,
	deps: NestedAgentDeps
): Promise<BuiltinToolResult> {
	const allowedBuiltins = deps.hostBuiltinTools.filter((tool) => spec.allowedTools.has(tool.name));
	const builtinNames = new Set(allowedBuiltins.map((tool) => tool.name));
	// Builtins run in this process, so provenance is not a question for them.
	const serversByName = new Map(deps.servers.map((server) => [server.name, server]));
	const fromAllowedServer = (fnName: string): boolean => {
		if (!spec.requireToolServer) return true;
		const server = serversByName.get(deps.mapping[fnName]?.server ?? "");
		return server ? spec.requireToolServer(server) : false;
	};
	const nestedTools: OpenAiTool[] = [
		...allowedBuiltins.map((tool) => tool.definition),
		...deps.mcpTools.filter(
			(tool) =>
				spec.allowedTools.has(tool.function.name) &&
				!builtinNames.has(tool.function.name) &&
				fromAllowedServer(tool.function.name)
		),
	];
	if (nestedTools.length === 0) return { error: spec.failure.noTools };
	const availableNames = new Set(nestedTools.map((tool) => tool.function.name));
	// A sub-agent allowed `load_tools` may call what it loads, and what it loads is loaded for the
	// whole conversation. The list it was given at the start grows as the turn's does.
	// Only tools added after this agent started count: one that was on offer at the start and left
	// out of its allowlist stays out, whoever loads what afterwards.
	let seenConnectorsVersion = deps.connectors?.version ?? 0;
	const startToolCount = deps.mcpTools.length;
	const offeredAtStart = new Set(deps.mcpTools.map((tool) => tool.function.name));
	const refreshLoadedTools = () => {
		const version = deps.connectors?.version ?? 0;
		if (version === seenConnectorsVersion) return;
		seenConnectorsVersion = version;
		if (!builtinNames.has(LOAD_TOOLS_TOOL_NAME)) return;
		const current = new Map(deps.servers.map((server) => [server.name, server]));
		for (const tool of deps.mcpTools.slice(startToolCount)) {
			const name = tool.function.name;
			if (availableNames.has(name) || builtinNames.has(name) || offeredAtStart.has(name)) continue;
			const server = current.get(deps.mapping[name]?.server ?? "");
			if (spec.requireToolServer && !(server && spec.requireToolServer(server))) continue;
			nestedTools.push(tool);
			availableNames.add(name);
		}
	};
	// Preflight first: it books nothing, which is the ordering composeGuards requires.
	// The approval gate follows it, and is always there: a sub-agent never runs
	// an MCP tool the person would have been asked about in the main chat.
	const approvalGuard = createSubAgentApprovalGuard(deps.mapping, deps.toolApproval);
	const preflightGuard = [
		createSchemaPreflightGuard(deps.mapping),
		approvalGuard,
		...(spec.guard ? [spec.guard] : []),
	].reduce(composeGuards);

	let messages: ChatCompletionMessageParam[] = [
		{ role: "system", content: spec.systemPrompt },
		{ role: "user", content: spec.task },
	];

	// The parent's tool set and tool_choice never reach the sub-agent; stream
	// is overridden per request below.
	const base = { ...deps.completionBase };
	delete base.tools;
	delete base.tool_choice;

	// Budget thresholds are fractions of the USABLE window: what remains after
	// reserving the completion allowance every request asks for. Without the
	// reservation, a large max_tokens lets a request exceed the window between
	// the 85% nudge and the 95% stop — an unrecoverable provider error instead
	// of a forced summary. The floor guards a degenerate reserve that would
	// leave no room to work at all.
	const windowTokens = deps.contextLengthTokens ?? FALLBACK_CONTEXT_WINDOW;
	const completionReserve = typeof base.max_tokens === "number" ? base.max_tokens : 0;
	const usableTokens = Math.max(windowTokens - completionReserve, Math.floor(windowTokens / 4));
	const contextWarnAt = Math.floor(usableTokens * CONTEXT_WARN_FRACTION);
	const contextMaxAt = Math.floor(usableTokens * CONTEXT_MAX_FRACTION);

	// The run's own clock. A user's Stop ends everything at once; the deadline
	// ends the work but still lets the run answer with what it found.
	const deadlineSignal = spec.deadlineMs ? AbortSignal.timeout(spec.deadlineMs) : undefined;
	const runSignal =
		ctx.abortSignal && deadlineSignal
			? AbortSignal.any([ctx.abortSignal, deadlineSignal])
			: (ctx.abortSignal ?? deadlineSignal);
	const timedOut = () => Boolean(deadlineSignal?.aborted) && !ctx.abortSignal?.aborted;
	const observer = spec.observer;

	const complete = async (withTools: boolean, signal: AbortSignal | undefined) => {
		refreshLoadedTools();
		const request: ChatCompletionCreateParamsNonStreaming = {
			...base,
			stream: false,
			messages,
			// Omitting `tools` entirely is what forces the final summary: the
			// budget prompt alone is a suggestion the model can ignore; an
			// absent tool list is a constraint it can't.
			...(withTools ? { tools: nestedTools, tool_choice: "auto" as const } : {}),
		};
		return deps.openai.chat.completions.create(request, {
			signal,
			headers: deps.requestHeaders,
			timeout: NESTED_CALL_TIMEOUT_MS,
		});
	};

	const emitProgress = (iteration: number, message: string) => {
		if (!message.startsWith("▸")) observer?.activity?.(message);
		ctx.elicitationSink?.emit({
			type: MessageUpdateType.Tool,
			subtype: MessageToolUpdateType.Progress,
			uuid: ctx.uuid,
			progress: iteration,
			total: spec.maxIterations,
			message,
		});
	};

	// A throttle or a brief router outage mid-run must not discard the
	// iterations already spent; the run is minutes long anyway, so it absorbs
	// the backoff itself. Only when the schedule runs out does the error
	// surface — with instructions to wait, so the model reaches for the wait
	// tool instead of hammering the sub-agent again.
	const completeWithRetry = (
		withTools: boolean,
		iteration: number,
		signal: AbortSignal | undefined
	) =>
		withUpstreamRetry(() => complete(withTools, signal), {
			signal,
			onBackoff: (attempt, delayMs, err) => {
				logger.warn(
					{ attempt, delayMs, iteration, err: String(err) },
					`[${spec.label}] upstream failure; backing off in-loop`
				);
				const cause = isRateLimitError(err) ? "Rate limited" : "Upstream error";
				emitProgress(iteration, `${cause} — retrying in ${Math.round(delayMs / 1000)}s`);
			},
		});

	const forcedSummary = async (
		stopPrompt: string,
		failureText: string
	): Promise<BuiltinToolResult> => {
		messages = [...messages, { role: "user", content: stopPrompt }];
		try {
			// The user's signal only: a run that ran out of time or budget still
			// owes its answer, and the deadline would cancel that request too.
			const response = await completeWithRetry(false, spec.maxIterations, ctx.abortSignal);
			const content = response.choices[0]?.message?.content ?? "";
			return content ? { resultText: content } : { error: failureText };
		} catch (err) {
			logger.warn({ err: String(err) }, `[${spec.label}] forced summary call failed`);
			return { error: failureText };
		}
	};

	let totalTokens = 0;
	let spentTokens = 0;
	let warned = false;
	const callCounts = new Map<string, number>();
	let repetitionNudged = false;
	let lengthCutRetries = 0;

	emitProgress(0, spec.progress.start);

	for (let iteration = 0; iteration < spec.maxIterations; iteration += 1) {
		if (ctx.abortSignal?.aborted) return { error: "Aborted by user" };

		if (timedOut()) {
			logger.warn({ iteration }, `[${spec.label}] time limit reached; forcing summary`);
			emitProgress(iteration, "Time limit reached — wrapping up");
			return forcedSummary(
				spec.stop.timeLimit ?? spec.stop.iterationLimit,
				spec.failure.timeLimit ?? spec.failure.iterationLimit
			);
		}
		if (spec.maxTotalTokens !== undefined && spentTokens >= spec.maxTotalTokens) {
			logger.warn(
				{ spentTokens, iteration },
				`[${spec.label}] token budget spent; forcing summary`
			);
			emitProgress(iteration, "Token budget spent — wrapping up");
			return forcedSummary(
				spec.stop.budget ?? spec.stop.iterationLimit,
				spec.failure.budget ?? spec.failure.iterationLimit
			);
		}
		if (totalTokens >= contextMaxAt) {
			logger.warn(
				{ totalTokens, iteration },
				`[${spec.label}] context max reached; forcing summary`
			);
			emitProgress(iteration, "Context limit reached — wrapping up");
			return forcedSummary(spec.stop.contextMax, spec.failure.contextMax);
		}
		if (!warned && totalTokens >= contextWarnAt) {
			warned = true;
			messages = [...messages, { role: "user", content: spec.stop.contextWarn }];
		}

		let response: Awaited<ReturnType<typeof complete>>;
		try {
			response = await completeWithRetry(true, iteration, runSignal);
		} catch (err) {
			if (ctx.abortSignal?.aborted) return { error: "Aborted by user" };
			if (timedOut()) {
				emitProgress(iteration, "Time limit reached — wrapping up");
				return forcedSummary(
					spec.stop.timeLimit ?? spec.stop.iterationLimit,
					spec.failure.timeLimit ?? spec.failure.iterationLimit
				);
			}
			const message = err instanceof Error ? err.message : String(err);
			logger.warn({ err: message, iteration }, `[${spec.label}] sub-agent LLM call failed`);
			if (isRateLimitError(err)) return { error: spec.failure.rateLimited };
			return { error: `${spec.displayName} agent LLM error: ${message}` };
		}

		totalTokens =
			response.usage?.total_tokens ??
			// No usage from this provider: a rough absolute estimate keeps the
			// budget stop functional instead of never firing.
			Math.ceil(JSON.stringify(messages).length / 4);
		// Every request re-sends the context, so the sum of what each one cost
		// is what the person is billed for the run.
		spentTokens += totalTokens;

		const msg = response.choices[0]?.message;
		const finishReason = response.choices[0]?.finish_reason;
		const toolCalls = msg?.tool_calls ?? [];
		if (!msg || toolCalls.length === 0) {
			// Cut by the output limit is not a finished summary — with reasoning
			// models it usually died mid-think. Nudge it to answer within budget;
			// after two cuts, surface whatever content exists rather than looping.
			if (finishReason === "length" && lengthCutRetries < MAX_LENGTH_CUT_RETRIES) {
				lengthCutRetries += 1;
				logger.warn(
					{ iteration, attempt: lengthCutRetries },
					`[${spec.label}] response cut by the output limit; nudging to finish`
				);
				messages = [
					...messages,
					{
						role: "assistant",
						content:
							msg?.content?.trim() || "(Response cut off by the output limit mid-reasoning.)",
					},
					{
						role: "user",
						content:
							"[SYSTEM: Your previous response hit the output limit before it finished. Continue: finish the step or produce the summary now, with minimal further reasoning.]",
					},
				];
				continue;
			}
			const content = msg?.content ?? "";
			emitProgress(iteration + 1, spec.progress.done);
			return content ? { resultText: content } : { error: spec.failure.noSummary };
		}

		// Wire-safe rebuild: only role/content/tool_calls go back. The raw
		// message can carry provider fields (reasoning_content and friends)
		// that OpenAI-compatible backends reject when echoed; content is
		// always present — the streamed preamble, else null. Omitting the key
		// reads as `undefined` on backends that validate presence (llmbase
		// 400s), and "" breaks the kind that rejects empty text next to
		// tool_calls.
		messages = [
			...messages,
			{
				role: "assistant",
				// Same guard as the parent loop: an unparseable payload echoed back
				// 400s every later request of the run. See withParseableArguments.
				tool_calls: withParseableArguments(toolCalls),
				content:
					typeof msg.content === "string" && msg.content.trim().length > 0 ? msg.content : null,
			},
		];

		const allowedCalls: NormalizedToolCall[] = [];
		const refusedCalls: LoggedCall[] = [];
		const refusals: ChatCompletionMessageParam[] = [];
		const repeatCounts = new Map<string, number>();
		let sawRepetition = false;
		for (const call of toolCalls) {
			const name = call.function?.name ?? "";
			const rawArguments = call.function?.arguments ?? "";
			// Counted before the allowlist splits them: a refused call repeated is
			// the loop this log exists to make visible, and it never reaches the
			// executor to be counted later.
			const key = `${name}|${stableStringify(parseToolArguments(rawArguments) ?? rawArguments)}`;
			const count = (callCounts.get(key) ?? 0) + 1;
			callCounts.set(key, count);
			if (count >= REPETITION_THRESHOLD) sawRepetition = true;
			repeatCounts.set(call.id, count);

			if (!availableNames.has(name)) {
				refusals.push({
					role: "tool",
					tool_call_id: call.id,
					content: `Tool '${name}' not available for ${spec.label}.`,
				});
				refusedCalls.push({ id: call.id, name, arguments: rawArguments, repeatCount: count });
				continue;
			}
			allowedCalls.push({ id: call.id, name, arguments: rawArguments });
		}

		let toolMessages: ChatCompletionMessageParam[] = [];
		if (allowedCalls.length > 0) {
			observer?.calling?.(
				allowedCalls.map(({ id, name, arguments: args }) => ({ id, name, arguments: args }))
			);
			emitProgress(
				iteration + 1,
				// One per line: the UI renders each as its own row.
				allowedCalls.map((call) => `▸ ${call.name} ${call.arguments.slice(0, 80)}`).join("\n")
			);
			const exec = executeToolCalls({
				calls: allowedCalls,
				mapping: deps.mapping,
				servers: deps.servers,
				parseArgs: parseToolArguments,
				toPrimitive,
				processToolOutput: (text) => ({ annotated: text, sources: [] }),
				abortSignal: runSignal,
				builtinTools: allowedBuiltins,
				// Preflight only. The budget guard stays absent by design — the
				// allowlist is what keeps a sub-agent from spending — but checking
				// a call against its own schema is not a policy, it is the round
				// trip and the iteration this run would otherwise lose.
				guard: preflightGuard,
				// No `elicitation`: the sub-agent has no chat to ask, so an
				// input-required response comes back as an ordinary tool error.
			});
			for await (const event of exec) {
				// The sub-agent's raw Call/Result updates stay internal — the
				// whole point is that only the summary reaches the outer
				// conversation. Progress is reported on the parent call itself.
				if (event.type === "complete") {
					toolMessages = event.summary.toolMessages;
				}
			}
		}

		messages = [
			...messages,
			...refusals,
			...toolMessages.map((message) =>
				message.role === "tool" && typeof message.content === "string"
					? { ...message, content: spec.truncateOutput(message.content) }
					: message
			),
		];

		// Refusals never reach executeToolCalls, so they carry their own name,
		// arguments and count rather than being reconstructed from the message.
		if (observer?.step) {
			const resultOf = new Map<string, string>();
			for (const message of toolMessages) {
				if (message.role === "tool" && typeof message.content === "string") {
					resultOf.set(message.tool_call_id, message.content);
				}
			}
			for (const call of allowedCalls) {
				const content = resultOf.get(call.id);
				const failed = content === undefined || content.startsWith("Error: ");
				observer.step({
					id: call.id,
					name: call.name,
					arguments: call.arguments,
					outcome: !failed
						? "ok"
						: content?.slice(7).startsWith(APPROVAL_REFUSAL_PREFIX)
							? "refused"
							: "error",
					...(failed && content ? { error: content.slice(7) } : {}),
				});
			}
			for (const call of refusedCalls) {
				observer.step({
					id: call.id,
					name: call.name,
					arguments: call.arguments,
					outcome: "refused",
				});
			}
		}

		recordNestedAgentCalls(
			ctx,
			spec.label,
			iteration,
			allowedCalls.map((call) => ({
				id: call.id,
				name: call.name,
				arguments: call.arguments,
				repeatCount: repeatCounts.get(call.id) ?? 1,
			})),
			toolMessages,
			refusedCalls
		);

		if (sawRepetition && !repetitionNudged) {
			repetitionNudged = true;
			logger.warn({ iteration }, `[${spec.label}] repetition guard activated`);
			messages = [...messages, { role: "user", content: spec.stop.repetition }];
		}
	}

	logger.warn({}, `[${spec.label}] iteration limit reached; extracting summary`);
	emitProgress(spec.maxIterations, "Iteration limit reached — extracting summary");
	return forcedSummary(spec.stop.iterationLimit, spec.failure.iterationLimit);
}
