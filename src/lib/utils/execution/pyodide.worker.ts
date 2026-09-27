/// <reference lib="webworker" />
import {
	clampOutput,
	EXECUTION_CWD,
	isCleanSystemExit,
	MAX_FILE_BYTES,
	MAX_LISTED_FILES,
	MOUNT_ROOT,
	pyodideBasePath,
	pyodideWheelsIndexTemplate,
	PYPI_SIMPLE_INDEX_URL,
	safeMountName,
	type HostToWorker,
	type RunOutcome,
	type RuntimeFile,
	type WorkerToHost,
} from "./protocol";
import { installNetworkGate, type NetworkGateController } from "./gate";
import { autoInstallImports } from "./autoInstallImports";

/**
 * The one Pyodide runtime. Runs inside a dedicated module worker so runaway
 * code can be killed with Worker.terminate() without touching the tab, and so
 * the main thread never executes model-written code.
 *
 * The network gate is installed before anything else, including the Pyodide
 * import itself: the interpreter's own asset loads (wasm, stdlib, lockfile)
 * are same-origin `<base>/pyodide/` requests and pass through it, while
 * everything a user script or micropip might reach does not.
 *
 * The body is a `bootstrapWorker(scope)` so the whole pipeline — gate,
 * interpreter boot, run/FS handling — can be exercised against the real
 * vendored dist from Node (see pyodide.worker.integration.spec.ts); the
 * actual worker entry is the one call at the bottom.
 */

type PyodideAPI = import("pyodide").PyodideAPI;

interface WorkerScope {
	location: { origin: string };
	postMessage: (message: WorkerToHost, transfer?: Transferable[]) => void;
	onmessage: ((event: MessageEvent<HostToWorker>) => void) | null;
	addEventListener?: (type: string, listener: (event: Event) => void) => void;
	fetch: typeof fetch;
}

interface BootstrapOptions {
	/**
	 * Override the interpreter's location (tests load the dist straight from
	 * disk); defaults to the same-origin static directory.
	 */
	indexURL?: string;
}

export function bootstrapWorker(
	scope: WorkerScope & Partial<typeof globalThis>,
	options: BootstrapOptions = {}
): void {
	// The gate first: it must be watching before anything, including the
	// interpreter import, can move a byte.
	const gateController: NetworkGateController = installNetworkGate(
		scope as unknown as typeof globalThis
	);
	guardCleanExitRejection(scope);

	let pyodidePromise: Promise<PyodideAPI> | null = null;
	let stdoutBuffer: string[] = [];
	let stderrBuffer: string[] = [];
	// Whether the person has opted in (and the deployment has not killed the
	// switch) to installing arbitrary pure-Python packages from PyPI, on top
	// of the vendored wheels. Set by the host's "configure" message, which is
	// always posted before the first "run" (see runtime.ts ensureWorker), so
	// the very first micropip pin already sees the right value.
	let pypiEnabled = false;
	// Vendored packages installed through micropip this worker's lifetime, so
	// a run that imports `docx` twice pays the install once. A fresh worker
	// (after a timeout kill or a crash) starts with an empty set, correctly:
	// its interpreter has nothing installed either.
	const installedVendoredPackages = new Set<string>();

	function post(message: WorkerToHost, transfer?: Transferable[]): void {
		scope.postMessage(message, transfer ?? []);
	}

	/**
	 * Swallow Pyodide's stray duplicate of a clean interpreter exit. A
	 * `sys.exit(0)` rejects `runPythonAsync` — which the run handler verdicts
	 * — and *also* escapes through the interpreter's internal event loop as a
	 * second rejection nothing can await. Left alone it logs as an unhandled
	 * rejection for a script that worked. Only the clean-exit shape is
	 * stopped here, with the same predicate as the verdict; every other
	 * rejection still surfaces.
	 */
	function guardCleanExitRejection(scope: WorkerScope): void {
		if (typeof scope.addEventListener !== "function") return;
		scope.addEventListener("unhandledrejection", (event: Event) => {
			const rejection = event as PromiseRejectionEvent;
			const reason = rejection.reason as unknown;
			const message = reason instanceof Error ? reason.message : String(reason ?? "");
			if (isCleanSystemExit(message)) rejection.preventDefault();
		});
	}

	function resolveIndexURL(): string {
		if (options.indexURL) return options.indexURL;
		// Vite bakes import.meta.env.BASE_URL to the SvelteKit base at build
		// time (e.g. "/chat/"), so the dist fetch lands at <base>/pyodide/
		// where static/pyodide/ is actually served — "/pyodide/" alone is a
		// 404 there. Same source the gate allowlists, so the runtime passes
		// its own gate.
		const basePath = pyodideBasePath(
			(import.meta as { env?: { BASE_URL?: string } }).env?.BASE_URL
		);
		return new URL(basePath, scope.location.origin).href;
	}

	/**
	 * (Re-)point micropip at the vendored wheels, plus the public PyPI simple
	 * index when the person has opted in. `loadPackage("micropip")` is
	 * required first: this Pyodide build does not auto-bootstrap micropip on
	 * a bare `import micropip` the way some earlier releases did — without
	 * it the import raises `ModuleNotFoundError` and the pin silently never
	 * takes effect. `loadPackage` no-ops on an already-loaded package, so
	 * calling this again on every "configure" (a live toggle, not just boot)
	 * is cheap.
	 */
	async function pinMicropipIndex(py: PyodideAPI, indexURL: string): Promise<void> {
		await py.loadPackage("micropip");
		const indexUrls = pypiEnabled
			? [pyodideWheelsIndexTemplate(indexURL), PYPI_SIMPLE_INDEX_URL]
			: [pyodideWheelsIndexTemplate(indexURL)];
		await py.runPythonAsync(
			["import micropip", `micropip.set_index_urls(${JSON.stringify(indexUrls)})`].join("\n")
		);
	}

	async function getPyodide(): Promise<PyodideAPI> {
		if (!pyodidePromise) {
			post({ type: "loading" });
			pyodidePromise = (async () => {
				// The dist is served same-origin from static/pyodide/ (gitignored,
				// regenerated by scripts/sync_pyodide.mjs), i.e. at
				// <base>/pyodide/ in production. The dynamic import must
				// stay opaque to Vite — the file is a static asset, not a bundle input.
				const indexURL = resolveIndexURL();
				try {
					const { loadPyodide } = await import(/* @vite-ignore */ `${indexURL}pyodide.mjs`);
					const py = await loadPyodide({
						indexURL,
						lockFileURL: `${indexURL}pyodide-lock.json`,
						stdLibURL: `${indexURL}python_stdlib.zip`,
					});
					py.FS.mkdirTree(MOUNT_ROOT);
					// Output capture is per-run: runs are serialized, so module buffers
					// are unambiguous. Batched handlers coalesce per newline, which keeps
					// line-oriented output ordered without a callback per byte.
					py.setStdout({
						batched: (chunk: string) => {
							stdoutBuffer.push(chunk.endsWith("\n") ? chunk : `${chunk}\n`);
						},
					});
					py.setStderr({
						batched: (chunk: string) => {
							stderrBuffer.push(chunk.endsWith("\n") ? chunk : `${chunk}\n`);
						},
					});
					await pinMicropipIndex(py, indexURL);
					post({ type: "ready" });
					return py;
				} catch (err) {
					// Name the URL attempted: a 404 here surfaces in the browser
					// as the cryptic "Importing a module script failed", which
					// says nothing about which path missed. The host turns this
					// into a broken status plus a load-kind ExecutionError.
					post({
						type: "loadError",
						message: `failed to load the Python runtime from ${indexURL}pyodide.mjs: ${describeError(err)}`,
					});
					throw err;
				}
			})();
			pyodidePromise.catch(() => {
				// A failed load must not wedge every future request on a broken
				// promise: clear it so the next run retries from scratch.
				pyodidePromise = null;
			});
		}
		return pyodidePromise;
	}

	function drainBuffers(): { stdout: string; stderr: string } {
		const stdout = stdoutBuffer.join("");
		const stderr = stderrBuffer.join("");
		stdoutBuffer = [];
		stderrBuffer = [];
		return { stdout: clampOutput(stdout), stderr: clampOutput(stderr) };
	}

	function describeError(err: unknown): string {
		const message = err instanceof Error ? err.message : String(err ?? "unknown error");
		// PyProxy exceptions carry the Python traceback in `message`; releasing
		// the proxy afterwards keeps a raised-per-run exception from leaking
		// memory.
		const proxy = err as { destroy?: () => void } | null | undefined;
		if (proxy && typeof proxy.destroy === "function") {
			try {
				proxy.destroy();
			} catch {
				// Already dead along with the interpreter state; nothing to do.
			}
		}
		return clampOutput(message || "unknown error");
	}

	function reprResult(value: unknown): string | undefined {
		if (value === undefined || value === null) return undefined;
		try {
			const text = String(value);
			return text === "" ? undefined : clampOutput(text);
		} catch {
			return "<unprintable result>";
		} finally {
			const proxy = value as { destroy?: () => void } | null;
			if (proxy && typeof proxy.destroy === "function") {
				try {
					proxy.destroy();
				} catch {
					// The repr already surfaced; the proxy cleanup is best effort.
				}
			}
		}
	}

	/**
	 * Install a run's own imports before it runs (see ./autoInstallImports):
	 * Pyodide's own lock-file packages via `loadPackagesFromImports`, and the
	 * vendored document packages through micropip against the same-origin
	 * index only. `find_imports` on the `pyodide.code` module is a static
	 * (AST-based) scan, not an execution — robust against code that never
	 * actually runs far enough to import anything, unlike a regex over the
	 * source text. It is reached through `pyimport`: the public API object
	 * carries no `code` namespace, only the internal one does.
	 */
	function autoInstall(py: PyodideAPI, code: string): Promise<void> {
		return autoInstallImports(
			{
				findImports: (c) => {
					const codeModule = py.pyimport("pyodide.code") as unknown as {
						find_imports(source: string): { toJs(): string[]; destroy(): void };
						destroy(): void;
					};
					try {
						const found = codeModule.find_imports(c);
						try {
							return found.toJs();
						} finally {
							found.destroy();
						}
					} finally {
						codeModule.destroy();
					}
				},
				loadPackagesFromImports: (c) => py.loadPackagesFromImports(c),
				installPackage: (packageName) =>
					py.runPythonAsync(
						["import micropip", `await micropip.install(${JSON.stringify(packageName)})`].join("\n")
					),
				onInstalling: (packageName) => stdoutBuffer.push(`Installing ${packageName}…\n`),
			},
			code,
			installedVendoredPackages
		);
	}

	async function run(id: number, code: string): Promise<void> {
		stdoutBuffer = [];
		stderrBuffer = [];
		let outcome: RunOutcome;
		try {
			const py = await getPyodide();
			await autoInstall(py, code);
			const result = await py.runPythonAsync(code);
			outcome = { ok: true, ...drainBuffers(), result: reprResult(result) };
		} catch (err) {
			const message = describeError(err);
			// A clean interpreter exit is a success the runner used to paint as
			// an error: `sys.exit(0)` rejects runPythonAsync with a traceback
			// ending in `SystemExit: 0`, and the ERROR block it produced sent
			// people debugging a script that had worked.
			if (isCleanSystemExit(message)) {
				outcome = { ok: true, ...drainBuffers(), result: undefined };
			} else {
				outcome = { ok: false, ...drainBuffers(), error: message };
			}
		}
		post({ type: "result", id, ...outcome });
	}

	async function loadFiles(
		id: number,
		files: Array<{ name: string; data: ArrayBuffer | string }>
	): Promise<void> {
		try {
			const py = await getPyodide();
			py.FS.mkdirTree(MOUNT_ROOT);
			const written: string[] = [];
			for (const file of files) {
				const name = safeMountName(file.name);
				if (!name) {
					post({
						type: "result",
						id,
						ok: false,
						stdout: "",
						stderr: "",
						error: `invalid file name: ${file.name}`,
					});
					return;
				}
				if (typeof file.data === "string") {
					py.FS.writeFile(`${MOUNT_ROOT}/${name}`, file.data);
				} else {
					if (file.data.byteLength > MAX_FILE_BYTES) {
						post({
							type: "result",
							id,
							ok: false,
							stdout: "",
							stderr: "",
							error: `${name} is larger than the 50 MB runtime cap`,
						});
						return;
					}
					py.FS.writeFile(`${MOUNT_ROOT}/${name}`, new Uint8Array(file.data));
				}
				written.push(`${MOUNT_ROOT}/${name}`);
			}
			post({ type: "filesLoaded", id, written });
		} catch (err) {
			post({
				type: "result",
				id,
				ok: false,
				stdout: "",
				stderr: "",
				error: describeError(err),
			});
		}
	}

	async function removeFile(id: number, path: string): Promise<void> {
		try {
			const py = await getPyodide();
			// Only files under the mount point may be removed: the runtime's
			// filesystem is shared state, and the interpreter's own files are not
			// the UI's to delete.
			if (!path.startsWith(`${MOUNT_ROOT}/`) || path.includes("..")) {
				post({ type: "fileRemoved", id, path, error: "only /mnt/data files can be removed" });
				return;
			}
			py.FS.unlink(path);
			post({ type: "fileRemoved", id, path });
		} catch (err) {
			post({ type: "fileRemoved", id, path, error: describeError(err) });
		}
	}

	/**
	 * Whether the UI may read this path back out of the runtime. Generated
	 * files land in the working directory; mounted inputs live under the
	 * mount root. Everything else is interpreter state, not user output, and
	 * `..` never resolves anywhere — the check is on the raw string, before
	 * the FS normalizes anything.
	 */
	function readablePath(path: string): boolean {
		if (!path.startsWith("/") || path.includes("..")) return false;
		return path.startsWith(`${EXECUTION_CWD}/`) || path.startsWith(`${MOUNT_ROOT}/`);
	}

	async function listFiles(id: number): Promise<void> {
		try {
			const py = await getPyodide();
			const found: RuntimeFile[] = [];
			const walk = (dir: string): void => {
				if (found.length >= MAX_LISTED_FILES) return;
				let entries: string[];
				try {
					entries = py.FS.readdir(dir);
				} catch {
					return;
				}
				for (const entry of entries) {
					if (found.length >= MAX_LISTED_FILES) return;
					if (entry === "." || entry === "..") continue;
					const full = dir === "/" ? `/${entry}` : `${dir}/${entry}`;
					let mode: number | undefined;
					let size = 0;
					try {
						const st = py.FS.stat(full);
						mode = st.mode;
						size = st.size;
					} catch {
						continue;
					}
					if (mode !== undefined && py.FS.isDir(mode)) walk(full);
					else found.push({ path: full, size });
				}
			};
			walk(EXECUTION_CWD);
			post({ type: "filesListed", id, files: found });
		} catch (err) {
			post({
				type: "result",
				id,
				ok: false,
				stdout: "",
				stderr: "",
				error: describeError(err),
			});
		}
	}

	async function readFile(id: number, path: string): Promise<void> {
		if (!readablePath(path)) {
			post({
				type: "fileData",
				id,
				path,
				error: `only ${EXECUTION_CWD} and ${MOUNT_ROOT} files can be downloaded`,
			});
			return;
		}
		try {
			const py = await getPyodide();
			let size = 0;
			try {
				size = py.FS.stat(path).size;
			} catch {
				post({ type: "fileData", id, path, error: `no such file: ${path}` });
				return;
			}
			if (size > MAX_FILE_BYTES) {
				post({
					type: "fileData",
					id,
					path,
					error: `${path} is larger than the 50 MB runtime cap`,
				});
				return;
			}
			// slice() copies into an exactly-sized buffer: the FS view's own
			// buffer may span a larger allocation, and the whole thing would
			// transfer otherwise.
			const data = py.FS.readFile(path).slice().buffer as ArrayBuffer;
			post({ type: "fileData", id, path, data }, [data]);
		} catch (err) {
			post({ type: "fileData", id, path, error: describeError(err) });
		}
	}

	function configure(enabled: boolean): void {
		pypiEnabled = enabled;
		gateController.setPyPiEnabled(pypiEnabled);
		// A first boot picks up pypiEnabled naturally (configure always arrives
		// before the first "run", see runtime.ts's ensureWorker); this re-pin is
		// for a value changed live, after the interpreter is already up.
		if (pyodidePromise) {
			void pyodidePromise
				.then((py) => pinMicropipIndex(py, resolveIndexURL()))
				.catch(() => {
					// A load failure already posted "loadError"; nothing more to do.
				});
		}
	}

	scope.onmessage = (event: MessageEvent<HostToWorker>) => {
		const data = event.data;
		if (!data || typeof data !== "object") return;
		if (data.type === "run") void run(data.id, data.code);
		if (data.type === "loadFiles") void loadFiles(data.id, data.files);
		if (data.type === "removeFile") void removeFile(data.id, data.path);
		if (data.type === "listFiles") void listFiles(data.id);
		if (data.type === "readFile") void readFile(data.id, data.path);
		if (data.type === "configure") configure(data.pypiEnabled);
	};
}

// The real entry: only inside a worker context. Tests import
// `bootstrapWorker` directly and drive a fake scope, so this file must stay
// inert wherever `WorkerGlobalScope` does not exist.
if (typeof WorkerGlobalScope !== "undefined" && self instanceof WorkerGlobalScope) {
	bootstrapWorker(self as unknown as WorkerScope & Partial<typeof globalThis>);
}
