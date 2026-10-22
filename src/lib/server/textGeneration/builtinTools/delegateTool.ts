import type { BuiltinTool, BuiltinToolContext, BuiltinToolResult } from "./types";
import {
	APPROVAL_REFUSAL_PREFIX,
	makeTruncator,
	runNestedAgent,
	type NestedAgentBuiltinTool,
	type NestedAgentDeps,
	type NestedAgentObserver,
	type NestedAgentSpec,
} from "./nestedAgent";
import { WEB_SEARCH_TOOL_NAME } from "./gatewaySearchTool";
import { WEB_FETCH_TOOL_NAME } from "./fetchUrlUtils";
import { WEB_FETCH_STRUCTURED_TOOL_NAME } from "./webFetchStructuredTool";
import { redactSecrets } from "./nestedAgentCallLog";
import { logger } from "$lib/server/logger";
import {
	MessageUpdateType,
	type MessageSubAgentUpdate,
	type SubAgentStep,
	type SubAgentStatus,
} from "$lib/types/MessageUpdate";

export const DELEGATE_TOOL_NAME = "delegate";
export const RESEARCH_TOOL_NAME = "research";

/** Sub-agents running at once in one turn; a further call is refused. */
export const MAX_PARALLEL_SUBAGENTS = 3;
/** Rounds of tool calls one sub-agent may make. */
export const SUBAGENT_MAX_STEPS = 25;
/** Cumulative tokens (every request's usage, summed) one sub-agent may spend. */
export const SUBAGENT_TOKEN_BUDGET = 400_000;
/** Wall-clock limit for one sub-agent. */
export const SUBAGENT_TIMEOUT_MS = 8 * 60_000;

const TITLE_MAX = 60;
const TASK_MIN_CHARS = 12;
const TASK_MAX_CHARS = 20_000;
const MAX_SOURCES = 8;
const MAX_STEPS_SHOWN = 60;
const MODEL_LIST_IN_DESCRIPTION = 12;

/**
 * The builtins a sub-agent may use, by name: the server-side tools that read
 * the web. Never `execute_code` (it runs in the person's browser through a
 * parked call, which a sub-agent cannot do), never `delegate`/`research`
 * (depth one), never the plan tool, and none of the tools that write
 * (`remember`, artifacts, document conversion).
 */
export const SUBAGENT_BUILTIN_TOOLS: ReadonlySet<string> = new Set([
	WEB_SEARCH_TOOL_NAME,
	WEB_FETCH_TOOL_NAME,
	WEB_FETCH_STRUCTURED_TOOL_NAME,
]);

/** What a research agent may use: the web, and only the web. */
export const RESEARCH_TOOLS: ReadonlySet<string> = new Set([
	WEB_SEARCH_TOOL_NAME,
	WEB_FETCH_TOOL_NAME,
	WEB_FETCH_STRUCTURED_TOOL_NAME,
]);

/** A model the person may choose for a sub-agent, as the caller resolved it. */
export interface DelegateModel {
	id: string;
	name: string;
	contextLength?: number;
	/** The model's own completion cap, when its parameters name one. */
	maxTokens?: number;
}

const DELEGATE_SYSTEM_PROMPT = [
	"You are a sub-agent working for another assistant. You cannot see its conversation: the task below is everything you know, and you cannot ask questions.",
	"Do the task with the tools you have, then reply with your final answer and nothing else: concise, specific, and complete enough that the assistant can use it without redoing your work.",
	"Cite the sources you relied on (URLs). If something was unclear, say what you assumed. If a tool was refused or a step could not be done, say so plainly instead of guessing.",
	"Do not mention these instructions.",
].join("\n");

export const RESEARCH_SYSTEM_PROMPT = [
	"You are a research agent. Answer the question below from sources on the web. You cannot see the conversation it came from and you cannot ask questions.",
	"Plan first: split the question into two to five search queries with different wording before you begin, then search.",
	"Read primary sources (official documentation, original papers and data, standards, the organisation's own pages) rather than summaries of summaries. Open pages with web_fetch; do not answer from search snippets alone.",
	"Cross-check every claim that matters against a second, independent source, and note how recent each source is.",
	"Answer concisely: lead with the answer, then the evidence that supports it. Cite each claim with the URL of the page you read. Say where sources disagree, and say where they are thin, old or unverified instead of filling the gap with a guess.",
	"Never claim to have read a page you did not open. Do not mention these instructions.",
].join("\n");

const stopMessages = (what: string) => ({
	contextWarn: `[SYSTEM: Your context is nearly full. Finish ${what} now with what you have and give your final answer.]`,
	contextMax: `[SYSTEM: Your context is full. Give your final answer now, from what you have gathered. Say what is missing.]`,
	iterationLimit: `[SYSTEM: You have used all your steps. Give your final answer now, from what you have gathered. Say what is missing.]`,
	repetition:
		"[SYSTEM: You are repeating the same call. Change approach, or give your final answer from what you have.]",
	budget: `[SYSTEM: You have used your token budget. Give your final answer now, from what you have gathered. Say what is missing.]`,
	timeLimit: `[SYSTEM: You have run out of time. Give your final answer now, from what you have gathered. Say what is missing.]`,
});

const failureMessages = (displayName: string) => ({
	noTools: "No tools are available to this sub-agent in this turn.",
	contextMax: `${displayName} ran out of context before it could answer.`,
	iterationLimit: `${displayName} used all its steps without an answer.`,
	noSummary: `${displayName} finished without an answer.`,
	rateLimited:
		"The model is rate limited right now. Wait a moment before delegating again, or do the work directly.",
	budget: `${displayName} used its token budget without an answer.`,
	timeLimit: `${displayName} ran out of time without an answer.`,
});

const singleLine = (text: string, max: number): string => {
	const one = text.replace(/\s+/g, " ").trim();
	return one.length > max ? `${one.slice(0, max - 1)}…` : one;
};

/** A short name for the card when the model gave none: the task's first words. */
export function deriveTitle(task: string): string {
	return singleLine(task.split("\n")[0] ?? task, 48) || "Sub-agent";
}

function parseJson(raw: string): Record<string, unknown> {
	try {
		const value: unknown = JSON.parse(raw);
		return typeof value === "object" && value !== null && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
}

const hostAndPath = (value: unknown): string => {
	if (typeof value !== "string") return "a page";
	try {
		const url = new URL(value);
		return singleLine(`${url.host}${url.pathname === "/" ? "" : url.pathname}`, 60);
	} catch {
		return singleLine(value, 60);
	}
};

/** How the card names one call: present tense for the live line, plain for the list. */
export function describeCall(
	name: string,
	rawArguments: string
): { activity: string; label: string } {
	const args = parseJson(rawArguments);
	if (name === WEB_SEARCH_TOOL_NAME) {
		const query = singleLine(redactSecrets(String(args.query ?? "")), 70);
		return { activity: `searching “${query}”`, label: `search “${query}”` };
	}
	if (name === WEB_FETCH_TOOL_NAME) {
		const target = hostAndPath(args.url);
		return { activity: `reading ${target}`, label: `read ${target}` };
	}
	if (name === WEB_FETCH_STRUCTURED_TOOL_NAME) {
		const target = hostAndPath(args.url);
		return { activity: `inspecting ${target}`, label: `inspect ${target}` };
	}
	return { activity: `calling ${name}`, label: `call ${name}` };
}

/**
 * Tracks one sub-agent's state and re-sends it whole on each change, as the
 * card's single source of truth (`MessageSubAgentUpdate`).
 */
function createCardState(
	ctx: BuiltinToolContext,
	base: { title: string; model: string; preset?: "research" }
) {
	const steps: SubAgentStep[] = [];
	const stepIndex = new Map<string, number>();
	const fetched: string[] = [];
	const blocked = new Set<string>();
	let activity: string | undefined = "starting";
	let status: SubAgentStatus = "running";

	const emit = () => {
		const update: MessageSubAgentUpdate = {
			type: MessageUpdateType.SubAgent,
			uuid: ctx.uuid,
			title: base.title,
			model: base.model,
			...(base.preset ? { preset: base.preset } : {}),
			status,
			...(status === "running" && activity ? { activity } : {}),
			steps: steps.slice(-MAX_STEPS_SHOWN),
		};
		ctx.elicitationSink?.emit(update);
	};

	const observer: NestedAgentObserver = {
		calling(calls) {
			for (const call of calls) {
				const { label } = describeCall(call.name, call.arguments);
				stepIndex.set(call.id, steps.length);
				steps.push({ tool: call.name, label, outcome: "running" });
			}
			const last = calls.at(-1);
			if (last) activity = describeCall(last.name, last.arguments).activity;
			emit();
		},
		step(step) {
			const at = stepIndex.get(step.id);
			const { label } = describeCall(step.name, step.arguments);
			const entry: SubAgentStep = { tool: step.name, label, outcome: step.outcome };
			if (at !== undefined && steps[at]) steps[at] = entry;
			else steps.push(entry);
			if (step.outcome === "ok" && step.name === WEB_FETCH_TOOL_NAME) {
				const url = parseJson(step.arguments).url;
				if (typeof url === "string" && !fetched.includes(url)) fetched.push(url);
			}
			if (step.error?.startsWith(APPROVAL_REFUSAL_PREFIX)) {
				const named = /\(([^)]+)\)/.exec(step.error)?.[1];
				blocked.add(named ?? step.name);
			}
			emit();
		},
		activity(text) {
			activity = singleLine(text, 80);
			emit();
		},
	};

	return {
		observer,
		emit,
		fetched,
		blocked,
		finish(next: SubAgentStatus) {
			status = next;
			activity = undefined;
			// Calls still marked running when the run ended were cut short.
			for (const [i, s] of steps.entries()) {
				if (s.outcome === "running") steps[i] = { ...s, outcome: "error" };
			}
			emit();
		},
	};
}

interface SharedState {
	deps?: NestedAgentDeps;
	active: number;
}

interface RunParams {
	label: string;
	displayName: string;
	title: string;
	task: string;
	systemPrompt: string;
	allowed: Set<string>;
	preset?: "research";
	model?: DelegateModel;
	droppedTools?: string[];
}

/** The completion base for another model: its own id and caps, none of the main model's sampling. */
function baseForModel(model: DelegateModel): NestedAgentDeps["completionBase"] {
	return {
		model: model.id,
		stream: true,
		...(model.maxTokens ? { max_tokens: model.maxTokens } : {}),
	};
}

async function runSubAgent(
	state: SharedState,
	models: DelegateModel[],
	params: RunParams,
	ctx: BuiltinToolContext
): Promise<BuiltinToolResult> {
	const deps = state.deps;
	if (!deps) return { error: "Sub-agents are not available in this turn." };
	if (ctx.abortSignal?.aborted) return { error: "Aborted by user" };
	if (state.active >= MAX_PARALLEL_SUBAGENTS) {
		return {
			error:
				`At most ${MAX_PARALLEL_SUBAGENTS} sub-agents can run at once. ` +
				"Wait for these to return, then delegate the rest, or do it yourself.",
		};
	}

	const runDeps: NestedAgentDeps = params.model
		? {
				...deps,
				completionBase: baseForModel(params.model),
				contextLengthTokens: params.model.contextLength,
			}
		: deps;
	const modelId = params.model?.id ?? deps.completionBase.model;
	const modelLabel = params.model?.name ?? models.find((m) => m.id === modelId)?.name ?? modelId;

	const card = createCardState(ctx, {
		title: params.title,
		model: modelLabel,
		...(params.preset ? { preset: params.preset } : {}),
	});
	const spec: NestedAgentSpec = {
		label: params.label,
		displayName: params.displayName,
		systemPrompt: params.systemPrompt,
		task: params.task,
		allowedTools: params.allowed,
		maxIterations: SUBAGENT_MAX_STEPS,
		maxTotalTokens: SUBAGENT_TOKEN_BUDGET,
		deadlineMs: SUBAGENT_TIMEOUT_MS,
		observer: card.observer,
		truncateOutput: makeTruncator(12_000, 8_000, 3_000),
		stop: stopMessages("the task"),
		failure: failureMessages(params.displayName),
		progress: { start: `${params.displayName} started`, done: `${params.displayName} finished` },
	};

	state.active += 1;
	card.emit();
	let outcome: BuiltinToolResult;
	try {
		outcome = await runNestedAgent(spec, ctx, runDeps);
	} catch (err) {
		logger.warn({ err: String(err), label: params.label }, "[delegate] sub-agent crashed");
		outcome = {
			error: `${params.displayName} failed: ${err instanceof Error ? err.message : String(err)}`,
		};
	} finally {
		state.active -= 1;
	}

	if ("resultText" in outcome) {
		card.finish("done");
		return { resultText: withNotes(outcome.resultText, card, params.droppedTools) };
	}
	const stopped = ctx.abortSignal?.aborted === true;
	card.finish(stopped ? "stopped" : "failed");
	if ("error" in outcome && card.blocked.size > 0 && !stopped) {
		return { error: `${outcome.error}${approvalNote(card.blocked)}` };
	}
	return outcome;
}

function approvalNote(blocked: Set<string>): string {
	return (
		`\n\n(The sub-agent could not use ${[...blocked].join(", ")}: it needs the person's approval, ` +
		"and only you can ask for it. Call it yourself if you need it.)"
	);
}

/** The answer, plus what only the loop knows: pages it read, tools it was refused. */
function withNotes(
	answer: string,
	card: { fetched: string[]; blocked: Set<string> },
	dropped: string[] | undefined
): string {
	let text = answer.trim();
	const missing = card.fetched.filter((url) => !text.includes(url)).slice(0, MAX_SOURCES);
	if (missing.length > 0)
		text += `\n\nPages the sub-agent read:\n${missing.map((u) => `- ${u}`).join("\n")}`;
	if (card.blocked.size > 0) text += approvalNote(card.blocked);
	if (dropped && dropped.length > 0) {
		text += `\n\n(Left out, because sub-agents cannot use them: ${dropped.join(", ")}.)`;
	}
	return text;
}

export interface DelegateToolsParams {
	/** The models this person may choose for a sub-agent: tool-capable, never `custom:`. */
	models: DelegateModel[];
	/** Offer the `research` preset too (web search is available this turn). */
	research: boolean;
}

/**
 * `delegate` and the `research` preset. Both are sub-agent builtins: static
 * definitions, bound to the turn's request plumbing by runMcpFlow. One counter
 * spans them, so three sub-agents run at once however they were started.
 */
export function createDelegateTools(params: DelegateToolsParams): NestedAgentBuiltinTool[] {
	const state: SharedState = { active: 0 };
	const bind = (deps: NestedAgentDeps) => {
		state.deps = deps;
	};

	const modelIds = params.models.map((m) => m.id);
	const shown = modelIds.slice(0, MODEL_LIST_IN_DESCRIPTION);
	const modelHint =
		shown.length > 0
			? `Optional: another model, one of ${shown.join(", ")}${modelIds.length > shown.length ? ", …" : ""}. Default: this conversation's model.`
			: "Leave unset: this conversation's model is used.";

	const delegate: NestedAgentBuiltinTool = {
		name: DELEGATE_TOOL_NAME,
		bind,
		definition: {
			type: "function",
			function: {
				name: DELEGATE_TOOL_NAME,
				description:
					"Hand a self-contained sub-task to a sub-agent that works on its own, in a fresh context, and " +
					"returns only its final answer. It cannot see this conversation: put everything it needs in `task`. " +
					`Several delegate calls in one step run in parallel (at most ${MAX_PARALLEL_SUBAGENTS}).`,
				parameters: {
					type: "object",
					properties: {
						task: {
							type: "string",
							description:
								"The full brief: the goal, the context, what to return, and any limits. The sub-agent knows nothing else.",
						},
						title: {
							type: "string",
							description: "A few words naming the sub-task, shown to the person.",
						},
						tools: {
							type: "array",
							items: { type: "string" },
							description:
								"Optional: the tools it may use, a subset of this chat's server-side tools (web search, web fetch, connectors). Default: all of them.",
						},
						model: { type: "string", description: modelHint },
					},
					required: ["task"],
				},
			},
		},
		preprompt:
			"DELEGATION: use delegate for a self-contained sub-task, for comparisons or lookups that can run side by side, or for long reading that would bloat this conversation. " +
			"Write a full brief, since the sub-agent sees nothing else, and put independent sub-tasks in the same step so they run in parallel. " +
			"Do not delegate a quick lookup, work that needs the conversation's context, or a step you must do yourself (code in the browser, a plan, a question for the person). " +
			"Check what comes back before relying on it.",
		async execute(args, ctx) {
			const deps = state.deps;
			if (!deps) return { error: "Sub-agents are not available in this turn." };

			const task = typeof args.task === "string" ? args.task.trim() : "";
			if (task.length < TASK_MIN_CHARS) {
				return {
					error:
						"delegate needs a `task`: the full brief for the sub-agent, which cannot see this conversation.",
				};
			}
			if (task.length > TASK_MAX_CHARS) {
				return { error: `The brief is too long (limit ${TASK_MAX_CHARS} characters). Shorten it.` };
			}
			const titleArg = typeof args.title === "string" ? singleLine(args.title, TITLE_MAX) : "";

			// The model: the person's own catalogue only, validated here and not
			// trusted from the model. A custom model is a prompt wrapper around a
			// base and never goes through this path.
			let model: DelegateModel | undefined;
			const requested = typeof args.model === "string" ? args.model.trim() : "";
			if (requested && requested !== deps.completionBase.model) {
				if (requested.startsWith("custom:")) {
					return {
						error: "A custom model cannot be used for a sub-agent. Pick a catalogue model.",
					};
				}
				model = params.models.find((m) => m.id === requested);
				if (!model) {
					return {
						error:
							`The model '${requested}' is not one you can use here. ` +
							(modelIds.length > 0
								? `Choose one of: ${modelIds.slice(0, 20).join(", ")}, or leave it unset.`
								: "Leave it unset to use this conversation's model."),
					};
				}
			}

			// The tools: this turn's server-side tools, narrowed to the request.
			const offered = new Set<string>();
			for (const tool of deps.hostBuiltinTools) {
				if (SUBAGENT_BUILTIN_TOOLS.has(tool.name)) offered.add(tool.name);
			}
			const builtinNames = new Set(deps.hostBuiltinTools.map((t) => t.name));
			for (const tool of deps.mcpTools) {
				if (!builtinNames.has(tool.function.name)) offered.add(tool.function.name);
			}
			let allowed = offered;
			let dropped: string[] | undefined;
			if (Array.isArray(args.tools) && args.tools.length > 0) {
				const names = args.tools.filter((t): t is string => typeof t === "string");
				allowed = new Set(names.filter((name) => offered.has(name)));
				const left = [...new Set(names.filter((name) => !offered.has(name)))];
				if (left.length > 0) dropped = left;
				if (allowed.size === 0) {
					return {
						error: `None of those tools can be used by a sub-agent. Available: ${[...offered].join(", ") || "none this turn"}.`,
					};
				}
			}
			if (allowed.size === 0) {
				return { error: "No tools are available to a sub-agent in this chat." };
			}

			return runSubAgent(
				state,
				params.models,
				{
					label: "delegate",
					displayName: "Sub-agent",
					title: titleArg || deriveTitle(task),
					task,
					systemPrompt: DELEGATE_SYSTEM_PROMPT,
					allowed,
					model,
					droppedTools: dropped,
				},
				ctx
			);
		},
	};

	const tools: NestedAgentBuiltinTool[] = [delegate];
	if (params.research) {
		tools.push({
			name: RESEARCH_TOOL_NAME,
			bind,
			definition: {
				type: "function",
				function: {
					name: RESEARCH_TOOL_NAME,
					description:
						"Research a question on the web with a sub-agent that plans queries, reads primary sources, " +
						"cross-checks them and returns a concise, cited answer. Use it for questions that need several " +
						"searches and pages. It sees only the question you give it, so make it self-contained.",
					parameters: {
						type: "object",
						properties: {
							question: {
								type: "string",
								description: "The question to research, with any context needed to understand it.",
							},
							title: {
								type: "string",
								description: "A few words naming the research, shown to the person.",
							},
						},
						required: ["question"],
					},
				},
			},
			preprompt:
				"RESEARCH: for a question that needs several searches and sources, call research with a self-contained question instead of searching page by page yourself; it returns a cited answer. " +
				"Use web_search directly for a single quick lookup.",
			async execute(args, ctx) {
				const deps = state.deps;
				if (!deps) return { error: "Sub-agents are not available in this turn." };
				const question = typeof args.question === "string" ? args.question.trim() : "";
				if (question.length < TASK_MIN_CHARS) {
					return { error: "research needs a `question`: what to find out, stated in full." };
				}
				if (question.length > TASK_MAX_CHARS) {
					return { error: `The question is too long (limit ${TASK_MAX_CHARS} characters).` };
				}
				const allowed = new Set(
					deps.hostBuiltinTools.map((t) => t.name).filter((name) => RESEARCH_TOOLS.has(name))
				);
				if (allowed.size === 0) {
					return {
						error:
							"Web search is not available in this chat, so there is nothing to research with.",
					};
				}
				const titleArg = typeof args.title === "string" ? singleLine(args.title, TITLE_MAX) : "";
				return runSubAgent(
					state,
					params.models,
					{
						label: "research",
						displayName: "Research agent",
						title: titleArg || deriveTitle(question),
						task: question,
						systemPrompt: RESEARCH_SYSTEM_PROMPT,
						allowed,
						preset: "research",
					},
					ctx
				);
			},
		});
	}
	return tools;
}

export function isDelegationTool(tool: Pick<BuiltinTool, "name">): boolean {
	return tool.name === DELEGATE_TOOL_NAME || tool.name === RESEARCH_TOOL_NAME;
}
