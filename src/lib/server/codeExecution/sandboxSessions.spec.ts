import { describe, expect, it, vi } from "vitest";
import { SandboxError } from "$lib/server/sandbox/client";
import {
	MAX_OUTPUT_FILES_PER_RUN,
	SANDBOX_RESTARTED_NOTICE,
	SandboxSessions,
	SandboxUnavailable,
	parseReply,
	type SandboxApi,
	type StageFile,
} from "./sandboxSessions";

const reply = (over: Record<string, unknown> = {}) => ({
	ok: true,
	stdout: "",
	stderr: "",
	result: null,
	error: null,
	files: [],
	timeout: null,
	...over,
});
const execResult = (r: unknown) => ({
	exit_code: 0,
	stdout: JSON.stringify(r) + "\n",
	stderr: "",
	truncated: false,
	timed_out: false,
});

/** A manager in memory: leases, files, and a scripted daemon. */
function fake() {
	const state = {
		leases: new Set<string>(),
		next: 0,
		files: new Map<string, Uint8Array>(),
		replies: [] as unknown[],
		execs: [] as Array<{ lease: string; stdin: string; cmd: string[] }>,
		running: 0,
		maxRunning: 0,
	};
	const api = {
		lease: vi.fn(async (req: { owner: string }) => {
			const id = `lease-${++state.next}`;
			state.leases.add(id);
			return { id, kind: "exec", owner: req.owner, state: "ready" };
		}),
		status: vi.fn(async (id: string) => {
			if (!state.leases.has(id)) throw new SandboxError(404, "no_such_lease", "no such lease");
			return { id, kind: "exec", owner: "o", state: "ready" };
		}),
		release: vi.fn(async (id: string) => void state.leases.delete(id)),
		putFile: vi.fn(async (id: string, path: string, data: Uint8Array) => {
			state.files.set(`${id}/${path}`, data);
		}),
		getFile: vi.fn(async (id: string, path: string) => {
			const f = state.files.get(`${id}/${path}`);
			if (!f) throw new SandboxError(404, "no_such_file", "no such file");
			return f;
		}),
		exec: vi.fn(async (id: string, req: { stdin?: string; cmd?: string[] }, _owner?: string) => {
			if (!state.leases.has(id)) throw new SandboxError(404, "no_such_lease", "no such lease");
			state.running += 1;
			state.maxRunning = Math.max(state.maxRunning, state.running);
			state.execs.push({ lease: id, stdin: req.stdin ?? "", cmd: req.cmd ?? [] });
			await new Promise((r) => setTimeout(r, 5));
			state.running -= 1;
			return execResult(state.replies.shift() ?? reply());
		}),
	};
	return { state, api, sessions: new SandboxSessions(api as unknown as SandboxApi) };
}

const base = {
	conversationId: "c1",
	owner: "u1",
	code: "1+1",
	timeoutSeconds: 60,
	figuresSource: "FIG",
	files: [] as StageFile[],
};
const file = (name: string, identity: string, bytes = [1]): StageFile => ({
	name,
	identity,
	load: async () => new Uint8Array(bytes),
});

describe("SandboxSessions", () => {
	it("leases once per conversation, runs the daemon client, and reuses the lease", async () => {
		const { api, sessions, state } = fake();
		const first = await sessions.run(base);
		await sessions.run({ ...base, code: "2+2" });
		expect(api.lease).toHaveBeenCalledTimes(1);
		expect(api.lease).toHaveBeenCalledWith({ kind: "exec", owner: "u1", conversation: "c1" });
		expect(first.notice).toBeUndefined();
		expect(state.execs[0].cmd).toEqual(["python", "/opt/execd/run.py"]);
		expect(JSON.parse(state.execs[0].stdin)).toEqual({ code: "1+1", timeout: 60, figures: "FIG" });
		expect(JSON.parse(state.execs[1].stdin).code).toBe("2+2");
		// Every call names its owner.
		expect(api.exec.mock.calls.every((c) => c[2] === "u1")).toBe(true);
	});

	it("keeps separate conversations in separate sandboxes", async () => {
		const { api, sessions } = fake();
		await sessions.run(base);
		await sessions.run({ ...base, conversationId: "c2" });
		expect(api.lease).toHaveBeenCalledTimes(2);
	});

	it("stages an attachment once, and again when its content changes", async () => {
		const { api, sessions, state } = fake();
		await sessions.run({ ...base, files: [file("a.csv", "hash:1", [1, 2])] });
		await sessions.run({ ...base, files: [file("a.csv", "hash:1", [1, 2])] });
		expect(api.putFile).toHaveBeenCalledTimes(1);
		expect(state.files.get("lease-1/data/a.csv")).toEqual(new Uint8Array([1, 2]));
		await sessions.run({ ...base, files: [file("a.csv", "hash:2", [9])] });
		expect(api.putFile).toHaveBeenCalledTimes(2);
		expect(state.files.get("lease-1/data/a.csv")).toEqual(new Uint8Array([9]));
	});

	it("leaves out a file that cannot be read (withheld) and still runs", async () => {
		const { api, sessions } = fake();
		const withheld: StageFile = {
			name: "secret.pdf",
			identity: "hash:x",
			load: async () => {
				throw new Error("withheld by the privacy rule");
			},
		};
		const result = await sessions.run({ ...base, files: [withheld, file("ok.txt", "hash:y")] });
		expect(result.reply.ok).toBe(true);
		expect(api.putFile).toHaveBeenCalledTimes(1);
		expect(api.putFile.mock.calls[0][1]).toBe("data/ok.txt");
	});

	it("recreates a lost lease, restages, and tells the model its state is gone", async () => {
		const { api, sessions, state } = fake();
		await sessions.run({ ...base, files: [file("a.csv", "hash:1")] });
		state.leases.clear(); // reaped by the manager's idle timeout
		const result = await sessions.run({ ...base, files: [file("a.csv", "hash:1")] });
		expect(api.lease).toHaveBeenCalledTimes(2);
		expect(api.putFile).toHaveBeenCalledTimes(2);
		expect(result.notice).toBe(SANDBOX_RESTARTED_NOTICE);
		// ...and only that call is told: the next one has a stable sandbox.
		expect((await sessions.run(base)).notice).toBeUndefined();
	});

	it("starts over once when the lease vanishes between the check and the call", async () => {
		const { api, sessions, state } = fake();
		await sessions.run(base);
		api.status.mockImplementationOnce(async (id: string) => ({ id }) as never); // the check passes
		state.leases.clear();
		const result = await sessions.run(base);
		expect(result.notice).toBe(SANDBOX_RESTARTED_NOTICE);
		expect(api.lease).toHaveBeenCalledTimes(2);
	});

	it("is unavailable, for the browser fallback, when the manager refuses a lease", async () => {
		const { api, sessions } = fake();
		api.lease.mockRejectedValueOnce(new SandboxError(429, "quota_exceeded", "full"));
		await expect(sessions.run(base)).rejects.toBeInstanceOf(SandboxUnavailable);
		api.lease.mockRejectedValueOnce(new SandboxError(0, "unreachable", "down"));
		await expect(sessions.prepare(base)).rejects.toMatchObject({ code: "unreachable" });
	});

	it("runs one call at a time per conversation", async () => {
		const { sessions, state } = fake();
		await Promise.all([sessions.run(base), sessions.run(base), sessions.run(base)]);
		expect(state.maxRunning).toBe(1);
		expect(state.execs).toHaveLength(3);
	});

	it("brings back the files the code wrote, bounded", async () => {
		const { sessions, state } = fake();
		await sessions.run(base); // lease-1
		state.files.set("lease-1/output/a.png", new Uint8Array([1]));
		state.files.set("lease-1/output/sub/b.csv", new Uint8Array([2]));
		state.replies.push(
			reply({
				files: [
					{ path: "/mnt/output/a.png", size: 1 },
					{ path: "/mnt/output/sub/b.csv", size: 1 },
					{ path: "/mnt/output/big.bin", size: 99 * 1024 * 1024 },
					{ path: "/mnt/output/gone.txt", size: 1 },
					{ path: "/etc/passwd", size: 1 },
				],
			})
		);
		const result = await sessions.run(base);
		expect(result.outputs.map((o) => o.name)).toEqual(["a.png", "sub/b.csv"]);
		expect(result.skipped.map((s) => s.name).sort()).toEqual(["big.bin", "gone.txt"]);
	});

	it("keeps at most the first twenty files of a run", async () => {
		const { sessions, state } = fake();
		await sessions.run(base);
		const listed = Array.from({ length: MAX_OUTPUT_FILES_PER_RUN + 5 }, (_, i) => {
			state.files.set(`lease-1/output/f${i}.txt`, new Uint8Array([i]));
			return { path: `/mnt/output/f${i}.txt`, size: 1 };
		});
		state.replies.push(reply({ files: listed }));
		const result = await sessions.run(base);
		expect(result.outputs).toHaveLength(MAX_OUTPUT_FILES_PER_RUN);
		expect(result.skipped).toHaveLength(5);
	});

	it("releases a conversation's sandbox on request", async () => {
		const { api, sessions } = fake();
		await sessions.run(base);
		await sessions.release("c1");
		expect(api.release).toHaveBeenCalledWith("lease-1", "u1");
		expect(sessions.has("c1")).toBe(false);
	});
});

describe("parseReply", () => {
	it("reads the daemon's last line", () => {
		const r = parseReply({
			...execResult(reply({ stdout: "hi\n", result: "3" })),
			stdout: "noise\n" + JSON.stringify(reply({ stdout: "hi\n", result: "3" })) + "\n",
		});
		expect(r).toMatchObject({ ok: true, stdout: "hi\n", result: "3" });
	});

	it("turns anything else into a failed run that says why", () => {
		expect(parseReply({ ...execResult({}), stdout: "not json", exit_code: 1 }).ok).toBe(false);
		const timed = parseReply({ ...execResult({}), stdout: "", timed_out: true });
		expect(timed.error).toContain("time limit");
	});
});
