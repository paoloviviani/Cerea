/**
 * One sandbox lease per conversation for `execute_code` on the server (ADR 0115, class E).
 *
 * The lease is the conversation's interpreter: the exec daemon in it keeps variables, imports and
 * files between calls. Nothing here touches the database or the chat's stores: the caller gives
 * the files to stage and gets the bytes of the files the code wrote, so this module is tested with
 * a fake manager and driven by a real one in CI.
 *
 * - **Reuse.** The first call of a conversation leases a sandbox; later calls find it again. The
 *   manager's own idle timeout releases it (and a use renews it), so nothing is released here.
 * - **A lost lease is recreated** on the next call, and the result says so: state is gone.
 * - **Staging is on demand.** Attachments are copied into /mnt/data once per name and content;
 *   `stage` is asked on every call but only changed files are loaded and sent.
 * - **One call at a time per conversation**, so two runs never interleave in one interpreter.
 */

import {
	SandboxError,
	type SandboxClient,
	type SandboxExecResult,
} from "$lib/server/sandbox/client";
import { MOUNT_ROOT, OUTPUT_ROOT } from "$lib/utils/execution/protocol";

/** The surface of `SandboxClient` this module needs, so a test can stand in for the manager. */
export type SandboxApi = Pick<
	SandboxClient,
	"lease" | "status" | "exec" | "putFile" | "getFile" | "release"
>;

/** The daemon's reply: the same shape the browser's worker returns, plus the files it listed. */
export interface DaemonReply {
	ok: boolean;
	stdout: string;
	stderr: string;
	result?: string | null;
	error?: string | null;
	files?: Array<{ path: string; size: number }>;
	timeout?: { seconds: number; mountedFiles: string[] } | null;
}

/** An attachment to have in /mnt/data. `identity` changes when its content does. */
export interface StageFile {
	name: string;
	identity: string;
	load(): Promise<Uint8Array>;
}

export interface SessionRunRequest {
	conversationId: string;
	/** Who owns the lease: the user's id, or the anonymous session's. */
	owner: string;
	code: string;
	timeoutSeconds: number;
	/** The module the daemon uses to turn matplotlib figures into PNG files (figures.ts). */
	figuresSource: string;
	/** The files the code may read, in /mnt/data. */
	files: StageFile[];
}

/** A file the code wrote to the output folder, with its bytes. */
export interface ProducedOutput {
	/** Path under the output folder, so `a/x.pdf` and `b/x.pdf` are two files. */
	name: string;
	bytes: Uint8Array;
}

export interface SessionRunResult {
	reply: DaemonReply;
	outputs: ProducedOutput[];
	/** Set when the sandbox is new to a conversation that had one: its state is gone. */
	notice?: string;
	/** Output files that were listed but could not be brought back, with the reason. */
	skipped: Array<{ name: string; reason: string }>;
}

/** The sandbox could not be got (manager down, quota, image): the caller falls back to the browser. */
export class SandboxUnavailable extends Error {
	code: string;
	constructor(message: string, code: string) {
		super(message);
		this.name = "SandboxUnavailable";
		this.code = code;
	}
}

/** At most this many output files come back from one run (the browser's own listing allows 200). */
export const MAX_OUTPUT_FILES_PER_RUN = 20;
/** One output file larger than this stays in the sandbox and is reported as skipped. */
export const MAX_OUTPUT_FILE_BYTES = 8 * 1024 * 1024;

/** The sentence the model reads when its sandbox was recreated. */
export const SANDBOX_RESTARTED_NOTICE =
	"The server sandbox was restarted since your last call (it sat idle, or was lost): variables, " +
	"imports and files from earlier calls are gone, including anything written to " +
	`${OUTPUT_ROOT}. The person's attached files were put back in ${MOUNT_ROOT}. Run the earlier ` +
	"steps again if this call needs them.";

interface Session {
	leaseId: string;
	owner: string;
	/** name -> identity of what is staged under /mnt/data. */
	staged: Map<string, string>;
}

export class SandboxSessions {
	private client: SandboxApi;
	private sessions = new Map<string, Session>();
	private chains = new Map<string, Promise<unknown>>();
	private had = new Set<string>();

	constructor(client: SandboxApi) {
		this.client = client;
	}

	/** Serialised per conversation. */
	run(request: SessionRunRequest): Promise<SessionRunResult> {
		return this.runExclusive(request.conversationId, () => this.runNow(request));
	}

	/** Whether this conversation has a lease this process knows of. */
	has(conversationId: string): boolean {
		return this.sessions.has(conversationId);
	}

	/** Gives the sandbox back now (a conversation deleted, a test). The idle reaper does it otherwise. */
	async release(conversationId: string): Promise<void> {
		const session = this.sessions.get(conversationId);
		this.sessions.delete(conversationId);
		if (session) await this.client.release(session.leaseId, session.owner).catch(() => undefined);
	}

	private async ensure(
		request: SessionRunRequest
	): Promise<{ session: Session; restarted: boolean }> {
		const cached = this.sessions.get(request.conversationId);
		if (cached) {
			try {
				await this.client.status(cached.leaseId, cached.owner);
				return { session: cached, restarted: false };
			} catch (err) {
				if (!(err instanceof SandboxError) || err.status !== 404) throw this.unavailable(err);
				this.sessions.delete(request.conversationId); // reaped or lost: make a new one
			}
		}
		let lease;
		try {
			lease = await this.client.lease({
				kind: "exec",
				owner: request.owner,
				conversation: request.conversationId,
			});
		} catch (err) {
			throw this.unavailable(err);
		}
		const session: Session = { leaseId: lease.id, owner: request.owner, staged: new Map() };
		this.sessions.set(request.conversationId, session);
		const restarted = this.had.has(request.conversationId);
		this.had.add(request.conversationId);
		return { session, restarted };
	}

	private unavailable(err: unknown): SandboxUnavailable {
		if (err instanceof SandboxError) {
			return new SandboxUnavailable(`the sandbox manager said: ${err.message}`, err.code);
		}
		return new SandboxUnavailable(String(err), "unavailable");
	}

	/**
	 * Lease and stage, without running anything: what the backend does before it commits to the
	 * server, so a failure here still falls back to the browser.
	 */
	async prepare(request: SessionRunRequest): Promise<void> {
		await this.runExclusive(request.conversationId, async () => {
			const { session } = await this.ensure(request);
			await this.stage(session, request.files);
		});
	}

	private runExclusive<T>(conversationId: string, work: () => Promise<T>): Promise<T> {
		const previous = this.chains.get(conversationId) ?? Promise.resolve();
		const next = previous.catch(() => undefined).then(work);
		this.chains.set(conversationId, next);
		void next
			.finally(() => {
				if (this.chains.get(conversationId) === next) this.chains.delete(conversationId);
			})
			.catch(() => undefined);
		return next;
	}

	private async stage(session: Session, files: StageFile[]): Promise<void> {
		for (const file of files) {
			if (session.staged.get(file.name) === file.identity) continue;
			let bytes: Uint8Array;
			try {
				bytes = await file.load();
			} catch {
				continue; // withheld, deleted or unreadable: the file is simply not in the sandbox
			}
			try {
				await this.client.putFile(session.leaseId, `data/${file.name}`, bytes, session.owner);
			} catch (err) {
				throw this.unavailable(err);
			}
			session.staged.set(file.name, file.identity);
		}
	}

	private async runNow(request: SessionRunRequest): Promise<SessionRunResult> {
		let { session, restarted } = await this.ensure(request);
		let attempt = 0;
		for (;;) {
			await this.stage(session, request.files);
			let exec: SandboxExecResult;
			try {
				exec = await this.client.exec(
					session.leaseId,
					{
						cmd: ["python", "/opt/execd/run.py"],
						stdin: JSON.stringify({
							code: request.code,
							timeout: request.timeoutSeconds,
							figures: request.figuresSource,
						}),
						// The daemon enforces the run's limit itself; this is its backstop.
						timeoutSeconds: request.timeoutSeconds + 20,
					},
					session.owner
				);
			} catch (err) {
				if (err instanceof SandboxError && err.status === 404 && attempt === 0) {
					// The lease vanished between the check and the call: one fresh start.
					attempt += 1;
					this.sessions.delete(request.conversationId);
					({ session } = await this.ensure(request));
					restarted = true;
					continue;
				}
				throw this.unavailable(err);
			}
			const reply = parseReply(exec);
			const { outputs, skipped } = await this.collect(session, reply);
			return {
				reply,
				outputs,
				skipped,
				...(restarted ? { notice: SANDBOX_RESTARTED_NOTICE } : {}),
			};
		}
	}

	private async collect(
		session: Session,
		reply: DaemonReply
	): Promise<{ outputs: ProducedOutput[]; skipped: Array<{ name: string; reason: string }> }> {
		const outputs: ProducedOutput[] = [];
		const skipped: Array<{ name: string; reason: string }> = [];
		const prefix = `${OUTPUT_ROOT}/`;
		for (const file of reply.files ?? []) {
			if (!file.path.startsWith(prefix)) continue;
			const name = file.path.slice(prefix.length);
			if (outputs.length >= MAX_OUTPUT_FILES_PER_RUN) {
				skipped.push({
					name,
					reason: `only the first ${MAX_OUTPUT_FILES_PER_RUN} files of a run are kept`,
				});
				continue;
			}
			if (file.size > MAX_OUTPUT_FILE_BYTES) {
				skipped.push({ name, reason: `larger than ${MAX_OUTPUT_FILE_BYTES / (1024 * 1024)} MB` });
				continue;
			}
			try {
				outputs.push({
					name,
					bytes: await this.client.getFile(session.leaseId, `output/${name}`, session.owner),
				});
			} catch (err) {
				skipped.push({
					name,
					reason: err instanceof SandboxError ? err.message : "could not be read",
				});
			}
		}
		return { outputs, skipped };
	}
}

/** The last line of the daemon client's stdout is its JSON reply. */
export function parseReply(exec: SandboxExecResult): DaemonReply {
	const line = exec.stdout.trim().split("\n").pop() ?? "";
	try {
		const parsed = JSON.parse(line) as DaemonReply;
		if (typeof parsed.ok === "boolean") {
			return {
				ok: parsed.ok,
				stdout: typeof parsed.stdout === "string" ? parsed.stdout : "",
				stderr: typeof parsed.stderr === "string" ? parsed.stderr : "",
				result: typeof parsed.result === "string" ? parsed.result : null,
				error: typeof parsed.error === "string" ? parsed.error : null,
				files: Array.isArray(parsed.files) ? parsed.files : [],
				timeout: parsed.timeout ?? null,
			};
		}
	} catch {
		/* not JSON: the call itself failed */
	}
	const why = exec.timed_out
		? "the sandbox's own time limit was hit"
		: (exec.stderr || exec.stdout || `exit code ${exec.exit_code}`).slice(0, 500);
	return {
		ok: false,
		stdout: "",
		stderr: "",
		error: `The sandbox could not run the code: ${why}`,
		files: [],
	};
}
