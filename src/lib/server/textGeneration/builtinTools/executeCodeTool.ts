import { randomUUID } from "crypto";
import { ObjectId } from "mongodb";
import { config } from "$lib/server/config";
import { collections } from "$lib/server/database";
import { logger } from "$lib/server/logger";
import { LOAD_TIMEOUT_MS, RUN_TIMEOUT_MS } from "$lib/utils/execution/protocol";
import { turnAwaitingInput } from "$lib/server/generation/turnState";
import { MessageCodeExecutionUpdateType, MessageUpdateType } from "$lib/types/MessageUpdate";
import { makeTruncator } from "./nestedAgent";
import type { BuiltinTool } from "./types";
import type { ParkedCall } from "$lib/types/ParkedCall";

/**
 * `execute_code`: a Python snippet run in the USER'S OWN BROWSER sandbox, with
 * the output returned into the model's own context so it can iterate.
 *
 * The execution engine is the browser's Pyodide worker — the same
 * ExecutionSession, queue and timeouts the code fences and artifacts use. The
 * tool parks the turn on the browser over the same park/resume machinery the
 * timer uses (`parkedCalls`, kind `code`): the code streams to the user's
 * browser, their ExecutionSession runs it, the browser posts the outcome back
 * to the resolve endpoint, and the parked row is woken (`resumeAt` moved to
 * now, like `wakeParkedCallEarly`) so the sweeper resumes the turn. If no
 * browser answers before the deadline, the sweeper turns the parked row into
 * the explicit "execution environment unavailable" result the prompt teaches
 * the model to fall back from to a fence.
 *
 * This is the park-and-resume-over-the-browser architecture: server-side
 * execution was evaluated and shelved (no isolation between tenants on one
 * shared container; per-user containers out of scope), and the browser worker
 * is per-user by construction — code and data never leave the client. The
 * fences stay manual-run with the human seeing the output; this tool is the
 * second channel over the SAME engine, where the model reads what happened.
 *
 * **Files.** Files a run creates stay in the browser sandbox. The tool result
 * names them for the model; the user sees them through the existing
 * RunsStore → RunOutput → FileCard path. Files are session-only (the worker
 * filesystem dies with the page load) and are deliberately NOT persisted.
 *
 * **No policy layer, by design.** The sandbox is stdlib-only, network-gated
 * and per-user by construction — the sandbox's own boundaries are the policy.
 */
export const EXECUTE_CODE_TOOL_NAME = "execute_code";

/**
 * Loop protection, not capability: past this many `execute_code` calls in one
 * turn the tool refuses, so a runaway loop costs a bounded number of rounds.
 * Six sits inside the 5-8 budget and well below the ordinary conversation's
 * ten-round budget, so the refusal is the thing the model actually sees rather
 * than the loop ending first. Loop protection matters more than capability.
 */
export const MAX_EXECUTE_CODE_CALLS = 6;

const EXECUTE_REFUSAL_MESSAGE =
	`execute_code has reached its limit of ${MAX_EXECUTE_CODE_CALLS} calls for this turn. ` +
	"Do not call it again: summarize what you have, tell the person what you tried and " +
	"what stopped, and let them decide whether to continue in a new turn.";

/**
 * How long the parked row waits for the browser's answer before the sweeper
 * gives up. One run costs RUN_TIMEOUT_MS; a cold worker adds its whole load
 * budget (wasm + stdlib + bootstrap); the remainder is sweep-interval grace.
 * A closed tab or a gone user is the sweeper's backstop, not the timer.
 */
export const CODE_EXECUTION_DEADLINE_MS = LOAD_TIMEOUT_MS + RUN_TIMEOUT_MS + 10_000;

// Same shape as the sandbox's truncation, for the same reason: a run's output
// ends with the traceback and the result, which is the part worth keeping.
// (~6k cap, tail-weighted.)
const OUTPUT_MAX_CHARS = 6000;
const OUTPUT_HEAD = 1800;
const OUTPUT_TAIL = 4200;

export const truncateExecuteCodeOutput = makeTruncator(OUTPUT_MAX_CHARS, OUTPUT_HEAD, OUTPUT_TAIL);

/**
 * The tool is offered only where the deployment turns it on: the flag is the
 * feature switch in one. Without it nothing registers and the prompt keeps
 * today's fence-only contract.
 */
export function isExecuteCodeEnabled(): boolean {
	return config.CHAT_CODE_TOOL_ENABLED === "true";
}

export function createExecuteCodeBuiltin(): BuiltinTool[] {
	if (!isExecuteCodeEnabled()) return [];

	// Counted in this closure, which is built once per turn (getEnabledBuiltinTools
	// runs once per runMcpFlow invocation), so the cap resets with the turn.
	let callsThisTurn = 0;

	return [
		{
			name: EXECUTE_CODE_TOOL_NAME,
			definition: {
				type: "function",
				function: {
					name: EXECUTE_CODE_TOOL_NAME,
					description:
						"Run a Python snippet in the person's own browser sandbox and read the " +
						"result, so you can iterate: run, read the output, fix, run again. The " +
						"engine is the same sandbox the code blocks run in: Python with the " +
						"STANDARD LIBRARY ONLY (zipfile, csv, json, sqlite3, xml, ...), no " +
						"network access, no pip, no third-party packages — imports beyond the " +
						"stdlib fail with ModuleNotFoundError.\n\n" +
						"You see the truncated stdout, stderr and the last expression's result " +
						"yourself, plus the names of files the run created (shown to the person " +
						"as download cards). The files stay in the person's browser; they are " +
						"session-only and vanish when the page reloads.\n\n" +
						"If the answer says the execution environment is unavailable (the " +
						"person's browser did not answer in time), do NOT claim any execution " +
						"result or file: fall back to presenting the code as a code block in " +
						"your reply so the person can run it themselves with the Run button.\n\n" +
						"Do not use this for code the person wants to read or keep — that " +
						"belongs in a code block, which stays in the transcript and can be run " +
						"manually. Each call spends one of this turn's few execute_code calls; " +
						"prefer one decisive snippet over many fragments.",
					parameters: {
						type: "object",
						properties: {
							code: {
								type: "string",
								description:
									"Complete, runnable Python (all imports included, no " +
									"placeholders). One snippet per call. Use print() for the " +
									"output you want to see; the last expression's value is " +
									"reported as the result.",
							},
						},
						required: ["code"],
					},
				},
			},
			mayPark: true,
			parkRefusalMessage:
				"Only one code execution can wait on the browser per turn. " +
				"Run one snippet per round and read its result before the next call.",
			async execute(args, ctx) {
				const parsed = args as { code?: unknown };
				const code = typeof parsed.code === "string" ? parsed.code : "";
				if (!code.trim()) {
					return { error: "No code provided." };
				}
				if (!ctx.conversationId || !ctx.messageId) {
					// Nothing to resume into; say so instead of parking a turn nothing can wake.
					return {
						error:
							"Code execution is not available in this context. " +
							"Present the code as a code block instead.",
					};
				}
				if (callsThisTurn >= MAX_EXECUTE_CODE_CALLS) {
					return { error: EXECUTE_REFUSAL_MESSAGE };
				}
				if (!ctx.elicitationSink) {
					// No browser channel to park into: refuse instead of parking a
					// turn nothing can wake.
					return {
						error:
							"The execution environment is unavailable in this context. " +
							"Present the code as a code block instead.",
					};
				}
				callsThisTurn += 1;

				const parkedCallId = randomUUID();
				const now = new Date();
				const resumeAt = new Date(now.getTime() + CODE_EXECUTION_DEADLINE_MS);
				await collections.parkedCalls.insertOne({
					_id: new ObjectId(),
					parkedCallId,
					conversationId: ctx.conversationId,
					...(ctx.generationId ? { generationId: ctx.generationId } : {}),
					messageId: ctx.messageId,
					toolCallId: ctx.toolCallId,
					toolUuid: ctx.uuid,
					kind: "code",
					status: "waiting",
					resumeAt,
					reason: "code execution in the person's browser",
					code,
					...(ctx.userId ? { userId: ctx.userId } : {}),
					...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
					attempts: 0,
					createdAt: now,
					updatedAt: now,
				});

				logger.info(
					{
						parkedCallId,
						conversationId: ctx.conversationId.toString(),
						deadlineMs: CODE_EXECUTION_DEADLINE_MS,
						codeLength: code.length,
					},
					"[execute_code] turn parked on the browser sandbox"
				);

				// The code streams to the person's browser over the same channel
				// elicitation uses; their ExecutionSession runs it and posts the
				// outcome back to the resolve endpoint, which wakes the parked row.
				ctx.elicitationSink.emit({
					type: MessageUpdateType.CodeExecution,
					subtype: MessageCodeExecutionUpdateType.Request,
					executionId: parkedCallId,
					code,
					expiresAt: resumeAt.getTime(),
				});

				// The park is a lifecycle transition: record it on the turn state and
				// send it in-band, so every subscriber learns the turn is parked from
				// the same channel that carries the rest of the turn.
				const stateUpdate = await turnAwaitingInput({
					conversationId: ctx.conversationId,
					messageId: ctx.messageId,
					producerId: ctx.generationId ?? "",
					...(ctx.userId ? { userId: ctx.userId } : {}),
					...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
				});
				ctx.elicitationSink.emit(stateUpdate);

				return { awaitingInput: true };
			},
		},
	];
}

/**
 * Whether the conversation has a parked code execution with this id. Parallel
 * to the elicitation's parkedMessageId: the resume request carries one uuid
 * that may name either kind of parked call, and this lookup must not touch
 * elicitation semantics.
 */
export async function isParkedCodeCall(
	conversationId: ObjectId,
	parkedCallId: string
): Promise<boolean> {
	const row = await collections.parkedCalls.findOne(
		{ parkedCallId, conversationId, kind: "code" },
		{ projection: { _id: 1 } }
	);
	return Boolean(row);
}

/** The tool result the model reads on the round it wakes into. */
export function codeResumeResultText(park: ParkedCall, tokenExpired: boolean): string {
	if (!park.outcome) {
		return (
			"The execution environment was unavailable — the person's browser did not answer " +
			"in time (tab closed, page left, or the sandbox did not come up). " +
			"Do NOT claim any execution result or file. Fall back: present the code as a " +
			"code block in your reply so the person can run it themselves with the Run " +
			"button, and say what you intended it to show."
		);
	}
	const outcome = park.outcome;
	const parts: string[] = [];
	parts.push(
		outcome.ok
			? "Execution finished in the person's browser sandbox."
			: "Execution finished with an error."
	);
	if (outcome.stdout) {
		parts.push(`stdout:\n${truncateExecuteCodeOutput(outcome.stdout)}`);
	}
	if (outcome.stderr) {
		parts.push(`stderr:\n${truncateExecuteCodeOutput(outcome.stderr)}`);
	}
	if (outcome.ok && outcome.result) {
		parts.push(`Result: ${truncateExecuteCodeOutput(outcome.result)}`);
	}
	if (!outcome.ok && outcome.error) {
		parts.push(`Error: ${truncateExecuteCodeOutput(outcome.error)}`);
	}
	if (outcome.files?.length) {
		parts.push(
			"Files the run created (shown to the person as download cards; they are " +
				"session-only and vanish when the page reloads): " +
				outcome.files.map((file) => file.path).join(", ")
		);
	}
	if (tokenExpired) {
		parts.push(
			"NOTE: the signed-in session expired while you waited, so downloads and " +
				"further authenticated calls may fail. If one fails that way, say so " +
				"rather than retrying."
		);
	}
	return parts.join("\n\n");
}
