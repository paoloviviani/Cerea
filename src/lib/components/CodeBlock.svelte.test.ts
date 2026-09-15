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
		// Mirrors the real ExecutionSession surface the stores call: run
		// outcomes settle first, the file listing amends the entry when it
		// lands. A mock without listFiles would leave every files assertion
		// in this file (and any file sharing the mocked module) untestable.
		listFiles: vi.fn(async () => [] as Array<{ path: string; size: number }>),
		readFile: vi.fn(async (_path: string) => new ArrayBuffer(0)),
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
	sessionMock.listFiles.mockClear();
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
		// Drain the second run: the pending queue is shared within this file,
		// and an unsettled entry would be consumed by a later test's settle.
		sessionMock.settleNext(outcome({ stdout: "a" }));
		await tick();
	});

	it("folds the code behind a disclosure when the run generated files", async () => {
		sessionMock.listFiles.mockResolvedValueOnce([{ path: "/home/pyodide/out.txt", size: 3 }]);
		const { screen } = mount({ rawCode: "print('h')", autorun: true, loading: true });
		await screen.rerender({ loading: false });
		await vi.waitFor(() => expect(sessionMock.run).toHaveBeenCalledTimes(1));
		sessionMock.settleNext(outcome({ stdout: "[ok]\n" }));

		// File-first: the disclosure names the deliverable, the file card
		// offers the download, and the code is folded but present.
		await expect.element(screen.getByText(/View code/)).toBeVisible();
		const details = screen.baseElement.querySelector("details");
		expect(details).not.toBeNull();
		expect(details?.hasAttribute("open")).toBe(false);
		expect(details?.textContent).toContain("print('h')");
		await expect.element(screen.getByRole("button", { name: "Download out.txt" })).toBeVisible();
	});

	it("leaves code expanded when the run generated no files", async () => {
		const { screen } = mount({ rawCode: "print('i')", autorun: true, loading: true });
		await screen.rerender({ loading: false });
		await vi.waitFor(() => expect(sessionMock.run).toHaveBeenCalledTimes(1));
		sessionMock.settleNext(outcome({ stdout: "i\n" }));
		await vi.waitFor(() => expect(screen.baseElement.textContent ?? "").toContain("Finished"));
		// No files, no fold: the code-first rendering is untouched.
		expect(screen.baseElement.querySelector("details")).toBeNull();
	});

	it("aligns the run output with the code text and the disclosure", async () => {
		// Files plus stdout so all three stacked siblings render: the fence's
		// code text, the disclosure box and the RunOutput box.
		sessionMock.listFiles.mockResolvedValueOnce([{ path: "/home/pyodide/out.txt", size: 3 }]);
		const { screen } = mount({ rawCode: "print('j')", autorun: true, loading: true });
		await screen.rerender({ loading: false });
		await vi.waitFor(() => expect(sessionMock.run).toHaveBeenCalledTimes(1));
		sessionMock.settleNext(outcome({ stdout: "out\n" }));
		await vi.waitFor(() => expect(screen.baseElement.textContent ?? "").toContain("Finished"));

		const fence = screen.baseElement.querySelector("pre");
		const details = screen.baseElement.querySelector("details");
		const runOutput = details?.nextElementSibling;
		expect(fence).not.toBeNull();
		expect(details).not.toBeNull();
		expect(runOutput).not.toBeNull();

		// One left edge for everything the block stacks: the fence's text
		// inset. This regressed once as mx-3 against the fence's px-5, which
		// pushed the run-output box 8px left of the code and the disclosure.
		const fenceTextLeft = Number.parseFloat(getComputedStyle(fence as HTMLElement).paddingLeft);
		const detailsLeft = (details as HTMLElement).getBoundingClientRect().left;
		const runLeft = (runOutput as HTMLElement).getBoundingClientRect().left;
		expect(Math.abs(detailsLeft - fenceTextLeft)).toBeLessThan(1);
		expect(Math.abs(runLeft - fenceTextLeft)).toBeLessThan(1);

		// The FILES list is a real list: every child of its ul is an li card.
		const filesList = runOutput?.querySelector("ul");
		expect(filesList).not.toBeNull();
		for (const child of Array.from(filesList?.children ?? [])) {
			expect(child.tagName).toBe("LI");
		}
	});
});
