import { describe, expect, it } from "vitest";
import { bootstrapWorker } from "./pyodide.worker";
import type { HostToWorker, WorkerToHost } from "./protocol";

/**
 * A missing dist must be diagnosable from the message alone. Production once
 * served the app under a base path while the worker fetched the interpreter
 * from the un-prefixed `/pyodide/` URL, and the browser reported only
 * "Importing a module script failed" — no path, no base. The worker now posts
 * a `loadError` naming the URL it attempted, so the next such failure points
 * at the missed path instead of a cryptic import error.
 */

interface FakeScope {
	location: { origin: string };
	postMessage: (message: WorkerToHost) => void;
	onmessage: ((event: MessageEvent<HostToWorker>) => void) | null;
	fetch: typeof fetch;
	sent: WorkerToHost[];
}

function makeScope(indexURL: string): FakeScope {
	const sent: WorkerToHost[] = [];
	const scope: FakeScope = {
		location: { origin: "http://runtime.test" },
		postMessage: (message) => sent.push(message),
		onmessage: null,
		fetch: globalThis.fetch,
		sent,
	};
	bootstrapWorker(scope as unknown as Parameters<typeof bootstrapWorker>[0], {
		indexURL,
	});
	return scope;
}

async function until(
	scope: FakeScope,
	matches: (message: WorkerToHost) => boolean,
	timeoutMs = 30_000
): Promise<WorkerToHost> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const found = scope.sent.find(matches);
		if (found) return found;
		if (Date.now() > deadline) throw new Error("the worker never answered");
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

describe("pyodide worker load failure", () => {
	it("posts a loadError naming the URL it tried", async () => {
		// A filesystem path that cannot exist: the dynamic import fails fast
		// with no network involved, exercising the boot-failure path only.
		const missing = `${import.meta.dirname}/__missing-pyodide-dist/`;
		const scope = makeScope(missing);

		scope.onmessage?.({
			data: { type: "run", id: 1, code: "1 + 1" },
		} as MessageEvent<HostToWorker>);

		const loadError = (await until(scope, (m) => m.type === "loadError")) as Extract<
			WorkerToHost,
			{ type: "loadError" }
		>;
		expect(loadError.message).toContain(missing);
		expect(loadError.message).toContain("pyodide.mjs");
	});
});
