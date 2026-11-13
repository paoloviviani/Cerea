import type { ObjectId } from "mongodb";
import { config } from "$lib/server/config";
import { logger } from "$lib/server/logger";
import type { CodeExecutionOutcome } from "$lib/types/ParkedCall";
import type { MessageUpdate } from "$lib/types/MessageUpdate";
import { browserBackend } from "./browserBackend";
import { serverBackend } from "./serverBackend";
import { sandboxUsable } from "./sandboxHealth";

/**
 * Where model-written code runs. One setting, read in this module only:
 *
 * - `browser` (the default): the signed-in person's own Pyodide sandbox. The
 *   turn parks on the page (`parkedCalls`, kind `code`) and the page posts the
 *   outcome back. Python fences run automatically in the same sandbox.
 * - `server`: the `execute_code` tool runs in a gVisor sandbox the sandbox manager leases to the
 *   conversation (ADR 0115, `serverBackend.ts`). Chosen only where `SANDBOX` is on and the manager
 *   answers; otherwise it is the browser backend, and that is logged. Python fences still run in
 *   the person's browser.
 * - `off`: no code execution at all: no `execute_code` tool, no auto-run
 *   fences, no Run button, no execution wording in the system prompt.
 *
 * Mapping from the older flag: `CHAT_CODE_EXECUTION` unset means `browser`, and
 * `CHAT_CODE_TOOL_ENABLED` keeps its meaning inside it (the `execute_code` tool
 * is offered only when it is `true`; fences run either way). `off` wins over it.
 */
export type ExecutionBackendSetting = "browser" | "server" | "off";

/** What the app can actually do right now. */
export type ExecutionBackendKind = "browser" | "server" | "off";

export interface BackendRunCall {
	conversationId: ObjectId;
	messageId: string;
	toolCallId: string;
	toolUuid: string;
	generationId?: string;
	userId?: ObjectId;
	sessionId?: string;
}

export interface BackendRunFile {
	name: string;
	size: number;
	sha256?: string;
}

export interface BackendRunRequest {
	call: BackendRunCall;
	/** A scheduled run, with nobody's page to answer: a backend must not hand it to the browser. */
	unattended?: boolean;
	/** Something the model is told with this run's result (why it ran where it did). */
	notice?: string;
	code: string;
	/**
	 * The conversation's files the run may read. The browser backend ignores
	 * this (the page mounts them itself from the stores it already holds); a
	 * server backend has to materialise them before it starts.
	 */
	files?: BackendRunFile[];
	limits: {
		/** The wall-clock limit of one run. */
		runTimeoutMs: number;
		/** How long the parked call waits for an answer before it is given up. */
		deadlineMs: number;
	};
}

export interface BackendRunStarted {
	/** The id the answer arrives under (`resolve`) and the card is keyed by. */
	executionId: string;
	/** When the parked call gives up, absent a pause signal. */
	expiresAt: Date;
}

export type PauseResult =
	{ ok: true; resumeAt: Date } | { ok: false; status: 404 | 409; error: string };

export type ResolveResult =
	| { ok: true; resume: boolean; messageId?: string }
	| { ok: false; status: 404 | 409 | 500; error: string };

/**
 * What a backend provides to `execute_code` and the endpoints around it. A
 * backend owns the whole path from "the model asked to run this" to "the
 * outcome is recorded on the parked call"; callers never branch on which one
 * is configured except through the capability fields.
 */
export interface ExecutionBackend {
	readonly kind: ExecutionBackendKind;
	/** Whether any code execution feature is on (fences, Run buttons, the tool, the prompt). */
	readonly enabled: boolean;
	/** Whether the `execute_code` tool is offered to the model. */
	toolOffered(): boolean;
	/**
	 * Whether a run can happen with nobody watching (a scheduled run). A browser
	 * sandbox needs the person's open page; a server sandbox would not.
	 */
	readonly supportsUnattended: boolean;
	/**
	 * Whether the runner can be paused out from under a pending call (a page in
	 * the background) and so needs `pause` signals to keep the call alive.
	 */
	readonly supportsPause: boolean;
	/** Where the prompt says code runs, as a phrase ("in the person's browser (Pyodide, WebAssembly)"). */
	readonly promptEngine: string;
	/** Start a run for a tool call: park it and hand the code to the runner. */
	startRun(
		request: BackendRunRequest,
		emit: (update: MessageUpdate) => void
	): Promise<BackendRunStarted>;
	/** The runner is paused (or returning): keep the pending call alive, never shortening it. */
	pause(conversationId: ObjectId, executionId: string): Promise<PauseResult>;
	/** Record the runner's outcome on the pending call and wake the turn. */
	resolve(
		conversationId: ObjectId,
		executionId: string,
		outcome: CodeExecutionOutcome
	): Promise<ResolveResult>;
}

/** The setting as configured, with unknown values read as the default. */
export function parseExecutionSetting(raw: string | undefined | null): ExecutionBackendSetting {
	const value = (raw ?? "").trim().toLowerCase();
	if (value === "" || value === "browser") return "browser";
	if (value === "server" || value === "off") return value;
	logger.warn(
		{ value: raw },
		"[code-execution] CHAT_CODE_EXECUTION must be browser, server or off; using browser"
	);
	return "browser";
}

const offBackend: ExecutionBackend = {
	kind: "off",
	enabled: false,
	toolOffered: () => false,
	supportsUnattended: false,
	supportsPause: false,
	promptEngine: "",
	async startRun() {
		throw new Error("Code execution is off.");
	},
	async pause() {
		return { ok: false, status: 404, error: "Code execution is off." };
	},
	async resolve() {
		return { ok: false, status: 404, error: "Code execution is off." };
	},
};

let fellBack: boolean | null = null;

/** For tests: the fallback is logged when it starts or ends, not per call. */
export function resetExecutionBackendWarning(): void {
	fellBack = null;
}

/** The backend this deployment runs code on, read from the configuration each call. */
export function executionBackend(): ExecutionBackend {
	const setting = parseExecutionSetting(config.CHAT_CODE_EXECUTION);
	if (setting === "off") return offBackend;
	if (setting === "server") {
		// Forced to the browser when sandboxes are off or the manager is not answering.
		if (sandboxUsable()) {
			if (fellBack) logger.info("[code-execution] the server sandbox is back: using it");
			fellBack = false;
			return serverBackend;
		}
		if (fellBack !== true) {
			fellBack = true;
			logger.warn(
				"[code-execution] CHAT_CODE_EXECUTION=server, but the sandbox manager is off or not answering " +
					"(see SANDBOX): code runs in the person's browser"
			);
		}
		return browserBackend;
	}
	return browserBackend;
}

/** Logged at boot so a misconfiguration shows once at start, not on someone's first turn. */
export function logExecutionBackendAtBoot(): void {
	const backend = executionBackend();
	logger.info({ backend: backend.kind }, "[code-execution] Execution backend");
}
