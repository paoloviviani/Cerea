import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RunOutcome } from "./protocol";

/**
 * The worker session is a controllable fake; the store under test is real, so
 * the settle-then-collect ordering is exercised exactly as shipped.
 *
 * Regression cover for the cross-device deliverable bug: the outcome used to
 * settle before the async file listing landed, so the `execute_code` card
 * posted its one-shot outcome with `files: []` — winning the server-side CAS
 * — while the bytes uploaded a tick later were dropped as a duplicate.
 * `outputsCollected` is the flag the card waits on before posting.
 */
const sessionMock = vi.hoisted(() => {
	const pendingRuns: Array<{
		resolve: (value: unknown) => void;
		reject: (error: unknown) => void;
	}> = [];
	let listFilesImpl: () => Promise<Array<{ path: string; size: number }>> = async () => [];
	return {
		run: vi.fn(
			(_code: string) => new Promise((resolve, reject) => pendingRuns.push({ resolve, reject }))
		),
		listFiles: vi.fn(() => listFilesImpl()),
		// Every file reads back as the bytes 1, 2, 3.
		readFile: vi.fn(async (_path: string) => new Uint8Array([1, 2, 3]).buffer),
		onStatus: vi.fn(() => () => undefined),
		settleNext: (value: unknown) => pendingRuns.shift()?.resolve(value),
		failNext: (error: unknown) => pendingRuns.shift()?.reject(error),
		deferListFiles: () => {
			let release!: (files: Array<{ path: string; size: number }>) => void;
			const gate = new Promise<Array<{ path: string; size: number }>>(
				(resolve) => (release = resolve)
			);
			listFilesImpl = () => gate;
			return release;
		},
		resetListFiles: () => {
			listFilesImpl = async () => [];
		},
	};
});

vi.mock("$lib/utils/execution/runtime", () => ({
	getExecutionSession: () => sessionMock,
}));

import { getRunsStore } from "./runs.svelte";
import { chatRunKey } from "./keys";

const outcome = (over: Partial<RunOutcome>): RunOutcome => ({
	ok: true,
	stdout: "",
	stderr: "",
	...over,
});

beforeEach(() => {
	sessionMock.run.mockClear();
	sessionMock.listFiles.mockClear();
	sessionMock.resetListFiles();
});

describe("runs store output collection", () => {
	it("settles the outcome before the file listing, then marks collection", async () => {
		const release = sessionMock.deferListFiles();
		const code = `print("collect-flag-1-${Date.now()}")`;
		const store = getRunsStore();
		store?.run(chatRunKey(code), code);
		await vi.waitFor(() => expect(sessionMock.run).toHaveBeenCalledTimes(1));
		sessionMock.settleNext(outcome({ stdout: "hi\n" }));

		// The outcome lands synchronously; the listing is still in flight, so
		// a waiter on the flag must hold off (this is the window the card's
		// POST used to fire in, with no files).
		await vi.waitFor(() => expect(store?.get(chatRunKey(code))?.status).toBe("done"));
		expect(store?.get(chatRunKey(code))?.outputsCollected).not.toBe(true);

		release([{ path: "/home/pyodide/out.csv", size: 120 }]);
		await vi.waitFor(() => expect(store?.get(chatRunKey(code))?.outputsCollected).toBe(true));
		// Fingerprinted where the bytes are first read: the size is the bytes'
		// own and the sha256 is theirs, so no card waits on an upload to know it.
		expect(store?.get(chatRunKey(code))?.outputFiles).toEqual([
			{
				path: "/home/pyodide/out.csv",
				size: 3,
				sha256: "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81",
			},
		]);
	});

	it("marks collection even when the run produced no files", async () => {
		const code = `print("collect-flag-2-${Date.now()}")`;
		const store = getRunsStore();
		store?.run(chatRunKey(code), code);
		await vi.waitFor(() => expect(sessionMock.run).toHaveBeenCalledTimes(1));
		sessionMock.settleNext(outcome({ stdout: "hi\n" }));

		// Empty listing (listFiles resolves []) must still flip the flag, or
		// the card would wait out the whole park deadline on a fileless run.
		await vi.waitFor(() => expect(store?.get(chatRunKey(code))?.outputsCollected).toBe(true));
		expect(store?.get(chatRunKey(code))?.outputFiles).toEqual([]);
	});

	it("marks collection immediately on a sandbox-level failure", async () => {
		const code = `while True: pass # collect-flag-3-${Date.now()}`;
		const store = getRunsStore();
		store?.run(chatRunKey(code), code);
		await vi.waitFor(() => expect(sessionMock.run).toHaveBeenCalledTimes(1));
		sessionMock.failNext(new Error("the code did not finish within 20 s and was stopped"));

		await vi.waitFor(() => expect(store?.get(chatRunKey(code))?.status).toBe("error"));
		expect(store?.get(chatRunKey(code))?.sandboxError).toContain("did not finish");
		expect(store?.get(chatRunKey(code))?.outputsCollected).toBe(true);
	});

	it("keeps the time-limit details of a stopped run for the model's result", async () => {
		const code = `while True: pass # timeout-details-${Date.now()}`;
		const store = getRunsStore();
		store?.run(chatRunKey(code), code);
		await vi.waitFor(() => expect(sessionMock.run).toHaveBeenCalledTimes(1));
		const stopped = Object.assign(new Error("stopped"), {
			timeout: { seconds: 60, mountedFiles: ["/mnt/data/a.xlsx"] },
		});
		sessionMock.failNext(stopped);

		await vi.waitFor(() => expect(store?.get(chatRunKey(code))?.status).toBe("error"));
		expect(store?.get(chatRunKey(code))?.timeout).toEqual({
			seconds: 60,
			mountedFiles: ["/mnt/data/a.xlsx"],
		});
	});
});
