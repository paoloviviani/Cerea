import CodeBlock from "./CodeBlock.svelte";
import ChatMessage from "./chat/ChatMessage.svelte";
import { markdownPoolReady } from "$lib/utils/markdownWorkerPool";
import { render } from "vitest-browser-svelte";
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { tick } from "svelte";
import type { RunOutcome } from "$lib/utils/execution/protocol";
import { sidePane } from "$lib/stores/sidePane.svelte";
import { runFiles } from "$lib/stores/runFiles.svelte";
import { MESSAGE_RUN_CONTEXT, type MessageRunContext } from "$lib/utils/execution/messageContext";
import { CODE_EXECUTION_DISABLED } from "$lib/utils/execution/codeExecutionDisabled";

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
		// Every file reads back as the bytes 1, 2, 3.
		readFile: vi.fn(async (_path: string) => new Uint8Array([1, 2, 3]).buffer),
		onStatus: vi.fn(() => () => undefined),
		pendingCount: () => pending.length,
		drain: () => pending.splice(0).length,
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
	const loading = (props.loading as boolean | undefined) ?? false;
	const screen = render(CodeBlock, {
		code: rawCode,
		rawCode,
		loading,
		// In production `loading` (block-level) is `messageLoading &&
		// !token.isClosed` (see MarkdownBlock.svelte): `loading: true` always
		// implies the message itself was live too. Default it the same way
		// here so existing callers that only set `loading` keep working;
		// `...props` still lets a test override it explicitly (see the
		// "arrives already closed" case below).
		messageLoading: loading,
		language: "python",
		autorun: false,
		...props,
	});
	return {
		screen,
		runButton: () => screen.getByTitle("Run this code here in your browser"),
	};
};

// The pending queue is file-global: a run a test leaves unsettled would be
// the one a later test's settleNext settles, hanging that test instead of
// this one. Fail at the leaking test, with the queue emptied for the next.
afterEach(() => {
	const leaked = sessionMock.drain();
	expect(leaked, "a test left runs unsettled in the shared session mock").toBe(0);
});

beforeEach(() => {
	sessionMock.run.mockClear();
	sessionMock.listFiles.mockClear();
	sessionMock.readFile.mockClear();
	// sidePane is a module singleton: a preview left open by one test would
	// leak into the next one's assertions.
	sidePane.reset();
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

	it("auto-runs a fence that arrives already closed in the final update — no streamed tokens, only the message-level generating flag was ever true", async () => {
		// glm-5.3-flash (and other models) sometimes emit the whole visible
		// answer, fence included, in one final chunk: MarkdownBlock computes
		// this block's own `loading` as `loading && !token.isClosed`, and an
		// already-closed fence makes that false from this component's very
		// first render — `loading` alone can never mark it as seen streaming.
		// `messageLoading` is the raw, uncombined signal (the message this
		// fence belongs to is the one this tab is generating) and must still
		// mark it.
		const { screen } = mount({
			rawCode: "print('whole')",
			autorun: true,
			loading: false,
			messageLoading: true,
		});
		await vi.waitFor(() => expect(sessionMock.run).toHaveBeenCalledWith("print('whole')"));

		// The turn settling afterwards must not run it again.
		await screen.rerender({ messageLoading: false });
		await tick();
		expect(sessionMock.run).toHaveBeenCalledTimes(1);

		sessionMock.settleNext(outcome({ stdout: "whole\n" }));
		await tick();
	});

	it("never auto-runs fences that did not stream (history reloads stay inert)", async () => {
		const { screen } = mount({ rawCode: "print('c')", autorun: true, loading: false });
		await screen.rerender({});
		await tick();
		expect(sessionMock.run).not.toHaveBeenCalled();
	});

	it("survives a remount at settle: the block that streamed in is destroyed before loading flips false (MarkdownRenderer's stream-key swap), and a fresh instance for the same runKey still auto-runs, exactly once", async () => {
		const rawCode = "print('remount')";
		// The streaming instance: never itself sees `loading: false` — it is
		// torn down first, exactly as the each-key swap does at settle.
		const streaming = mount({ rawCode, autorun: true, loading: true });
		await tick();
		expect(sessionMock.run).not.toHaveBeenCalled();
		streaming.screen.unmount();

		// The settled instance: a brand-new component, mounted straight into
		// `loading: false` — its own local state has no memory of streaming.
		const { screen } = mount({ rawCode, autorun: true, loading: false });
		await vi.waitFor(() => expect(sessionMock.run).toHaveBeenCalledTimes(1));
		expect(sessionMock.run).toHaveBeenCalledWith(rawCode);

		// A second remount for the very same runKey (a scroll, a re-render)
		// must not run it again.
		screen.unmount();
		mount({ rawCode, autorun: true, loading: false });
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(sessionMock.run).toHaveBeenCalledTimes(1);

		// Drain the one real run: the pending queue is shared within this
		// file, and an unsettled entry would be consumed by a later test's
		// settle (see the explicit-Run-button test's own note on this).
		sessionMock.settleNext(outcome({ stdout: "" }));
		await tick();
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
		expect(text).toContain("The code failed");
		expect(text).toContain("did not finish within 20 s");
	});

	it("re-runs on the explicit Run button even after a settled outcome", async () => {
		const { runButton } = mount({ rawCode: "print('g')" });
		await tick();
		// A DOM click, not a pointer-driven locator click: the contract here
		// is "an enabled Run button re-runs", not hit-testing. A locator click
		// round-trips through the Vitest server and Playwright's actionability
		// polling, which stalls for seconds (once past the 15 s test timeout)
		// in a full client run, where ~100 files share one busy Node process
		// and three Chromium sessions on few cores. Nothing about this test
		// depends on those hops.
		(runButton().element() as HTMLButtonElement).click();
		await vi.waitFor(() => expect(sessionMock.run).toHaveBeenCalledTimes(1));
		sessionMock.settleNext(outcome({ stdout: "a" }));
		await vi.waitFor(() => expect(runButton().elements()[0]).toBeEnabled());
		(runButton().element() as HTMLButtonElement).click();
		await vi.waitFor(() => expect(sessionMock.run).toHaveBeenCalledTimes(2));
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

	it("draws the fence's run as ONE surface: status, code fold and file rows, no frames inside frames", async () => {
		sessionMock.listFiles.mockResolvedValueOnce([{ path: "/home/pyodide/out.txt", size: 3 }]);
		const { screen } = mount({ rawCode: "print('j')", autorun: true, loading: true });
		await screen.rerender({ loading: false });
		await vi.waitFor(() => expect(sessionMock.run).toHaveBeenCalledTimes(1));
		sessionMock.settleNext(outcome({ stdout: "out\n" }));
		await vi.waitFor(() => expect(screen.baseElement.textContent ?? "").toContain("Finished"));
		await expect.element(screen.getByRole("button", { name: "Download out.txt" })).toBeVisible();

		const surface = screen.baseElement.querySelector('[data-testid="run-output"]') as HTMLElement;
		const details = surface.querySelector("details") as HTMLElement;
		const files = surface.querySelector('[data-testid="run-files"]') as HTMLElement;
		expect(details).not.toBeNull();
		expect(details.hasAttribute("open")).toBe(false);
		expect(files).not.toBeNull();
		expect(screen.baseElement.textContent).toContain("View code · 1 file");
		// The fold carries no frame of its own, and nothing inside the surface is a bordered card.
		expect(getComputedStyle(details).borderTopWidth).toBe("0px");
		expect(surface.querySelectorAll('[data-testid="file-artifact-card"]').length).toBe(1);
		const card = surface.querySelector('[data-testid="file-artifact-card"]') as HTMLElement;
		expect(getComputedStyle(card).borderTopWidth).toBe("0px");
		// The surface spans the block's own column, like the "Ran code" card:
		// same left edge, same width, no inset.
		const block = screen.baseElement.querySelector(".group.relative") as HTMLElement;
		expect(
			Math.abs(surface.getBoundingClientRect().left - block.getBoundingClientRect().left)
		).toBeLessThan(1);
		expect(
			Math.abs(surface.getBoundingClientRect().right - block.getBoundingClientRect().right)
		).toBeLessThan(1);
		// File rows sit inside the surface, rows are li's of one list.
		expect(surface.contains(files)).toBe(true);
		for (const child of Array.from(files.children)) expect(child.tagName).toBe("LI");
		// The button cluster sits inside the surface's header row.
		const cluster = screen.baseElement.querySelector(".group.relative div.pointer-events-auto");
		const clusterRect = (cluster as HTMLElement).getBoundingClientRect();
		const surfaceRect = surface.getBoundingClientRect();
		expect(clusterRect.right).toBeLessThanOrEqual(surfaceRect.right);
		expect(clusterRect.top).toBeGreaterThanOrEqual(surfaceRect.top);
		expect(clusterRect.bottom).toBeLessThan(files.getBoundingClientRect().top);
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

describe("CodeBlock with code execution disabled (the agent transcript)", () => {
	/** Mount under the agent view's no-execution flag (see AgentView/SubagentCard). */
	function mountDisabled(rawCode: string, extra: Record<string, unknown> = {}) {
		return render(CodeBlock, {
			props: {
				code: rawCode,
				rawCode,
				loading: true,
				// See the `mount` helper above for why this mirrors `loading`.
				messageLoading: true,
				language: "python",
				autorun: true,
				...extra,
			},
			context: new Map<unknown, unknown>([[CODE_EXECUTION_DISABLED, true]]),
			// Same cast renderWithApp uses: the props-with-context form is valid,
			// the helper's generic just cannot see it.
		} as never);
	}

	it("never auto-runs a streamed python fence and offers no Run button", async () => {
		const rawCode = "print('agent-disabled')";
		const screen = mountDisabled(rawCode);
		await tick();
		expect(sessionMock.run).not.toHaveBeenCalledWith(rawCode);

		// The fence streams in and closes: `loading` flips false exactly as in
		// the auto-run test above — and still nothing executes.
		await screen.rerender({ loading: false, messageLoading: false });
		await tick();
		// Give a would-be auto-run every chance to fire.
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(sessionMock.run).not.toHaveBeenCalledWith(rawCode);
		expect(screen.baseElement.querySelector('button[aria-label="Run code"]')).toBeNull();
		// Still a readable, copyable block — highlighted code plus Copy, exactly
		// like a non-Python fence.
		expect(screen.baseElement.querySelector("pre")).not.toBeNull();
		expect(screen.baseElement.querySelector('button[title="Copy to clipboard"]')).not.toBeNull();
	});

	// Booting the markdown worker (marked, KaTeX, highlight.js) is a one-off cost that took
	// 3 to 5 s on a loaded CPU, the same order as the render waits below. Wait for the worker
	// itself, so those waits measure rendering, not the cold start.
	beforeAll(() => markdownPoolReady(), 60_000);

	it("an assistant message in the agent view with a python fence never runs", async () => {
		const rawCode = "print('agent-chat-disabled')";
		const content = `Here is the edit:\n\n\`\`\`python\n${rawCode}\n\`\`\`\n`;
		const screen = render(ChatMessage, {
			props: {
				message: { id: "m-agent-1", from: "assistant", content, children: [], updates: [] },
				loading: true,
				isLast: true,
				isAuthor: true,
				readOnly: true,
			},
			context: new Map<unknown, unknown>([[CODE_EXECUTION_DISABLED, true]]),
		} as never);
		await tick();
		// The fence renders through the markdown pipeline…
		await vi.waitFor(() => expect(screen.baseElement.querySelector("pre")).not.toBeNull(), {
			timeout: 5000,
		});
		// …the turn settles, the fence closes — and nothing executes.
		await screen.rerender({ loading: false });
		await tick();
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(sessionMock.run).not.toHaveBeenCalledWith(rawCode);
		expect(screen.baseElement.querySelector('button[aria-label="Run code"]')).toBeNull();
	});

	it("the same fence without the flag still auto-runs (chat is unchanged)", async () => {
		const rawCode = "print('agent-control')";
		const content = `Here is the edit:\n\n\`\`\`python\n${rawCode}\n\`\`\`\n`;
		const screen = render(ChatMessage, {
			message: { id: "m-agent-2", from: "assistant", content, children: [], updates: [] },
			loading: true,
			isLast: true,
			isAuthor: true,
			readOnly: true,
		} as never);
		await tick();
		await vi.waitFor(() => expect(screen.baseElement.querySelector("pre")).not.toBeNull(), {
			timeout: 5000,
		});
		await screen.rerender({ loading: false });
		await vi.waitFor(() => expect(sessionMock.run).toHaveBeenCalledWith(rawCode), {
			timeout: 5000,
		});
		// Drain the run: the pending queue is shared within this file.
		sessionMock.settleNext(outcome({ stdout: "" }));
		await tick();
	});
});

describe("CodeBlock direct-emission file blocks", () => {
	const content = "# Report\n\nAll quiet.";

	/** Captures the header's download without triggering a real browser download. */
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

	it("renders a closed titled fence inline: filename header plus the same code body", async () => {
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
		// Convergence: the titled fence keeps the code body (highlighted) and
		// the shared button cluster — no separate file-card chrome.
		expect(screen.baseElement.querySelector("pre")).not.toBeNull();
		expect(screen.baseElement.querySelector('button[aria-label^="Preview"]')).toBeNull();
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

	it("opens a titled html fence in the side panel instead of a text preview", async () => {
		sidePane.reset();
		const { screen } = mount({
			rawCode: "<!DOCTYPE html><html><body><h1>Hi</h1></body></html>",
			language: "html title=index.html",
			autorun: true,
		});
		await tick();
		await expect.element(screen.getByText("index.html")).toBeVisible();
		await screen.getByRole("button", { name: "Preview HTML" }).click();
		await tick();
		// The panel — not a modal, not an inline text box — owns the render.
		expect(sidePane.open).toBe(true);
		expect(sidePane.view).toBe("preview");
		expect(sidePane.preview).toMatchObject({ kind: "html", title: "index.html" });
		expect(sidePane.preview?.content).toContain("<h1>Hi</h1>");
		sidePane.reset();
	});

	it("opens a mermaid fence in the side panel as a diagram", async () => {
		sidePane.reset();
		const { screen } = mount({
			rawCode: "flowchart LR\n    A --> B",
			language: "mermaid",
			autorun: true,
		});
		await tick();
		await screen.getByRole("button", { name: "Preview diagram" }).click();
		await tick();
		expect(sidePane.open).toBe(true);
		expect(sidePane.view).toBe("preview");
		expect(sidePane.preview).toMatchObject({ kind: "mermaid", title: "Preview" });
		sidePane.reset();
	});

	it("opens an untitled html fence in the side panel, never a modal", async () => {
		sidePane.reset();
		const { screen } = mount({
			rawCode: "<!DOCTYPE html><html><body><h1>Hi</h1></body></html>",
			language: "html",
			autorun: true,
		});
		await tick();
		await screen.getByRole("button", { name: "Preview HTML" }).click();
		await tick();
		expect(sidePane.open).toBe(true);
		expect(sidePane.view).toBe("preview");
		// No fullscreen modal is mounted for fence previews anymore.
		expect(screen.baseElement.querySelector('[role="dialog"]')).toBeNull();
		sidePane.reset();
	});

	it("streams an unclosed titled fence as an ordinary code block, header only after close", async () => {
		const { screen } = mount({
			rawCode: content,
			language: "markdown title=report.md",
			autorun: true,
			loading: true,
		});
		await tick();
		// While streaming: the code fence renders, no filename header exists yet.
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

describe("CodeBlock keeps the files its run produced", () => {
	// sha256 of the bytes 1, 2, 3: the browser fingerprints what it reads.
	const SHA = "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81";
	type Seen = { url: string; body: unknown };

	function stubServer(seen: Seen[]) {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input);
				seen.push({
					url,
					body: init?.body instanceof FormData ? "form" : JSON.parse(String(init?.body ?? "{}")),
				});
				if (url.endsWith("/code-execution/output")) {
					return Response.json({ files: [{ name: "hello_world.docx", size: 3, sha256: SHA }] });
				}
				return Response.json({
					update: {
						type: "codeExecution",
						subtype: "outputs",
						runKey: "k",
						files: [{ name: "hello_world.docx", size: 3, sha256: SHA }],
					},
				});
			})
		);
	}

	const messageRun = (over: Partial<MessageRunContext> = {}): MessageRunContext => ({
		conversationId: "conv-1",
		messageId: "asst-1",
		canPersist: true,
		storedFiles: () => undefined,
		...over,
	});

	function mountWith(
		rawCode: string,
		context: MessageRunContext,
		props: Record<string, unknown> = {}
	) {
		const loading = (props.loading as boolean | undefined) ?? false;
		return render(CodeBlock, {
			props: {
				code: rawCode,
				rawCode,
				loading,
				// See the `mount` helper above for why this mirrors `loading`.
				messageLoading: loading,
				language: "python",
				autorun: false,
				...props,
			},
			context: new Map<unknown, unknown>([[MESSAGE_RUN_CONTEXT, context]]),
			// Same cast renderWithApp uses: the props-with-context form is valid,
			// the helper's generic just cannot see it.
		} as never);
	}

	async function runWithFile(rawCode: string, context: MessageRunContext) {
		sessionMock.listFiles.mockResolvedValueOnce([
			{ path: "/home/pyodide/hello_world.docx", size: 3 },
		]);
		const screen = mountWith(rawCode, context, { autorun: true, loading: true });
		await screen.rerender({ loading: false });
		await vi.waitFor(() => expect(sessionMock.run).toHaveBeenCalledTimes(1));
		sessionMock.settleNext(outcome({ stdout: "" }));
		return screen;
	}

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("uploads a settled run's files and records them on the message", async () => {
		const seen: Seen[] = [];
		stubServer(seen);

		await runWithFile("make_docx_1()", messageRun());

		await vi.waitFor(() => expect(seen).toHaveLength(2));
		expect(seen[0]).toEqual({ url: "/conversation/conv-1/code-execution/output", body: "form" });
		expect(seen[1].url).toBe("/conversation/conv-1/code-execution/run-files");
		expect(seen[1].body).toMatchObject({
			messageId: "asst-1",
			files: [{ name: "hello_world.docx", size: 3, sha256: SHA }],
		});
		expect((seen[1].body as { runKey: string }).runKey).toMatch(/^chat:/);
		await vi.waitFor(() => expect(runFiles.for("asst-1").length).toBeGreaterThan(0));
	});

	it("keeps nothing where the viewer may not write (a share, a read-only view)", async () => {
		const seen: Seen[] = [];
		stubServer(seen);

		await runWithFile("make_docx_2()", messageRun({ canPersist: false, messageId: "asst-2" }));

		// Give a would-be upload every chance to happen.
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(seen).toEqual([]);
	});

	it("uploads a settled run once, however often the block remounts", async () => {
		const seen: Seen[] = [];
		stubServer(seen);
		const context = messageRun({ messageId: "asst-3" });

		const first = await runWithFile("make_docx_3()", context);
		await vi.waitFor(() => expect(seen).toHaveLength(2));
		first.unmount();
		mountWith("make_docx_3()", context);

		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(seen).toHaveLength(2);
	});

	function stubServerWithRunFilesResponder(
		seen: Seen[],
		respond: (body: { messageId: string; runKey: string; files: { sha256: string }[] }) => Response
	) {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input);
				const body =
					init?.body instanceof FormData ? "form" : JSON.parse(String(init?.body ?? "{}"));
				seen.push({ url, body });
				if (url.endsWith("/code-execution/output")) {
					return Response.json({ files: [{ name: "hello_world.docx", size: 3, sha256: SHA }] });
				}
				return respond(body as { messageId: string; runKey: string; files: { sha256: string }[] });
			})
		);
	}

	it("retries a refused record under the same id (the save landed, no id change), and records it once", async () => {
		const seen: Seen[] = [];
		let calls = 0;
		stubServerWithRunFilesResponder(seen, () => {
			calls += 1;
			// The first attempt is refused (message not saved yet); a later
			// attempt under the same id must not be permanently blocked by it.
			if (calls === 1) return new Response(null, { status: 409 });
			return Response.json({
				update: {
					type: "codeExecution",
					subtype: "outputs",
					runKey: "k",
					files: [{ name: "hello_world.docx", size: 3, sha256: SHA }],
				},
			});
		});
		const context = messageRun({ messageId: "asst-retry" });

		const first = await runWithFile("make_docx_retry()", context);
		// The upload, the refused record, then the retried record, with no
		// remount and no id change needed to set it off.
		await vi.waitFor(() => expect(seen).toHaveLength(3), { timeout: 5000 });
		expect(seen[2].body).toMatchObject({ messageId: "asst-retry" });
		await vi.waitFor(() => expect(runFiles.for("asst-retry").length).toBe(1));
		first.unmount();

		// A remount afterwards sees the run already recorded: nothing new.
		mountWith("make_docx_retry()", context);
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(seen).toHaveLength(3);
		expect(runFiles.for("asst-retry").length).toBe(1);
	});

	it("records under the message id it has once the id changes, exactly once", async () => {
		// The race finding 1 fixes: an auto-run settles while this message
		// still carries the client-minted id (never saved on the conversation),
		// so the record is refused; the page then re-syncs and this message's
		// context carries the server's real id, and the same run's bytes are
		// recorded there instead.
		const seen: Seen[] = [];
		stubServerWithRunFilesResponder(seen, (body) =>
			body.messageId === "client-minted-id"
				? new Response(null, { status: 409 })
				: Response.json({
						update: {
							type: "codeExecution",
							subtype: "outputs",
							runKey: "k",
							files: [{ name: "hello_world.docx", size: 3, sha256: SHA }],
						},
					})
		);

		const first = await runWithFile(
			"make_docx_swap()",
			messageRun({ messageId: "client-minted-id" })
		);
		await vi.waitFor(() => expect(seen).toHaveLength(2));
		expect(seen[1].body).toMatchObject({ messageId: "client-minted-id" });
		first.unmount();

		mountWith("make_docx_swap()", messageRun({ messageId: "server-real-id" }));
		await vi.waitFor(() => expect(seen).toHaveLength(4));
		expect(seen[3].body).toMatchObject({ messageId: "server-real-id" });

		// One successful record, under the real id — never under the abandoned one.
		expect(runFiles.for("client-minted-id")).toEqual([]);
		await vi.waitFor(() => expect(runFiles.for("server-real-id").length).toBe(1));
	});

	it("shows a history block's stored file where the dead sandbox copy used to be", async () => {
		const screen = mountWith(
			"make_docx_4()",
			messageRun({
				storedFiles: () => [{ name: "hello_world.docx", size: 3, sha256: SHA }],
			})
		);

		await expect.element(screen.getByText(/View code/)).toBeVisible();
		await expect.element(screen.getByText("hello_world.docx")).toBeVisible();
		// It never ran here: nothing executed on page load.
		expect(sessionMock.run).not.toHaveBeenCalled();
	});
});
