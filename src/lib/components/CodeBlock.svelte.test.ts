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
		const cluster = screen.baseElement.querySelector(".group.relative div.pointer-events-auto");
		const runOutput = details?.nextElementSibling;
		expect(fence).not.toBeNull();
		expect(details).not.toBeNull();
		expect(cluster).not.toBeNull();
		expect(runOutput).not.toBeNull();

		// One left edge for everything the block stacks: the fence's
		// text inset. This regressed once as mx-3 against the fence's px-5, which
		// pushed the run-output box 8px left of the code and the disclosure.
		const fenceTextLeft = Number.parseFloat(getComputedStyle(fence as HTMLElement).paddingLeft);
		const detailsRect = (details as HTMLElement).getBoundingClientRect();
		const runRect = (runOutput as HTMLElement).getBoundingClientRect();
		expect(Math.abs(detailsRect.left - fenceTextLeft)).toBeLessThan(1);
		expect(Math.abs(runRect.left - fenceTextLeft)).toBeLessThan(1);

		// The button cluster ends where the fold box ends: the unfolded-state
		// position (top-2/right-2, md:top-3/md:right-3) left the cluster's
		// right edge 8px past the fold box on md+ and 12px past on small
		// screens, straddling the box's rounded corner, while vertically it
		// hung 6-10px below the header row. Folded, the cluster is pinned to
		// the box's right edge and centred on its header row.
		const clusterRect = (cluster as HTMLElement).getBoundingClientRect();
		expect(Math.abs(clusterRect.right - detailsRect.right)).toBeLessThan(1);
		const topGap = clusterRect.top - detailsRect.top;
		const bottomGap = detailsRect.bottom - clusterRect.bottom;
		expect(Math.abs(topGap - bottomGap)).toBeLessThan(1);

		// And the run-output box shares the fold box's edges on the right too.
		expect(Math.abs(detailsRect.right - runRect.right)).toBeLessThan(1);

		// The FILES list is a real list: every child of its ul is an li card.
		const filesList = runOutput?.querySelector("ul");
		expect(filesList).not.toBeNull();
		for (const child of Array.from(filesList?.children ?? [])) {
			expect(child.tagName).toBe("LI");
		}
	});

	it("keeps the button cluster pinned to the container corner when unfolded", async () => {
		const { screen } = mount({ rawCode: "print('k')" });
		await tick();
		const container = screen.baseElement.querySelector(".group.relative");
		const cluster = screen.baseElement.querySelector(".group.relative div.pointer-events-auto");
		const pre = screen.baseElement.querySelector("pre");
		expect(container).not.toBeNull();
		expect(cluster).not.toBeNull();
		expect(pre).not.toBeNull();

		const containerRect = (container as HTMLElement).getBoundingClientRect();
		const clusterRect = (cluster as HTMLElement).getBoundingClientRect();
		// The tuned unfolded position, which the fold fix must not move:
		// right-2/top-2, stepped up to 12px from 768px (md) up.
		const wide = window.innerWidth >= 768;
		const inset = wide ? 12 : 8;
		expect(Math.abs(containerRect.right - clusterRect.right - inset)).toBeLessThan(1);
		expect(Math.abs(clusterRect.top - containerRect.top - inset)).toBeLessThan(1);

		// The fence it overlays is full-width and borderless, which is why the
		// corner position is correct in this state.
		const preRect = (pre as HTMLElement).getBoundingClientRect();
		expect(Math.abs(preRect.right - containerRect.right)).toBeLessThan(1);
		expect(Math.abs(preRect.left - containerRect.left)).toBeLessThan(1);
	});
});

describe("CodeBlock direct-emission file blocks", () => {
	const content = "# Report\n\nAll quiet.";

	/** Captures the card's download without triggering a real browser download. */
	function spyDownload() {
		const blobs: Blob[] = [];
		const createObjectURL = vi
			.spyOn(URL, "createObjectURL")
			.mockImplementation((blob: Blob | MediaSource) => {
				blobs.push(blob as Blob);
				return "blob:mock";
			});
		const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
		return {
			blobs,
			click,
			restore: () => {
				createObjectURL.mockRestore();
				click.mockRestore();
			},
		};
	}

	it("renders a closed titled fence as a file card with name and byte size", async () => {
		const { screen } = mount({
			rawCode: content,
			language: "markdown title=report.md",
			autorun: true,
		});
		await tick();
		await expect.element(screen.getByText("report.md")).toBeVisible();
		// The size is derived from the block's own UTF-8 bytes: 20 B.
		const bytes = new TextEncoder().encode(content).length;
		expect(bytes).toBe(20);
		await expect.element(screen.getByText("20 B")).toBeVisible();
		await expect.element(screen.getByRole("button", { name: "Download report.md" })).toBeVisible();
	});

	it("downloads the exact block bytes under the annotated filename", async () => {
		const spy = spyDownload();
		try {
			const { screen } = mount({
				rawCode: content,
				language: "markdown title=report.md",
				autorun: true,
			});
			await tick();
			await screen.getByRole("button", { name: "Download report.md" }).click();
			await vi.waitFor(() => expect(spy.click).toHaveBeenCalled());
			const anchor = spy.click.mock.contexts[0] as HTMLAnchorElement;
			expect(anchor.download).toBe("report.md");
			expect(await spy.blobs[0].text()).toBe(content);
			// Zero execution: the sandbox was never started for this download.
			expect(sessionMock.readFile).not.toHaveBeenCalled();
			expect(sessionMock.run).not.toHaveBeenCalled();
		} finally {
			spy.restore();
		}
	});

	it("previews a previewable kind inline without the sandbox", async () => {
		const { screen } = mount({
			rawCode: content,
			language: "markdown title=report.md",
			autorun: true,
		});
		await tick();
		await screen.getByRole("button", { name: "Preview report.md" }).click();
		await expect.element(screen.getByText("# Report")).toBeVisible();
		expect(sessionMock.readFile).not.toHaveBeenCalled();
	});

	it("streams an unclosed titled fence as an ordinary code block, box only after close", async () => {
		const { screen } = mount({
			rawCode: content,
			language: "markdown title=report.md",
			autorun: true,
			loading: true,
		});
		await tick();
		// While streaming: the code fence renders, no file card exists yet.
		expect(screen.baseElement.querySelector("pre")).not.toBeNull();
		expect(screen.baseElement.querySelector('button[aria-label="Download report.md"]')).toBeNull();

		await screen.rerender({ loading: false });
		await expect.element(screen.getByText("report.md")).toBeVisible();
		await expect.element(screen.getByRole("button", { name: "Download report.md" })).toBeVisible();
	});

	it("never executes a titled python block — the file is the deliverable, not a program", async () => {
		const { screen } = mount({
			rawCode: "print('script')",
			language: "python title=script.py",
			autorun: true,
			loading: true,
		});
		await screen.rerender({ loading: false });
		await expect.element(screen.getByText("script.py")).toBeVisible();
		await tick();
		expect(sessionMock.run).not.toHaveBeenCalled();
		expect(screen.baseElement.querySelector('button[aria-label="Run code"]')).toBeNull();
	});

	it("does not treat plain language tags as file blocks", async () => {
		const { screen } = mount({
			rawCode: "console.log('x')",
			language: "javascript",
			autorun: true,
		});
		await tick();
		expect(screen.baseElement.querySelectorAll('button[aria-label^="Download"]').length).toBe(0);
		// The fence itself is still there.
		expect(screen.baseElement.querySelector("pre")).not.toBeNull();
	});
});
