import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AttachmentMounter } from "./attachmentMounter";
import { ExecutionSession, type ExecutionWorkerLike } from "./runtime";
import type { HostToWorker, WorkerToHost } from "./protocol";

/**
 * The sequence from the field: a conversation's attachments are mounted, a run
 * hits the time limit and the worker is killed, and the next run must find the
 * same files under the same names, with nothing fetched or mounted a second
 * time by the page. The session is real, the worker a fake that behaves like
 * the real one: a fresh worker starts with an empty /mnt/data and processes
 * messages in the order it receives them.
 */
class FakeWorker implements ExecutionWorkerLike {
	fs = new Map<string, string>();
	log: string[] = [];
	#listeners: Array<(event: MessageEvent<WorkerToHost>) => void> = [];
	addEventListener(type: "message" | "error", listener: unknown): void {
		if (type === "message") {
			this.#listeners.push(listener as (event: MessageEvent<WorkerToHost>) => void);
		}
	}
	terminate(): void {
		this.log.push("terminate");
	}
	postMessage(message: HostToWorker): void {
		const reply = (data: WorkerToHost) =>
			queueMicrotask(() => this.#listeners.forEach((l) => l({ data } as MessageEvent)));
		if (message.type === "loadFiles") {
			const written = message.files.map((file) => {
				this.fs.set(`/mnt/data/${file.name}`, String(file.data));
				return `/mnt/data/${file.name}`;
			});
			this.log.push(`load ${message.files.map((f) => f.name).join(",")}`);
			reply({ type: "filesLoaded", id: message.id, written });
		}
		if (message.type === "run") {
			// The run reports which files it could see when it started.
			this.log.push(`run sees ${[...this.fs.keys()].sort().join(",") || "nothing"}`);
			if (message.code === "hang") return;
			reply({
				type: "result",
				id: message.id,
				ok: true,
				stdout: [...this.fs.keys()].sort().join(","),
				stderr: "",
			});
		}
	}
}

const file = (value: string, name: string) => ({ type: "hash" as const, value, name });

describe("attachments across a sandbox restart", () => {
	let workers: FakeWorker[];
	beforeEach(() => {
		vi.useFakeTimers();
		workers = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async (url: string) =>
					new Response(`bytes of ${url}`, { headers: { "Content-Length": "20" } })
			)
		);
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	it("puts the same files back under the same names before the next run, without a new fetch", async () => {
		const session = new ExecutionSession({
			spawn: () => {
				const worker = new FakeWorker();
				workers.push(worker);
				return worker;
			},
			runTimeoutMs: 5_000,
			loadTimeoutMs: 5_000,
		});
		const mounter = new AttachmentMounter("c1", session, { mounted: vi.fn(), skipped: vi.fn() });
		const attachments = [file("h1", "sales.xlsx"), file("h2", "notes.docx")];

		await mounter.sync(attachments);
		const first = await session.run("print(1)");
		expect(first.stdout).toBe("/mnt/data/notes.docx,/mnt/data/sales.xlsx");
		const fetched = vi.mocked(fetch).mock.calls.length;

		// The run that never finishes: the worker is killed.
		const hung = session.run("hang").catch((e: unknown) => e as { timeout?: unknown });
		await vi.advanceTimersByTimeAsync(5_001);
		expect(await hung).toMatchObject({
			kind: "timeout",
			timeout: { seconds: 5, mountedFiles: ["/mnt/data/sales.xlsx", "/mnt/data/notes.docx"] },
		});

		// The page asks again before the next run: nothing new to mount...
		expect(mounter.needsSync(attachments)).toBe(false);
		// ...and the next run still sees both files, restored by the session.
		const next = await session.run("print(2)");
		expect(next.stdout).toBe("/mnt/data/notes.docx,/mnt/data/sales.xlsx");
		expect(workers).toHaveLength(2);
		expect(workers[1]?.log).toEqual([
			"load sales.xlsx",
			"load notes.docx",
			"run sees /mnt/data/notes.docx,/mnt/data/sales.xlsx",
		]);
		expect(vi.mocked(fetch).mock.calls.length).toBe(fetched);
	});

	it("does not duplicate a re-attached file after the restart", async () => {
		const session = new ExecutionSession({
			spawn: () => {
				const worker = new FakeWorker();
				workers.push(worker);
				return worker;
			},
		});
		const mounter = new AttachmentMounter("c1", session, { mounted: vi.fn(), skipped: vi.fn() });
		await mounter.sync([file("h1", "sales.xlsx")]);
		session.terminate();
		// The same file attached again in a later message: same content, one mount.
		await mounter.sync([file("h1", "sales.xlsx"), file("h1", "sales.xlsx")]);
		const out = await session.run("print(1)");
		expect(out.stdout).toBe("/mnt/data/sales.xlsx");
	});
});
