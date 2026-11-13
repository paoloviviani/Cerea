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
import { outcomeFieldsSchema } from "./outcomeSchema";

/** The surface of `SandboxClient` this module needs, so a test can stand in for the manager. */
export type SandboxApi = Pick<
	SandboxClient,
	"lease" | "status" | "exec" | "putFile" | "getFile" | "release"
>;

/** The daemon's reply: the same shape the browser's worker returns, plus the files it listed. */
export interface DaemonReply {
	/** Set when the daemon's answer could not be read: the call itself failed, not the code. */
	unparsed?: true;
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
/** A deliverable's name (its path under the output folder) is at most this long, as the store requires. */
export const MAX_OUTPUT_NAME_CHARS = 512;

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
	/**
	 * This sandbox replaced one the conversation had: the model has not yet been told. Set when
	 * it is made (by `prepare` or by a run), cleared when a run's result carries the notice, so
	 * a restart found by `prepare` still reaches the model on the run that follows.
	 */
	pendingRestart: boolean;
	/** The exec daemon was found in the image (checked once per sandbox). */
	verified: boolean;
}

/** Sessions and the "had one" memory are bounded: the oldest is dropped (its lease released). */
export const MAX_SESSIONS = 500;
const MAX_REMEMBERED = 5000;

export class SandboxSessions {
	private client: SandboxApi;
	private sessions = new Map<string, Session>();
	private chains = new Map<string, Promise<unknown>>();
	private had = new Map<string, true>();

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

	private async ensure(request: SessionRunRequest): Promise<Session> {
		const cached = this.sessions.get(request.conversationId);
		if (cached) {
			if (cached.owner !== request.owner) {
				// Never run one user's call in a sandbox leased for another.
				this.sessions.delete(request.conversationId);
				void this.client.release(cached.leaseId, cached.owner).catch(() => undefined);
			} else {
				try {
					await this.client.status(cached.leaseId, cached.owner);
					this.touch(request.conversationId, cached);
					return cached;
				} catch (err) {
					if (!(err instanceof SandboxError) || !isLeaseGone(err)) throw this.unavailable(err);
					this.sessions.delete(request.conversationId); // reaped or lost: make a new one
				}
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
		const session: Session = {
			leaseId: lease.id,
			owner: request.owner,
			staged: new Map(),
			pendingRestart: this.had.has(request.conversationId),
			verified: false,
		};
		this.touch(request.conversationId, session);
		this.had.delete(request.conversationId);
		this.had.set(request.conversationId, true);
		while (this.had.size > MAX_REMEMBERED) {
			this.had.delete(this.had.keys().next().value as string);
		}
		return session;
	}

	/** Most recently used last; past the bound the oldest conversation's sandbox is given back. */
	private touch(conversationId: string, session: Session): void {
		this.sessions.delete(conversationId);
		this.sessions.set(conversationId, session);
		while (this.sessions.size > MAX_SESSIONS) {
			const oldest = this.sessions.keys().next().value as string;
			const evicted = this.sessions.get(oldest);
			this.sessions.delete(oldest);
			if (evicted) void this.client.release(evicted.leaseId, evicted.owner).catch(() => undefined);
		}
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
			const session = await this.ensure(request);
			await this.verify(session);
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

	/**
	 * The image has the exec daemon (SANDBOX_EXEC_IMAGE must be cerea-sandbox-python): checked once
	 * per sandbox, so a wrong image is a fallback to the browser, not a failed run.
	 */
	private async verify(session: Session): Promise<void> {
		if (session.verified) return;
		let result: SandboxExecResult;
		try {
			result = await this.client.exec(
				session.leaseId,
				{ cmd: ["test", "-f", "/opt/execd/run.py"], timeoutSeconds: 10 },
				session.owner
			);
		} catch (err) {
			throw this.unavailable(err);
		}
		if (result.exit_code !== 0) {
			throw new SandboxUnavailable(
				"the sandbox image has no exec daemon (SANDBOX_EXEC_IMAGE must be cerea-sandbox-python)",
				"wrong_image"
			);
		}
		session.verified = true;
	}

	private async stage(session: Session, files: StageFile[]): Promise<void> {
		// A file the conversation no longer holds (another branch, a deleted message) leaves the sandbox.
		const wanted = new Set(files.map((f) => f.name));
		for (const name of [...session.staged.keys()]) {
			if (wanted.has(name)) continue;
			session.staged.delete(name);
			await this.client
				.exec(
					session.leaseId,
					{ cmd: ["rm", "-f", "--", `/workspace/data/${name}`], timeoutSeconds: 10 },
					session.owner
				)
				.catch(() => undefined);
		}
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
		let session = await this.ensure(request);
		let attempt = 0;
		for (;;) {
			await this.verify(session);
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
						// The daemon enforces the run's limit itself, and run.py kills it past a grace;
						// this is the manager's own backstop on top of both.
						timeoutSeconds: request.timeoutSeconds + 30,
					},
					session.owner
				);
			} catch (err) {
				if (err instanceof SandboxError && err.code === "oom_killed") {
					// The manager saw the kernel's out-of-memory kill and has released the sandbox
					// (its reservation is free); the next call starts a fresh one.
					this.sessions.delete(request.conversationId);
					return { reply: failedRun(OOM_WHY), outputs: [], skipped: [] };
				}
				if (err instanceof SandboxError && isLeaseGone(err) && attempt === 0) {
					// The lease vanished between the check and the call (404), or the manager found
					// its sandbox no longer running and released it (410): one fresh start.
					attempt += 1;
					this.sessions.delete(request.conversationId);
					session = await this.ensure(request);
					continue;
				}
				throw this.unavailable(err);
			}
			const notice = session.pendingRestart ? SANDBOX_RESTARTED_NOTICE : undefined;
			session.pendingRestart = false;
			const reply = parseReply(exec);
			const replyTimedOut = reply.timeout != null;
			if (exec.timed_out || reply.unparsed || replyTimedOut) {
				// The sandbox could not be made to stop, answered with nothing we can read, or ran out
				// of time: whatever the code started (a child in its own session, a tampered pidfile)
				// may still be running. Give it back; the next call gets a fresh container, and tells
				// the model so.
				await this.release(request.conversationId);
				return { reply, outputs: [], skipped: [], ...(notice ? { notice } : {}) };
			}
			const { outputs, skipped } = await this.collect(session, reply);
			return { reply, outputs, skipped, ...(notice ? { notice } : {}) };
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
			if (name.length > MAX_OUTPUT_NAME_CHARS) {
				skipped.push({ name: `${name.slice(0, 60)}…`, reason: "its name is too long" });
				continue;
			}
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

/**
 * The last line of the daemon client's stdout is its JSON reply. It is held to the same schema as a
 * browser's outcome; anything else is a failed call, not a failed run.
 */
export function parseReply(exec: SandboxExecResult): DaemonReply {
	if (!exec.timed_out && isNoReply(exec.stdout)) return failedRun(KILLED_WHY);
	const line = exec.stdout.trim().split("\n").pop() ?? "";
	try {
		const raw = JSON.parse(line) as Record<string, unknown>;
		// The daemon says "no value" with null; the schema says it by leaving the key out.
		const cleaned = Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== null));
		const parsed = outcomeFieldsSchema.safeParse(cleaned);
		if (parsed.success) {
			const { ok, stdout, stderr, result, error, files, timeout } = parsed.data;
			return {
				ok,
				stdout,
				stderr,
				result: result ?? null,
				error: error ?? null,
				files,
				timeout: timeout ?? null,
			};
		}
	} catch {
		/* not JSON: the call itself failed */
	}
	// The kernel killed something and the manager could not confirm it: 137 is SIGKILL with no
	// time limit hit, and "no reply" is the daemon having died under the client. Both are, in
	// practice, the out-of-memory kill (the sandbox's own cap or the shared budget's).
	const killed = !exec.timed_out && (exec.exit_code === 137 || isNoReply(exec.stdout));
	const why = exec.timed_out
		? "the sandbox's own time limit was hit"
		: killed
			? KILLED_WHY
			: (exec.stderr || exec.stdout || `exit code ${exec.exit_code}`).slice(0, 500);
	return failedRun(why);
}

const OOM_WHY = "the sandbox ran out of memory";
const KILLED_WHY = "the sandbox was killed (most likely it ran out of memory)";

/** The manager found the lease gone (404) or its sandbox no longer running (410). */
function isLeaseGone(err: SandboxError): boolean {
	return err.status === 404 || err.status === 410;
}

/** The run.py client's reply when the daemon died before answering. */
function isNoReply(stdout: string): boolean {
	try {
		const raw = JSON.parse(stdout.trim().split("\n").pop() ?? "") as { ok?: unknown; error?: unknown };
		return raw?.ok === false && raw.error === "no reply";
	} catch {
		return false;
	}
}

function failedRun(why: string): DaemonReply {
	return {
		unparsed: true,
		ok: false,
		stdout: "",
		stderr: "",
		error: `The sandbox could not run the code: ${why}`,
		files: [],
	};
}
