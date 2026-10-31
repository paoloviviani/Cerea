import CodeExecutionCard from "./CodeExecutionCard.svelte";
import { render } from "vitest-browser-svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MessageUpdateType, MessageCodeExecutionUpdateType } from "$lib/types/MessageUpdate";
import { NO_OUTCOME_RECORDED } from "$lib/utils/execution/protocol";
import { setClientExecutionBackend } from "$lib/utils/execution/backend.svelte";

/**
 * A live `execute_code` card whose page goes to the background: the server is
 * told, the run restarts once on return, the result is posted once, the screen
 * wake lock follows the run, and the card says what happened.
 */
const session = vi.hoisted(() => ({
	run: vi.fn(),
	terminate: vi.fn(),
	listFiles: vi.fn(async () => []),
	readFile: vi.fn(),
	onStatus: vi.fn(),
}));
vi.mock("$lib/utils/execution/runtime", () => ({ getExecutionSession: () => session }));

const lock = vi.hoisted(() => ({ acquire: vi.fn(async () => undefined), release: vi.fn() }));
const paused = vi.hoisted(() => vi.fn());
vi.mock("$lib/utils/execution/pauseResume", async (importOriginal) => {
	const actual = await importOriginal<typeof import("$lib/utils/execution/pauseResume")>();
	return { ...actual, createWakeLock: () => lock, reportPaused: paused };
});

let visibility: "visible" | "hidden" = "visible";
function setVisibility(next: "visible" | "hidden") {
	visibility = next;
	document.dispatchEvent(new Event("visibilitychange"));
}

let n = 0;
const request = (code: string) => ({
	type: MessageUpdateType.CodeExecution,
	subtype: MessageCodeExecutionUpdateType.Request,
	executionId: `exec-${++n}`,
	code,
});
const mount = (req: ReturnType<typeof request>, resolved?: unknown) =>
	render(CodeExecutionCard, {
		props: { conversationId: "conv-1", request: req, ...(resolved ? { resolved } : {}) },
	} as never);

const posts = () =>
	(fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.filter(([url]) =>
		String(url).endsWith("/code-execution")
	);

beforeEach(() => {
	visibility = "visible";
	Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
	);
	for (const f of [session.run, session.terminate, lock.acquire, lock.release, paused])
		f.mockClear();
	setClientExecutionBackend("browser");
});

afterEach(() => {
	vi.unstubAllGlobals();
	sessionStorage.clear();
});

describe("CodeExecutionCard pause and resume", () => {
	it("restarts a pending run once on return, posts once, and says it resumed", async () => {
		const req = request("print('resume-case')");
		// The first run never answers (the page was frozen under it); the restart does.
		session.run
			.mockImplementationOnce(() => new Promise(() => undefined))
			.mockResolvedValueOnce({ ok: true, stdout: "resume-case\n", stderr: "" });
		const screen = mount(req);
		await vi.waitFor(() => expect(session.run).toHaveBeenCalledTimes(1));

		setVisibility("hidden");
		expect(paused).toHaveBeenCalledWith("conv-1", req.executionId);
		expect(posts()).toHaveLength(0);

		setVisibility("visible");
		// A second visibility signal (pageshow after visibilitychange) must not restart again.
		window.dispatchEvent(new Event("pageshow"));
		await vi.waitFor(() => expect(posts()).toHaveLength(1));
		expect(session.terminate).toHaveBeenCalledTimes(1);
		expect(session.run).toHaveBeenCalledTimes(2);
		expect(JSON.parse(posts()[0][1].body).executionId).toBe(req.executionId);
		await expect
			.element(screen.getByText("Paused while the page was in the background — resumed."))
			.toBeVisible();
	});

	it("does not post a sandbox failure that landed while the page was away", async () => {
		const req = request("print('late-timeout')");
		let fail: (e: Error) => void = () => undefined;
		session.run
			.mockImplementationOnce(() => new Promise((_, reject) => (fail = reject)))
			.mockResolvedValueOnce({ ok: true, stdout: "ok\n", stderr: "" });
		mount(req);
		await vi.waitFor(() => expect(session.run).toHaveBeenCalledTimes(1));
		setVisibility("hidden");
		// The timer that fired late on thaw, before the visibility event.
		fail(new Error("timed out"));
		await new Promise((r) => setTimeout(r, 50));
		expect(posts()).toHaveLength(0);
		setVisibility("visible");
		await vi.waitFor(() => expect(posts()).toHaveLength(1));
		expect(JSON.parse(posts()[0][1].body).outcome.ok).toBe(true);
	});

	it("takes the wake lock while running and releases it when the run ends", async () => {
		let finish: (v: unknown) => void = () => undefined;
		session.run.mockImplementationOnce(() => new Promise((r) => (finish = r)));
		mount(request("print('lock-case')"));
		await vi.waitFor(() => expect(lock.acquire).toHaveBeenCalled());
		expect(lock.release).not.toHaveBeenCalled();
		finish({ ok: true, stdout: "", stderr: "" });
		await vi.waitFor(() => expect(lock.release).toHaveBeenCalled());
	});

	it("releases the wake lock when the page hides and takes it again on return", async () => {
		session.run.mockImplementationOnce(() => new Promise(() => undefined));
		mount(request("print('lock-hide')"));
		await vi.waitFor(() => expect(lock.acquire).toHaveBeenCalledTimes(1));
		setVisibility("hidden");
		await vi.waitFor(() => expect(lock.release).toHaveBeenCalled());
		session.run.mockImplementationOnce(() => new Promise(() => undefined));
		setVisibility("visible");
		await vi.waitFor(() => expect(lock.acquire.mock.calls.length).toBeGreaterThan(1));
	});

	it("says to keep the page open once a run has taken a moment", async () => {
		session.run.mockImplementationOnce(() => new Promise(() => undefined));
		const screen = mount(request("print('hint-case')"));
		await vi.waitFor(() => expect(session.run).toHaveBeenCalled());
		expect(screen.baseElement.textContent).not.toContain("keep the page open");
		await expect
			.element(screen.getByText("Runs in this browser — keep the page open until it finishes."), {
				timeout: 4000,
			})
			.toBeVisible();
	});

	it("says it did not finish when the server had already given up", async () => {
		const req = request("print('missed-case')");
		session.run
			.mockImplementationOnce(() => new Promise(() => undefined))
			.mockResolvedValueOnce({ ok: true, stdout: "x", stderr: "" });
		(fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(
			async () => new Response("{}", { status: 409 })
		);
		const screen = mount(req);
		await vi.waitFor(() => expect(session.run).toHaveBeenCalledTimes(1));
		setVisibility("hidden");
		setVisibility("visible");
		await expect
			.element(screen.getByText("This did not finish because the page was in the background."))
			.toBeVisible();
	});

	it("a replayed card with no recorded outcome after a pause says it did not finish", async () => {
		const req = request("print('replay-missed')");
		sessionStorage.setItem(
			`cerea.codeRun.${req.executionId}`,
			JSON.stringify({ executionId: req.executionId })
		);
		const screen = mount(req, {
			type: MessageUpdateType.CodeExecution,
			subtype: MessageCodeExecutionUpdateType.Resolved,
			executionId: req.executionId,
			outcome: { ok: false, stdout: "", stderr: "", error: NO_OUTCOME_RECORDED },
		});
		await expect
			.element(screen.getByText("This did not finish because the page was in the background."))
			.toBeVisible();
	});

	it("does nothing browser-side when the deployment runs code elsewhere or not at all", async () => {
		setClientExecutionBackend("off");
		mount(request("print('off-case')"));
		await new Promise((r) => setTimeout(r, 100));
		expect(session.run).not.toHaveBeenCalled();
		expect(lock.acquire).not.toHaveBeenCalled();
		setVisibility("hidden");
		expect(paused).not.toHaveBeenCalled();
	});
});
