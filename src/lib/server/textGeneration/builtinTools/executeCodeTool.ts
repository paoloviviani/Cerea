import type { ObjectId } from "mongodb";
import { collections } from "$lib/server/database";
import { logger } from "$lib/server/logger";
import { NO_OUTCOME_RECORDED, OUTPUT_ROOT } from "$lib/utils/execution/protocol";
import { codeRunTimeoutMs } from "$lib/server/codeRunLimit";
import { executionBackend } from "$lib/server/codeExecution/backend";
import {
	CODE_EXECUTION_DEADLINE_MS,
	codeExecutionDeadlineMs,
} from "$lib/server/codeExecution/deadlines";
import { turnAwaitingInput } from "$lib/server/generation/turnState";
import {
	MessageCodeExecutionUpdateType,
	MessageUpdateType,
	type MessageCodeExecutionResolvedUpdate,
} from "$lib/types/MessageUpdate";
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
 * **Files.** Files a run creates stay in the browser sandbox; the tool result
 * names them for the model, and the user sees them live through the existing
 * RunsStore → RunOutput → FileCard path while the tab holds them. The
 * sandbox itself is still session-only (the worker filesystem dies with the
 * page load) — but a run's own output files ARE its deliverables, so
 * `CodeExecutionCard` additionally uploads their bytes to the per-user output
 * store (`$lib/server/execution/deliverables.ts`, GridFS behind
 * `authCondition`, 30-day TTL) once the run settles, and the resolved update
 * carries the persisted references so a download card survives a reload and
 * works from another device (ADR 0073's amendment). Nothing else that runs
 * through the same RunOutput/FileCard components (a fence, an artifact cell)
 * persists this way — only a tool run's surfaced output does.
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

// The deadline the parked row waits for the browser's answer lives with the
// backend (`$lib/server/codeExecution/deadlines`); re-exported for callers.
export { CODE_EXECUTION_DEADLINE_MS, codeExecutionDeadlineMs };

// Same shape as the sandbox's truncation, for the same reason: a run's output
// ends with the traceback and the result, which is the part worth keeping.
// (~6k cap, tail-weighted.)
const OUTPUT_MAX_CHARS = 6000;
const OUTPUT_HEAD = 1800;
const OUTPUT_TAIL = 4200;

export const truncateExecuteCodeOutput = makeTruncator(OUTPUT_MAX_CHARS, OUTPUT_HEAD, OUTPUT_TAIL);

/**
 * The tool is offered only where the deployment's execution backend offers it
 * (`CHAT_CODE_EXECUTION`, with `CHAT_CODE_TOOL_ENABLED` gating the tool inside
 * the browser backend). Without it nothing registers and the prompt keeps
 * today's fence-only contract.
 */
export function isExecuteCodeEnabled(): boolean {
	return executionBackend().toolOffered();
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
						"result, so you can iterate: run, read the output, fix, run again. " +
						"Invoke this tool through the function-calling mechanism, as a real " +
						"tool call — never by writing the call into your reply as text markup, " +
						"which runs nothing and leaves the person with broken markup. The " +
						"engine is the same sandbox the code blocks run in: no network access " +
						"at run time (no sockets, no urllib, no requests), but " +
						'micropip.install("<package>") works for the standard library plus ' +
						"vendored packages (python-docx, openpyxl, pypdf, python-pptx, xlsxwriter, " +
						"reportlab, seaborn; install first, a plain import fails until then) " +
						"and whatever else this runtime already bundles (numpy, pandas, lxml, " +
						"Pillow, ...) — same-origin only, never a third-party request. Any other " +
						"PyPI package installs unless the person or the administrator has turned " +
						"that off in the settings; if it fails as not-found, say the setting controls it rather " +
						"than telling them to install it themselves.\n\n" +
						"You see the truncated stdout, stderr and the last expression's result " +
						"yourself, plus the names of files the run saved to the output folder.\n\n" +
						`Where files go: only files written under ${OUTPUT_ROOT}/ (for example ` +
						`${OUTPUT_ROOT}/report.xlsx) are offered to the person as download cards ` +
						"(kept for 30 days). Anything else you write, in the working directory " +
						"or /tmp, is scratch: it stays in the sandbox and is never shown, so " +
						"save a deliverable only once, in its final form, to the output folder " +
						"and keep test or round-trip copies elsewhere. Files the person " +
						"attached are read-only inputs at /mnt/data/<name>, and they are " +
						"restored automatically if the sandbox restarts.\n\n" +
						"Each run is stopped after a time limit (60 seconds by default). A " +
						"stopped run restarts the sandbox: variables, imports and files " +
						"outside /mnt/data are lost, so work in steps that each finish in " +
						"time and write results to the output folder as you go.\n\n" +
						"If the answer says the execution environment is unavailable (the " +
						"person's browser did not answer in time), do NOT claim any execution " +
						"result or file: fall back to a plain fenced ```python code block with " +
						"no `title=` (a `title=` block is a downloadable file, not a running " +
						"one) — it runs automatically the moment it is complete, with no Run " +
						"button to mention.\n\n" +
						"It computes on data already in the conversation, attached files or " +
						"earlier tool results. It is not a stand-in for a tool you lack: it " +
						"cannot search, fetch or call a service or connector, and must not " +
						"simulate one with made-up data — say the capability is missing " +
						"instead.\n\n" +
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

				const backend = executionBackend();
				const deadlineMs = codeExecutionDeadlineMs();
				const { executionId: parkedCallId } = await backend.startRun(
					{
						call: {
							conversationId: ctx.conversationId,
							messageId: ctx.messageId,
							toolCallId: ctx.toolCallId,
							toolUuid: ctx.uuid,
							...(ctx.generationId ? { generationId: ctx.generationId } : {}),
							...(ctx.userId ? { userId: ctx.userId } : {}),
							...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
						},
						code,
						limits: { runTimeoutMs: codeRunTimeoutMs(), deadlineMs },
					},
					(update) => ctx.elicitationSink?.emit(update)
				);

				logger.info(
					{
						parkedCallId,
						conversationId: ctx.conversationId.toString(),
						backend: backend.kind,
						deadlineMs,
						codeLength: code.length,
					},
					"[execute_code] turn parked on the code runner"
				);

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
			"The execution environment gave no answer before the deadline — the browser never " +
			"posted a result at all, as distinct from posting an error. On a phone this is " +
			"usually the OS suspending the app while Python was still starting up in the " +
			"background (switching apps, locking the screen, the browser tab losing focus); " +
			"it can also mean the tab or page was closed. Do NOT claim any execution result or " +
			"file, and do not assume the code itself is at fault. Fall back: present the code " +
			"as a plain fenced ```python code block with no `title=` (a `title=` block renders " +
			"as a downloadable file, not a running one) and say what you intended it to show. " +
			"Do not tell the person to click Run or similar — nothing needs pressing, the block " +
			"runs automatically the moment it is complete, and mention that keeping the app in " +
			"the foreground while Python starts up gives it the best chance to finish this time."
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
	if (outcome.timeout) {
		const { seconds, mountedFiles } = outcome.timeout;
		parts.push(
			`The run was stopped after ${seconds} s because it hit the time limit. The sandbox was ` +
				"restarted: variables, imports and any files written outside /mnt/data are lost. " +
				(mountedFiles.length
					? "The person's attached files were put back and are available again in /mnt/data: " +
						`${mountedFiles.join(", ")}. They did not vanish; do not ask the person to ` +
						"attach them again. "
					: "No files were mounted in /mnt/data. ") +
				"Make the work smaller (a sample, fewer steps per call, no long loops) and run again."
		);
	}
	if (outcome.files?.length) {
		parts.push(
			`Files the run saved to ${OUTPUT_ROOT} (shown to the person as download cards, kept for ` +
				"30 days so they still work after a reload or from another device): " +
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

/**
 * The `MessageUpdateType.CodeExecution` / `Resolved` update the sweeper
 * persists and broadcasts once a parked `execute_code` call is answered.
 * `outcome` drops both `files` (sandbox paths, dead on replay) and
 * `fileRefs`; the latter surfaces separately as `files` — the durable side,
 * addressed by conversation + sha256 against the persisted output store, so
 * a download card on replay renders from there rather than from `outcome`.
 */
export function buildCodeExecutionResolvedUpdate(
	park: ParkedCall
): MessageCodeExecutionResolvedUpdate {
	const outcome = park.outcome;
	return {
		type: MessageUpdateType.CodeExecution,
		subtype: MessageCodeExecutionUpdateType.Resolved,
		executionId: park.parkedCallId,
		outcome: outcome
			? (({ files: _files, fileRefs: _fileRefs, ...rest }) => rest)(outcome)
			: {
					ok: false,
					stdout: "",
					stderr: "",
					error: NO_OUTCOME_RECORDED,
				},
		...(outcome?.fileRefs?.length ? { files: outcome.fileRefs } : {}),
	};
}
