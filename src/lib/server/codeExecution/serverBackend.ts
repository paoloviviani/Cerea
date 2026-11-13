import { createHash } from "node:crypto";
import mimeTypes from "mime-types";
import type { ObjectId } from "mongodb";
import { logger } from "$lib/server/logger";
import { config } from "$lib/server/config";
import { submitCodeExecutionResult } from "$lib/server/generation/codeExecution";
import type { storeDeliverable } from "$lib/server/execution/deliverables";
import { sandboxSettings } from "$lib/server/sandbox/boot";
import { SandboxClient } from "$lib/server/sandbox/client";
import { FIGURES_MODULE_SOURCE } from "$lib/utils/execution/figures";
import type { CodeExecutionOutcome, PersistedDeliverableRef } from "$lib/types/ParkedCall";
import {
	MessageCodeExecutionUpdateType,
	MessageUpdateType,
	type MessageUpdate,
} from "$lib/types/MessageUpdate";
import type { BackendRunRequest, ExecutionBackend } from "./backend";
import { browserBackend, parkCodeCall } from "./browserBackend";
import { sandboxHealthyNow } from "./sandboxHealth";
import {
	SandboxSessions,
	SandboxUnavailable,
	type SessionRunRequest,
	type SessionRunResult,
} from "./sandboxSessions";
import type { attachmentsToStage } from "./sandboxStage";

/**
 * The `server` execution backend (ADR 0115, class E): `execute_code` runs in a gVisor sandbox the
 * sandbox manager leases to the conversation, instead of in the person's browser.
 *
 * The model sees the same tool, the same arguments and the same result text. The turn parks on the
 * same `code` row the browser backend uses, so the sweeper, the deadline and the resumed turn are
 * unchanged; the difference is who posts the outcome: this process does, once the sandbox answers.
 * The page is told (`runner: "server"`) to show the card and wait, not to run the code itself.
 *
 * Fallback is automatic: when the manager cannot be reached or refuses a lease before the code has
 * run, the call is handed to the browser backend, and that is logged. After the code has started
 * there is no fallback (it may have had effects); a failure is reported as the run's error.
 */

/** At most this many output-file notes are put in a result; the rest are counted. */
const MAX_NOTES = 20;

/** What the backend needs from outside, so a test can stand in for each. */
export interface ServerBackendDeps {
	/** The sandbox sessions, or null when sandboxes are not configured. */
	sessions(): SandboxSessions | null;
	/** Is the manager answering right now (a fresh probe if the cached one is stale)? */
	healthy(): Promise<boolean>;
	stageFiles(conversationId: ObjectId, messageId: string): ReturnType<typeof attachmentsToStage>;
	store: typeof storeDeliverable;
	submit: typeof submitCodeExecutionResult;
	kick(): void;
	fallback: ExecutionBackend;
	park: typeof parkCodeCall;
}

/** A scheduled run needed the browser, and nobody's browser is there to answer. */
export class ServerSandboxUnavailable extends Error {
	constructor(why: string) {
		super(`the server sandbox is unavailable (${why}) and this run has no browser to fall back to`);
		this.name = "ServerSandboxUnavailable";
	}
}

/** What the model is told when a call ran in the browser although the server was asked for. */
export function fallbackNotice(code?: string): string {
	const why =
		code === "quota_exceeded"
			? "the server sandboxes are busy (the limit on concurrent sandboxes, or their shared CPU and memory budget, was reached)"
			: code === "wrong_image"
				? "the server sandbox image has no exec daemon"
				: "the server sandbox is unavailable";
	return (
		`This call ran in the person's browser instead of the server sandbox, because ${why}. ` +
		"Packages installed on the server are not there and there is no variable state from earlier calls on the server."
	);
}

/** Give a conversation's sandbox back, when it is deleted. Best effort: the idle timeout is the backstop. */
export async function releaseConversationSandboxes(
	conversationIds: ObjectId | ObjectId[]
): Promise<void> {
	const sessions = defaultDeps.sessions();
	if (!sessions) return;
	for (const id of Array.isArray(conversationIds) ? conversationIds : [conversationIds]) {
		await sessions.release(id.toString()).catch(() => undefined);
	}
}

let cached: { key: string; sessions: SandboxSessions } | null = null;

const defaultDeps: ServerBackendDeps = {
	sessions() {
		const settings = sandboxSettings().config;
		if (!settings) return null;
		const key = `${settings.url}\n${settings.token}`;
		if (cached?.key !== key) {
			cached = {
				key,
				sessions: new SandboxSessions(
					new SandboxClient({ url: settings.url, token: settings.token })
				),
			};
		}
		return cached.sessions;
	},
	healthy: sandboxHealthyNow,
	// Loaded when first used, not with this module: the backend is imported by everything that
	// builds the tool list, and these pull in the sweeper, the stores and the file previews.
	stageFiles: async (conversationId, messageId) =>
		(await import("./sandboxStage")).attachmentsToStage(conversationId, messageId),
	store: async (args) =>
		(await import("$lib/server/execution/deliverables")).storeDeliverable(args),
	submit: submitCodeExecutionResult,
	kick: () =>
		void import("$lib/server/generation/parkedSweeper")
			.then((m) => m.sweepParkedCalls())
			.catch((err) =>
				logger.error({ err }, "[execute_code] the sweep kicked by a server run failed")
			),
	fallback: browserBackend,
	park: parkCodeCall,
};

function ownerOf(request: BackendRunRequest): string {
	const { call } = request;
	return call.userId?.toString() ?? call.sessionId ?? call.conversationId.toString();
}

function sessionRequest(
	request: BackendRunRequest,
	files: SessionRunRequest["files"]
): SessionRunRequest {
	return {
		conversationId: request.call.conversationId.toString(),
		owner: ownerOf(request),
		code: request.code,
		timeoutSeconds: Math.ceil(request.limits.runTimeoutMs / 1000),
		figuresSource: FIGURES_MODULE_SOURCE,
		files,
	};
}

/** The outcome the sweeper records, from what the sandbox returned; stores the files the code wrote. */
export async function buildOutcome(
	deps: Pick<ServerBackendDeps, "store">,
	request: BackendRunRequest,
	result: SessionRunResult
): Promise<CodeExecutionOutcome> {
	const { reply } = result;
	const fileRefs: PersistedDeliverableRef[] = [];
	const notes: string[] = [];
	for (const output of result.outputs) {
		const bytes = Buffer.from(output.bytes);
		const stored = await deps
			.store({
				conversationId: request.call.conversationId,
				...(request.call.userId ? { userId: request.call.userId } : {}),
				name: output.name,
				mime: mimeTypes.lookup(output.name) || "application/octet-stream",
				bytes,
				tool: "execute_code",
				messageId: request.call.messageId,
			})
			.catch((err: unknown) => {
				logger.warn({ err }, "[execute_code] storing a sandbox output failed");
				return null;
			});
		if (stored?.ok) {
			fileRefs.push({ ...stored.ref, uploaded: true });
		} else {
			// Produced, but not kept: the card says it cannot be downloaded later.
			fileRefs.push({
				name: output.name,
				size: bytes.byteLength,
				sha256: createHash("sha256").update(bytes).digest("hex"),
				uploaded: false,
			});
			notes.push(`${output.name} could not be saved${stored ? `: ${stored.error}` : ""}`);
		}
	}
	for (const skipped of result.skipped)
		notes.push(`${skipped.name} was not kept (${skipped.reason})`);
	// A run that makes hundreds of files must not make a hundred-line notice.
	const shown = notes.slice(0, MAX_NOTES);
	if (notes.length > MAX_NOTES) shown.push(`and ${notes.length - MAX_NOTES} more`);
	const notice = [result.notice, shown.length ? `Output files: ${shown.join("; ")}.` : ""]
		.filter(Boolean)
		.join(" ");
	return {
		ok: reply.ok,
		stdout: reply.stdout,
		stderr: reply.stderr,
		...(reply.result ? { result: reply.result } : {}),
		...(reply.error ? { error: reply.error } : {}),
		...(reply.timeout ? { timeout: reply.timeout } : {}),
		files: (reply.files ?? []).filter((f) =>
			result.outputs.some((o) => f.path.endsWith(`/${o.name}`))
		),
		...(fileRefs.length ? { fileRefs } : {}),
		engine: "server",
		...(notice ? { notice } : {}),
	};
}

export function createServerBackend(deps: ServerBackendDeps = defaultDeps): ExecutionBackend {
	async function finish(
		sessions: SandboxSessions,
		request: BackendRunRequest,
		files: SessionRunRequest["files"],
		executionId: string
	): Promise<void> {
		let outcome: CodeExecutionOutcome;
		try {
			const result = await sessions.run(sessionRequest(request, files));
			outcome = await buildOutcome(deps, request, result);
		} catch (err) {
			logger.error({ err, executionId }, "[execute_code] the server sandbox run failed");
			outcome = {
				ok: false,
				stdout: "",
				stderr: "",
				error:
					err instanceof SandboxUnavailable
						? `The server sandbox became unavailable before the code ran: ${err.message}`
						: "The server sandbox failed while running the code.",
				files: [],
				engine: "server",
			};
		}
		const answered = await deps.submit({
			executionId,
			conversationId: request.call.conversationId,
			outcome,
		});
		if (!answered.ok) {
			// Answered or abandoned already (the deadline passed first): nothing to wake.
			logger.warn(
				{ executionId, status: answered.status },
				"[execute_code] the server run's answer was too late"
			);
			return;
		}
		logger.info(
			{ executionId, ok: outcome.ok, files: outcome.fileRefs?.length ?? 0 },
			"[execute_code] the server sandbox posted the run outcome; parked turn woken"
		);
		deps.kick();
	}

	return {
		kind: "server",
		enabled: true,
		toolOffered: () => config.CHAT_CODE_TOOL_ENABLED === "true",
		// Nothing needs the person's page: a scheduled run can use it.
		supportsUnattended: true,
		supportsPause: false,
		// Where the code BLOCKS run (they still run in the browser); the tool says where it runs.
		promptEngine: browserBackend.promptEngine,

		async startRun(request, emit: (update: MessageUpdate) => void) {
			const sessions = deps.sessions();
			const fallback = (why: string, code?: string) => {
				// A scheduled run has nobody's page: the browser would never answer. Say so now.
				if (request.unattended) throw new ServerSandboxUnavailable(why);
				logger.warn(
					{ conversationId: request.call.conversationId.toString(), why },
					"[execute_code] the server sandbox is not usable: running this call in the browser"
				);
				return deps.fallback.startRun({ ...request, notice: fallbackNotice(code) }, emit);
			};
			if (!sessions || !(await deps.healthy())) return fallback("the manager is not healthy");

			let files: SessionRunRequest["files"];
			try {
				files = await deps.stageFiles(request.call.conversationId, request.call.messageId);
				// The lease and the staging, before the code is committed to the server.
				await sessions.prepare(sessionRequest(request, files));
			} catch (err) {
				if (err instanceof SandboxUnavailable) return fallback(err.message, err.code);
				throw err;
			}

			const { executionId, expiresAt } = await deps.park(
				request,
				"code execution in a server sandbox",
				"server"
			);
			emit({
				type: MessageUpdateType.CodeExecution,
				subtype: MessageCodeExecutionUpdateType.Request,
				executionId,
				code: request.code,
				toolUuid: request.call.toolUuid,
				expiresAt: expiresAt.getTime(),
				runner: "server",
			});
			// Not awaited: the turn is parked, and the answer wakes it.
			void finish(sessions, request, files, executionId);
			return { executionId, expiresAt };
		},

		// The page cannot pause a server run; a browser fallback's pause is the browser's.
		pause: (conversationId, executionId) => deps.fallback.pause(conversationId, executionId),
		// A browser fallback answers through here; so does anything else posting an outcome.
		resolve: (conversationId, executionId, outcome) =>
			deps.fallback.resolve(conversationId, executionId, outcome),
	};
}

export const serverBackend: ExecutionBackend = createServerBackend();
