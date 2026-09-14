import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RunOutcome } from "./protocol";

/**
 * The worker session is a controllable fake; the store under test is real, so
 * persistence and dedupe behavior are exercised exactly as shipped.
 */
const sessionMock = vi.hoisted(() => {
	const pending: Array<{ resolve: (value: unknown) => void; reject: (error: unknown) => void }> =
		[];
	return {
		run: vi.fn(
			(_code: string) => new Promise((resolve, reject) => pending.push({ resolve, reject }))
		),
		onStatus: vi.fn(() => () => undefined),
		settleNext: (value: unknown) => pending.shift()?.resolve(value),
		failNext: (error: unknown) => pending.shift()?.reject(error),
	};
});

vi.mock("$lib/utils/execution/runtime", () => ({
	getExecutionSession: () => sessionMock,
}));

import {
	ARTIFACT_RUNS_STORAGE_KEY,
	clearArtifactRunsForTests,
	getArtifactRunsStore,
} from "./artifactRuns.svelte";
import { artifactRunKey } from "./keys";

/** Wait until a specific key has landed in storage (a shared queue means other tests' entries may exist too). */
function waitForPersisted(key: string) {
	return vi.waitFor(() => {
		const raw = JSON.parse(localStorage.getItem(ARTIFACT_RUNS_STORAGE_KEY) ?? "{}") as Record<
			string,
			unknown
		>;
		expect(Object.hasOwn(raw, key)).toBe(true);
	});
}

const outcome = (over: Partial<RunOutcome>): RunOutcome => ({
	ok: true,
	stdout: "",
	stderr: "",
	...over,
});

beforeEach(() => {
	localStorage.removeItem(ARTIFACT_RUNS_STORAGE_KEY);
	clearArtifactRunsForTests();
	sessionMock.run.mockClear();
});

describe("artifact run outputs", () => {
	it("persists a settled output under the version's content key", async () => {
		const store = getArtifactRunsStore();
		store?.run("analysis", 2, "print(6*7)");
		await vi.waitFor(() => expect(sessionMock.run).toHaveBeenCalledTimes(1));
		sessionMock.settleNext(outcome({ stdout: "42\n" }));
		// The settle continuation is a microtask; wait for the write to land
		// before simulating the reload.
		await vi.waitFor(() => expect(localStorage.getItem(ARTIFACT_RUNS_STORAGE_KEY)).toBeTruthy());

		// A fresh store — what a page reload constructs — finds the same output.
		clearArtifactRunsForTests();
		const reloaded = getArtifactRunsStore();
		const state = reloaded?.get(artifactRunKey("analysis", 2, "print(6*7)"));
		expect(state?.status).toBe("done");
		expect(state?.outcome?.stdout).toBe("42\n");
	});

	it("keys on content, so an edit to the same version starts clean", async () => {
		const store = getArtifactRunsStore();
		store?.run("analysis", 2, "print(1)");
		await vi.waitFor(() => expect(sessionMock.run).toHaveBeenCalledTimes(1));
		sessionMock.settleNext(outcome({ stdout: "1\n" }));

		// The model edited the cell in place; the new code has no output yet.
		expect(store?.get(artifactRunKey("analysis", 2, "print(2)"))).toBeUndefined();
	});

	it("never re-executes on re-render; only force does", async () => {
		const store = getArtifactRunsStore();
		store?.run("analysis", 1, "print(1)");
		await vi.waitFor(() => expect(sessionMock.run).toHaveBeenCalledTimes(1));
		sessionMock.settleNext(outcome({ stdout: "1\n" }));

		// Version navigation and registry rebuilds re-ask for the same cell.
		store?.run("analysis", 1, "print(1)");
		expect(sessionMock.run).toHaveBeenCalledTimes(1);

		store?.run("analysis", 1, "print(1)", { force: true });
		expect(sessionMock.run).toHaveBeenCalledTimes(2);
		// Drain the forced run so its resolver cannot be consumed by a later
		// test's settle (the pending queue is shared within this file).
		sessionMock.settleNext(outcome({ stdout: "1\n" }));
		await waitForPersisted(artifactRunKey("analysis", 1, "print(1)"));
	});

	it("persists sandbox failures too, so a reload does not silently re-run", async () => {
		const store = getArtifactRunsStore();
		store?.run("analysis", 1, "while True: pass");
		await vi.waitFor(() => expect(sessionMock.run).toHaveBeenCalledTimes(1));
		sessionMock.failNext(new Error("the code did not finish within 20 s and was stopped"));
		await vi.waitFor(() => expect(localStorage.getItem(ARTIFACT_RUNS_STORAGE_KEY)).toBeTruthy());

		clearArtifactRunsForTests();
		const reloaded = getArtifactRunsStore();
		const state = reloaded?.get(artifactRunKey("analysis", 1, "while True: pass"));
		expect(state?.status).toBe("error");
		expect(state?.sandboxError).toContain("did not finish");
		// A sandbox failure carries no outcome, so it is not re-persisted as a
		// success-shaped record.
		expect(state?.outcome).toBeUndefined();
	});
});
