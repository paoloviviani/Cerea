import CodeBlock from "./CodeBlock.svelte";
import { render } from "vitest-browser-svelte";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { tick } from "svelte";
import type { RunOutcome } from "$lib/utils/execution/protocol";

/**
 * The real runs store is exercised; only the worker session underneath is a
 * controllable fake, so the component's contract is tested against the same
 * code path the browser uses. The store is module-scoped, so every test uses
 * its own snippet: identical code maps to one key and would dedupe across
 * tests otherwise.
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
	ExecutionError: class extends Error {
		kind: string;
		constructor(kind: string, message: string) {
			super(message);
			this.kind = kind;
		}
	},
}));

const outcome = (over: Partial<RunOutcome>): RunOutcome => ({
	ok: true,
	stdout: "",
	stderr: "",
	...over,
});

const mount = (props: Record<string, unknown>) => {
	const rawCode = (props.rawCode as string) ?? "print('hi')";
	const screen = render(CodeBlock, {
		code: rawCode,
		rawCode,
		loading: false,
		language: "python",
		autorun: false,
		...props,
	});
	return {
		screen,
		runButton: () => screen.getByTitle("Run this code in the browser sandbox"),
	};
};

beforeEach(() => {
	sessionMock.run.mockClear();
});

describe("CodeBlock execution", () => {
	it("offers Run for python blocks and does not execute history unprompted", async () => {
		const { runButton } = mount({ rawCode: "print('a')" });
		await tick();
		expect(runButton().elements().length).toBe(1);
		expect(sessionMock.run).not.toHaveBeenCalled();
	});

	it("auto-runs a python fence once it closes after streaming in", async () => {
		const { screen } = mount({ rawCode: "print('b')", autorun: true, loading: true });
		await tick();
		expect(sessionMock.run).not.toHaveBeenCalled();

		await screen.rerender({ loading: false });
		await vi.waitFor(() => expect(sessionMock.run).toHaveBeenCalledWith("print('b')"));

		// The settled output renders inline under the block.
		sessionMock.settleNext(outcome({ stdout: "hi\n" }));
		await tick();
		const text = screen.baseElement.textContent ?? "";
		expect(text).toContain("Finished");
		expect(text).toContain("hi\n");
	});

	it("never auto-runs fences that did not stream (history reloads stay inert)", async () => {
		const { screen } = mount({ rawCode: "print('c')", autorun: true, loading: false });
		await screen.rerender({});
		await tick();
		expect(sessionMock.run).not.toHaveBeenCalled();
	});

	it("ignores non-python fences entirely", async () => {
		const { screen, runButton } = mount({
			rawCode: "console.log('d')",
			language: "javascript",
			autorun: true,
			loading: true,
		});
		await screen.rerender({ loading: false });
		await tick();
		expect(sessionMock.run).not.toHaveBeenCalled();
		expect(runButton().elements().length).toBe(0);
	});

	it("shows python errors as errors, not silence", async () => {
		const { screen } = mount({ rawCode: "print('e')", autorun: true, loading: true });
		await screen.rerender({ loading: false });
		await vi.waitFor(() => expect(sessionMock.run).toHaveBeenCalledTimes(1));
		sessionMock.settleNext(outcome({ ok: false, error: "ZeroDivisionError: division by zero" }));
		await tick();
		const text = screen.baseElement.textContent ?? "";
		expect(text).toContain("Finished with errors");
		expect(text).toContain("ZeroDivisionError: division by zero");
	});

	it("reports a sandbox-level failure distinctly from a python error", async () => {
		const { screen } = mount({ rawCode: "print('f')", autorun: true, loading: true });
		await screen.rerender({ loading: false });
		await vi.waitFor(() => expect(sessionMock.run).toHaveBeenCalledTimes(1));
		sessionMock.failNext(new Error("the code did not finish within 20 s"));
		await tick();
		const text = screen.baseElement.textContent ?? "";
		expect(text).toContain("Execution failed");
		expect(text).toContain("did not finish within 20 s");
	});

	it("re-runs on the explicit Run button even after a settled outcome", async () => {
		const { runButton } = mount({ rawCode: "print('g')" });
		await tick();
		await runButton().click();
		await vi.waitFor(() => expect(sessionMock.run).toHaveBeenCalledTimes(1));
		sessionMock.settleNext(outcome({ stdout: "a" }));
		await vi.waitFor(() => expect(runButton().elements()[0]).toBeEnabled());
		await runButton().click();
		await tick();
		expect(sessionMock.run).toHaveBeenCalledTimes(2);
	});
});
