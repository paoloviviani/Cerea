/**
 * Contract between the app and the Pyodide execution worker.
 *
 * Everything crossing the worker boundary is plain structured-clone data, and
 * every constant that bounds the runtime lives here so the host and the worker
 * enforce the same numbers.
 */

/**
 * Where the vendored Pyodide dist is served from (see scripts/sync_pyodide.mjs),
 * relative to the app's base path. Production serves the app under a base
 * (e.g. ``/chat``), so the absolute path is ``${base}/pyodide/`` — the dist
 * lands in the client build under the base directory, and ``/pyodide/`` alone
 * is a 404 there.
 */
export const PYODIDE_INDEX_PATH = "/pyodide/";

/**
 * The absolute runtime path for the app's configured base. Vite bakes
 * ``import.meta.env.BASE_URL`` to the SvelteKit base at build time, so the
 * worker and the gate agree on it without any runtime message passing.
 * A trailing slash is normalized away so ``"/"`` and ``""`` both yield
 * ``/pyodide/``.
 */
export function pyodideBasePath(baseUrl: string | undefined): string {
	const base = (baseUrl ?? "/").replace(/\/+$/, "");
	return `${base}${PYODIDE_INDEX_PATH}`;
}

/**
 * Where vendored pure-Python wheels are served from micropip's point of view
 * (see scripts/sync_pyodide_wheels.mjs): one PEP 503 "simple" index page per
 * package, named by its canonicalized name, beside the wheel files themselves.
 * The `{package_name}` placeholder is micropip's own templating syntax
 * (`PackageManager.set_index_urls`) — it is substituted with the
 * already-canonicalized requirement name before the fetch.
 */
export function pyodideWheelsIndexTemplate(indexURL: string): string {
	return `${indexURL}wheels/{package_name}.html`;
}

/**
 * The public PyPI simple index (PEP 503), appended to micropip's index list
 * only when the user has opted in to third-party installs (rung c) — see
 * gate.ts's PYPI_ALLOWED_ORIGINS, which is what actually makes fetches to it
 * reach the network. Listed here, not just in the gate, so the worker and the
 * gate agree on the one string without either importing the other's home.
 */
export const PYPI_SIMPLE_INDEX_URL = "https://pypi.org/simple";

/**
 * Cross-origin hosts the gate additionally allows once PyPI installs are
 * opted in: the simple index itself, and the file host it redirects wheel
 * downloads to. Nothing else — no credentials ever accompany these (see
 * gate.ts), so this is read access to public package metadata and wheels,
 * never a channel back to this deployment.
 */
export const PYPI_ALLOWED_ORIGINS = ["https://pypi.org", "https://files.pythonhosted.org"] as const;

/** Directory inside the runtime where host-provided files are mounted. */
export const MOUNT_ROOT = "/mnt/data";

/**
 * The runtime's working directory: where executed code lands when it writes a
 * relative path, so where generated files (a .docx, a .png, a .csv) appear.
 * Files only flow host → worker today through `loadFiles`; this is the
 * directory the new `listFiles`/`readFile` pair reads back, which is what
 * makes a generated file downloadable instead of stranded in the sandbox.
 */
export const EXECUTION_CWD = "/home/pyodide";

/** How many files one listing returns at most; a runaway generator that emits
 * thousands of shards is a UI problem, not 200 honest outputs. */
export const MAX_LISTED_FILES = 200;

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

/** One file the runtime holds: absolute sandbox path and byte size. */
export interface RuntimeFile {
	path: string;
	size: number;
}

/**
 * Whether a worker-reported error is really a clean interpreter exit.
 * `sys.exit(0)` (or a bare `sys.exit()`) rejects `runPythonAsync` with a
 * traceback ending in `SystemExit: 0` — a success the runner must not paint
 * as an error. Anything with a nonzero code stays a failure. Matched on the
 * traceback's final line so a *mention* of SystemExit inside another error's
 * text cannot launder it.
 */
export function isCleanSystemExit(message: string): boolean {
	const lines = message
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
	const last = lines[lines.length - 1] ?? "";
	const match = /^SystemExit(?::\s*(.*))?$/.exec(last);
	if (!match) return false;
	const code = (match[1] ?? "").trim();
	return code === "" || code === "None" || /^0(\.0+)?$/.test(code);
}

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
	  }
	| { type: "removeFile"; id: number; path: string }
	| { type: "listFiles"; id: number }
	| { type: "readFile"; id: number; path: string }
	| { type: "configure"; pypiEnabled: boolean };

export type WorkerToHost =
	| { type: "loading" }
	| { type: "ready" }
	| { type: "loadError"; message: string }
	| ({ type: "result"; id: number } & RunOutcome)
	| { type: "filesLoaded"; id: number; written: string[] }
	| { type: "fileRemoved"; id: number; path: string; error?: string }
	| { type: "filesListed"; id: number; files: RuntimeFile[] }
	| { type: "fileData"; id: number; path: string; data?: ArrayBuffer; error?: string };

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
