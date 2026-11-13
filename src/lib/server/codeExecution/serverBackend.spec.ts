import { beforeEach, describe, expect, it, vi } from "vitest";
import { ObjectId } from "mongodb";

vi.mock("$lib/server/logger", () => ({
	logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("$lib/server/database", () => ({ collections: {} }));
vi.mock("$lib/server/generation/codeExecution", () => ({ submitCodeExecutionResult: vi.fn() }));
vi.mock("$lib/server/generation/parkedSweeper", () => ({ sweepParkedCalls: vi.fn() }));
vi.mock("$lib/server/execution/deliverables", () => ({ storeDeliverable: vi.fn() }));
vi.mock("$lib/server/sandbox/boot", () => ({ sandboxSettings: () => ({ config: null }) }));
vi.mock("./sandboxStage", () => ({ attachmentsToStage: vi.fn() }));
vi.mock("./sandboxHealth", () => ({
	probeSandboxHealth: vi.fn(),
	sandboxHealthyNow: vi.fn(async () => true),
	sandboxUsable: () => true,
}));

import type { ExecutionBackend } from "./backend";
import {
	ServerSandboxUnavailable,
	buildOutcome,
	createServerBackend,
	fallbackNotice,
	type ServerBackendDeps,
} from "./serverBackend";
import { SandboxUnavailable, type SandboxSessions } from "./sandboxSessions";

const conversationId = new ObjectId();
const userId = new ObjectId();
const request = {
	call: {
		conversationId,
		messageId: "m1",
		toolCallId: "tc",
		toolUuid: "tu",
		userId,
	},
	code: "print(1)",
	limits: { runTimeoutMs: 60_000, deadlineMs: 120_000 },
};

function setup(over: Partial<ServerBackendDeps> = {}, sessionOver: Record<string, unknown> = {}) {
	const sessions = {
		prepare: vi.fn(async () => undefined),
		run: vi.fn(async (_request?: unknown) => ({
			reply: {
				ok: true,
				stdout: "1\n",
				stderr: "",
				result: "1",
				error: null,
				files: [{ path: "/mnt/output/a.png", size: 3 }],
				timeout: null,
			},
			outputs: [{ name: "a.png", bytes: new Uint8Array([1, 2, 3]) }],
			skipped: [],
		})),
		...sessionOver,
	};
	const fallback = {
		kind: "browser",
		startRun: vi.fn(async () => ({ executionId: "browser-run", expiresAt: new Date(0) })),
		pause: vi.fn(async () => ({ ok: true as const, resumeAt: new Date(0) })),
		resolve: vi.fn(async () => ({ ok: true as const, resume: true })),
	} as unknown as ExecutionBackend;
	const deps: ServerBackendDeps = {
		sessions: () => sessions as unknown as SandboxSessions,
		healthy: async () => true,
		stageFiles: vi.fn(async () => []),
		store: vi.fn(async ({ name, bytes }) => ({
			ok: true as const,
			ref: { name, size: bytes.byteLength, sha256: "a".repeat(64) },
		})) as never,
		submit: vi.fn(async () => ({ ok: true as const, resume: true })),
		kick: vi.fn(),
		fallback,
		park: vi.fn(async () => ({ executionId: "exec-1", expiresAt: new Date(1000) })),
		...over,
	};
	return { backend: createServerBackend(deps), deps, sessions, fallback };
}

const settle = () => new Promise((r) => setTimeout(r, 10));

describe("the server backend", () => {
	let emitted: unknown[];
	const emit = (u: unknown) => void emitted.push(u);
	beforeEach(() => {
		emitted = [];
	});

	it("parks the turn, tells the page it is a server run, and posts the outcome itself", async () => {
		const { backend, deps, sessions } = setup();
		const started = await backend.startRun(request, emit as never);
		expect(started.executionId).toBe("exec-1");
		expect(emitted).toEqual([
			expect.objectContaining({
				subtype: "request",
				executionId: "exec-1",
				code: "print(1)",
				runner: "server",
			}),
		]);
		await settle();
		expect(sessions.prepare).toHaveBeenCalledTimes(1);
		expect(sessions.run).toHaveBeenCalledTimes(1);
		const arg = vi.mocked(deps.submit).mock.calls[0][0];
		expect(arg).toMatchObject({ executionId: "exec-1", conversationId });
		expect(arg.outcome).toMatchObject({ ok: true, stdout: "1\n", result: "1", engine: "server" });
		expect(arg.outcome.fileRefs).toEqual([
			{ name: "a.png", size: 3, sha256: "a".repeat(64), uploaded: true },
		]);
		expect(deps.kick).toHaveBeenCalledTimes(1);
		// The same limits as the browser's: the run's own, in seconds.
		expect(vi.mocked(sessions.run).mock.calls[0][0]).toMatchObject({
			timeoutSeconds: 60,
			owner: userId.toString(),
		});
	});

	it("falls back to the browser, loudly, when sandboxes are off or the manager is unhealthy", async () => {
		const off = setup({ sessions: () => null });
		await off.backend.startRun(request, emit as never);
		expect(off.fallback.startRun).toHaveBeenCalledTimes(1);
		const sick = setup({ healthy: async () => false });
		await sick.backend.startRun(request, emit as never);
		expect(sick.fallback.startRun).toHaveBeenCalledTimes(1);
		expect(sick.sessions.run).not.toHaveBeenCalled();
		expect(sick.deps.park).not.toHaveBeenCalled();
	});

	it("falls back when a lease cannot be got, before anything is committed", async () => {
		const { backend, fallback, deps } = setup(
			{},
			{
				prepare: vi.fn(async () => {
					throw new SandboxUnavailable("full", "quota_exceeded");
				}),
			}
		);
		const started = await backend.startRun(request, emit as never);
		expect(started.executionId).toBe("browser-run");
		expect(fallback.startRun).toHaveBeenCalledTimes(1);
		expect(deps.park).not.toHaveBeenCalled();
		expect(emitted).toEqual([]);
	});

	it("tells the model, with the result, that a fallback call ran in the browser and why", async () => {
		const { backend, fallback } = setup(
			{},
			{
				prepare: vi.fn(async () => {
					throw new SandboxUnavailable("full", "quota_exceeded");
				}),
			}
		);
		await backend.startRun(request, emit as never);
		const passed = vi.mocked(fallback.startRun).mock.calls[0][0];
		expect(passed.notice).toBe(fallbackNotice("quota_exceeded"));
		expect(passed.notice).toContain("busy");
		expect(passed.notice).toContain("browser");
	});

	it("fails fast, never handing a scheduled run to a browser nobody has open", async () => {
		const sick = setup({ healthy: async () => false });
		await expect(
			sick.backend.startRun({ ...request, unattended: true }, emit as never)
		).rejects.toBeInstanceOf(ServerSandboxUnavailable);
		expect(sick.fallback.startRun).not.toHaveBeenCalled();
		const noLease = setup(
			{},
			{
				prepare: vi.fn(async () => {
					throw new SandboxUnavailable("full", "quota_exceeded");
				}),
			}
		);
		await expect(
			noLease.backend.startRun({ ...request, unattended: true }, emit as never)
		).rejects.toBeInstanceOf(ServerSandboxUnavailable);
	});

	it("marks the parked row as the server's, so a browser's post for it is refused", async () => {
		const { backend, deps } = setup();
		await backend.startRun(request, emit as never);
		expect(vi.mocked(deps.park).mock.calls[0][2]).toBe("server");
	});

	it("reports a run that fails after it was committed as the run's error, not a fallback", async () => {
		const { backend, deps, fallback } = setup(
			{},
			{
				run: vi.fn(async () => {
					throw new SandboxUnavailable("manager went away", "unreachable");
				}),
			}
		);
		await backend.startRun(request, emit as never);
		await settle();
		expect(fallback.startRun).not.toHaveBeenCalled();
		const outcome = vi.mocked(deps.submit).mock.calls[0][0].outcome;
		expect(outcome.ok).toBe(false);
		expect(outcome.error).toContain("manager went away");
		expect(outcome.engine).toBe("server");
	});

	it("does not wake a turn that already gave up", async () => {
		const { backend, deps } = setup({
			submit: vi.fn(async () => ({ ok: false as const, status: 409 as const, error: "late" })),
		});
		await backend.startRun(request, emit as never);
		await settle();
		expect(deps.kick).not.toHaveBeenCalled();
	});

	it("leaves pause and resolve to the browser path (a fallback answers through them)", async () => {
		const { backend, fallback } = setup();
		await backend.pause(conversationId, "e");
		await backend.resolve(conversationId, "e", { ok: true, stdout: "", stderr: "", files: [] });
		expect(fallback.pause).toHaveBeenCalledTimes(1);
		expect(fallback.resolve).toHaveBeenCalledTimes(1);
		expect(backend.supportsUnattended).toBe(true);
		expect(backend.supportsPause).toBe(false);
	});
});

describe("the outcome of a server run", () => {
	it("records a file that could not be stored as produced but not kept", async () => {
		const outcome = await buildOutcome(
			{
				store: vi.fn(async () => ({
					ok: false as const,
					status: 413 as const,
					error: "too many files",
				})) as never,
			},
			request,
			{
				reply: { ok: true, stdout: "", stderr: "", files: [] },
				outputs: [{ name: "x.xlsx", bytes: new Uint8Array([1]) }],
				skipped: [{ name: "big.bin", reason: "larger than 8 MB" }],
				notice: "The server sandbox was restarted",
			}
		);
		expect(outcome.fileRefs?.[0]).toMatchObject({ name: "x.xlsx", uploaded: false });
		expect(outcome.fileRefs?.[0].sha256).toMatch(/^[0-9a-f]{64}$/);
		expect(outcome.notice).toContain("restarted");
		expect(outcome.notice).toContain("x.xlsx could not be saved");
		expect(outcome.notice).toContain("big.bin was not kept");
	});

	it("caps the output-file notes at twenty and counts the rest", async () => {
		const outcome = await buildOutcome({ store: vi.fn() as never }, request, {
			reply: { ok: true, stdout: "", stderr: "", files: [] },
			outputs: [],
			skipped: Array.from({ length: 30 }, (_, i) => ({ name: `f${i}.bin`, reason: "too big" })),
		});
		const text = outcome.notice ?? "";
		expect(text.match(/was not kept/g)).toHaveLength(20);
		expect(text).toContain("and 10 more");
	});

	it("carries a timeout the way the browser's outcome does", async () => {
		const outcome = await buildOutcome({ store: vi.fn() as never }, request, {
			reply: {
				ok: false,
				stdout: "",
				stderr: "",
				error: "stopped",
				files: [],
				timeout: { seconds: 60, mountedFiles: ["/mnt/data/a.csv"] },
			},
			outputs: [],
			skipped: [],
		});
		expect(outcome.timeout).toEqual({ seconds: 60, mountedFiles: ["/mnt/data/a.csv"] });
		expect(outcome.ok).toBe(false);
	});
});
