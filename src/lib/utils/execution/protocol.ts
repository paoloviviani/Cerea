/**
 * Contract between the app and the Pyodide execution worker.
 *
 * Everything crossing the worker boundary is plain structured-clone data, and
 * every constant that bounds the runtime lives here so the host and the worker
 * enforce the same numbers.
 */

/** Where the vendored Pyodide dist is served from (see scripts/sync_pyodide.mjs). */
export const PYODIDE_INDEX_PATH = "/pyodide/";

/** Directory inside the runtime where host-provided files are mounted. */
export const MOUNT_ROOT = "/mnt/data";

/**
 * Hard cap on any single file entering the runtime, in bytes (50 MiB).
 * Enforced before download on the host (Content-Length / stream abort) and
 * re-checked in the worker, so an oversized file is refused by name, never
 * silently truncated.
 */
export const MAX_FILE_BYTES = 50 * 1024 * 1024;

/** Hard wall-clock limit for one code run; the worker is terminated past it. */
export const RUN_TIMEOUT_MS = 20_000;

/** Cold-start budget: wasm compile + stdlib zip + package bootstrap. */
export const LOAD_TIMEOUT_MS = 90_000;

/** A captured output larger than this is truncated with a marker. */
export const MAX_OUTPUT_CHARS = 8_000;

/** The outcome of one executed snippet. `result` is the repr of the last expression. */
export interface RunOutcome {
	ok: boolean;
	stdout: string;
	stderr: string;
	result?: string;
	error?: string;
}

export type HostToWorker =
	| { type: "run"; id: number; code: string }
	| {
			type: "loadFiles";
			id: number;
			files: Array<{ name: string; data: ArrayBuffer | string }>;
	  };

export type WorkerToHost =
	| { type: "loading" }
	| { type: "ready" }
	| { type: "loadError"; message: string }
	| ({ type: "result"; id: number } & RunOutcome)
	| { type: "filesLoaded"; id: number; written: string[] };

/**
 * Strip a client-supplied name to a safe single path segment under
 * MOUNT_ROOT. Everything else (directories, traversal, dotfiles' parents) is
 * collapsed: the runtime's filesystem is a shared namespace, so a crafted
 * filename must not be able to write outside the mount point.
 */
export function safeMountName(name: string): string | null {
	const base = name.replace(/\\/g, "/").split("/").pop() ?? "";
	// eslint-disable-next-line no-control-regex -- control bytes are valid filename attacks
	const cleaned = base.replace(/[\u0000-\u001f]/g, "").trim();
	if (!cleaned || cleaned === "." || cleaned === "..") return null;
	return cleaned.slice(0, 120);
}

/** Truncate captured output to MAX_OUTPUT_CHARS with an explicit marker. */
export function clampOutput(text: string): string {
	const suffix = "… [output truncated]";
	if (text.length <= MAX_OUTPUT_CHARS) return text;
	return `${text.slice(0, Math.max(0, MAX_OUTPUT_CHARS - suffix.length))}${suffix}`;
}
