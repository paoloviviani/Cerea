import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * A run's own output listing renders the instant the sandbox lists it, well
 * before `uploadRunFiles`/`recordRunFiles` even start — so a person who
 * reloads or navigates away right after seeing the file has no visual cue
 * that either call is still in flight. A plain `fetch` is aborted by that
 * navigation, silently losing the file for good (it never became a file
 * artifact, even though the run genuinely produced it). `keepalive` is what
 * lets these two calls survive the page-unload instead.
 */

const sessionMock = vi.hoisted(() => ({
	readFile: vi.fn(async (_path: string) => new ArrayBuffer(0)),
}));

vi.mock("$lib/utils/execution/runtime", () => ({
	getExecutionSession: () => sessionMock,
}));

vi.mock("$app/paths", () => ({ base: "" }));

import { uploadRunFiles, recordRunFiles, uploadAndDescribe, retryFileUpload } from "./runFiles";
import { cacheFileBytes, clearFileByteCache } from "./fileIdentity";

function jsonResponse(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

describe("uploadRunFiles: keepalive across a reload", () => {
	beforeEach(() => {
		sessionMock.readFile.mockReset();
		vi.stubGlobal("fetch", vi.fn());
	});

	it("keeps a small upload alive past an unload", async () => {
		sessionMock.readFile.mockResolvedValue(new ArrayBuffer(10));
		const fetchMock = vi.mocked(fetch);
		fetchMock.mockResolvedValue(jsonResponse({ files: [] }));

		await uploadRunFiles("conv1", [{ path: "/home/pyodide/small.txt" }]);

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [, init] = fetchMock.mock.calls[0];
		expect(init).toMatchObject({ keepalive: true });
	});

	it("does not force keepalive on an upload past the safe budget", async () => {
		// Chromium enforces a 64KB *combined* cap across every in-flight
		// keepalive body on a page; a fetch that requests keepalive over that
		// cap throws instead of sending. A file this size keeps the ordinary
		// (pre-existing) risk of a lost upload on an immediate reload rather
		// than risking that throw.
		sessionMock.readFile.mockResolvedValue(new ArrayBuffer(100_000));
		const fetchMock = vi.mocked(fetch);
		fetchMock.mockResolvedValue(jsonResponse({ files: [] }));

		await uploadRunFiles("conv1", [{ path: "/home/pyodide/big.bin" }]);

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [, init] = fetchMock.mock.calls[0];
		expect(init).not.toHaveProperty("keepalive");
	});
});

describe("recordRunFiles: keepalive across a reload", () => {
	beforeEach(() => {
		vi.stubGlobal("fetch", vi.fn());
	});

	it("always keeps the (small, hashes-only) record POST alive past an unload", async () => {
		const fetchMock = vi.mocked(fetch);
		fetchMock.mockResolvedValue(jsonResponse({ update: undefined }));

		await recordRunFiles({
			conversationId: "conv1",
			messageId: "msg1",
			runKey: "chat:abc",
			files: [{ name: "notes.txt", size: 11, sha256: "a".repeat(64) }],
		});

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [, init] = fetchMock.mock.calls[0];
		expect(init).toMatchObject({ keepalive: true });
	});
});

describe("recordRunFiles: a 409 (message not saved yet) is retried", () => {
	const files = [{ name: "hello.docx", size: 42, sha256: "b".repeat(64) }];
	const refused = () => new Response("message not saved yet", { status: 409 });
	const recorded = () => jsonResponse({ update: { type: "codeExecution", subtype: "outputs" } });
	const idsSent = (fetchMock: ReturnType<typeof vi.mocked<typeof fetch>>) =>
		fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).messageId);

	beforeEach(() => {
		vi.stubGlobal("fetch", vi.fn());
	});

	it("records once the save lands, with no id change", async () => {
		const fetchMock = vi.mocked(fetch);
		fetchMock.mockResolvedValueOnce(refused()).mockResolvedValueOnce(recorded());

		const update = await recordRunFiles({
			conversationId: "conv1",
			messageId: "msg-final",
			currentMessageId: () => "msg-final",
			runKey: "chat:abc",
			files,
			retryDelaysMs: [0, 0, 0],
		});

		expect(update).toBeDefined();
		expect(idsSent(fetchMock)).toEqual(["msg-final", "msg-final"]);
	});

	it("retries under the message's current id when it swaps meanwhile", async () => {
		const fetchMock = vi.mocked(fetch);
		fetchMock.mockResolvedValueOnce(refused()).mockResolvedValueOnce(recorded());
		let current = "client-id";

		const pending = recordRunFiles({
			conversationId: "conv1",
			messageId: "client-id",
			currentMessageId: () => current,
			runKey: "chat:abc",
			files,
			retryDelaysMs: [0],
		});
		current = "server-id";

		expect(await pending).toBeDefined();
		expect(idsSent(fetchMock)).toEqual(["client-id", "server-id"]);
	});

	it("gives up after the last retry", async () => {
		const fetchMock = vi.mocked(fetch);
		fetchMock.mockImplementation(async () => refused());

		const update = await recordRunFiles({
			conversationId: "conv1",
			messageId: "msg1",
			runKey: "chat:abc",
			files,
			retryDelaysMs: [0, 0, 0],
		});

		expect(update).toBeUndefined();
		expect(fetchMock).toHaveBeenCalledTimes(4);
	});

	it("does not retry any other failure", async () => {
		const fetchMock = vi.mocked(fetch);
		fetchMock.mockResolvedValueOnce(new Response("nope", { status: 403 }));

		const update = await recordRunFiles({
			conversationId: "conv1",
			messageId: "msg1",
			runKey: "chat:abc",
			files,
			retryDelaysMs: [0, 0, 0],
		});

		expect(update).toBeUndefined();
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});

describe("uploadAndDescribe: a failed save is still a record", () => {
	const SHA = "a".repeat(64);
	beforeEach(() => {
		sessionMock.readFile.mockReset();
		sessionMock.readFile.mockResolvedValue(new ArrayBuffer(4));
		vi.stubGlobal("fetch", vi.fn());
		clearFileByteCache();
	});

	it("marks the file uploaded: false when the store refuses it, keeping name, size and sha", async () => {
		vi.mocked(fetch).mockResolvedValue(new Response("nope", { status: 500 }));
		const refs = await uploadAndDescribe("conv1", [
			{ path: "/home/pyodide/out/x.pdf", size: 4, sha256: SHA },
		]);
		expect(refs).toEqual([{ name: "out/x.pdf", size: 4, sha256: SHA, uploaded: false }]);
	});

	it("marks it uploaded: true only when the store answers with that sha", async () => {
		vi.mocked(fetch).mockResolvedValue(
			jsonResponse({ files: [{ name: "x.pdf", size: 4, sha256: SHA }] })
		);
		const refs = await uploadAndDescribe("conv1", [
			{ path: "/home/pyodide/b/x.pdf", size: 4, sha256: SHA },
		]);
		// The run's own name wins over whichever name the store first saw.
		expect(refs).toEqual([{ name: "b/x.pdf", size: 4, sha256: SHA, uploaded: true }]);
	});

	it("uploads this tab's fingerprinted bytes, not whatever the sandbox holds now", async () => {
		cacheFileBytes(SHA, new Uint8Array([9, 9, 9, 9]));
		vi.mocked(fetch).mockResolvedValue(jsonResponse({ files: [] }));
		await uploadAndDescribe("conv1", [{ path: "/home/pyodide/x.bin", size: 4, sha256: SHA }]);
		expect(sessionMock.readFile).not.toHaveBeenCalled();
	});
});

describe("retryFileUpload", () => {
	const SHA = "c".repeat(64);
	beforeEach(() => {
		vi.stubGlobal("fetch", vi.fn());
		clearFileByteCache();
	});

	it("cannot retry once this tab no longer holds the bytes", async () => {
		const ok = await retryFileUpload({
			conversationId: "conv1",
			messageId: "m1",
			runKey: "chat:abc",
			file: { name: "x.csv", size: 3, sha256: SHA },
		});
		expect(ok).toBe(false);
		expect(fetch).not.toHaveBeenCalled();
	});

	it("uploads the kept bytes and records the file as stored", async () => {
		cacheFileBytes(SHA, new Uint8Array([1, 2, 3]));
		vi.mocked(fetch)
			.mockResolvedValueOnce(jsonResponse({ files: [{ name: "x.csv", size: 3, sha256: SHA }] }))
			.mockResolvedValueOnce(jsonResponse({ update: undefined }));
		const ok = await retryFileUpload({
			conversationId: "conv1",
			messageId: "m1",
			runKey: "chat:abc",
			file: { name: "x.csv", size: 3, sha256: SHA },
		});
		expect(ok).toBe(true);
		const [, record] = vi.mocked(fetch).mock.calls[1];
		expect(JSON.parse(String(record?.body))).toMatchObject({
			messageId: "m1",
			runKey: "chat:abc",
			files: [{ name: "x.csv", size: 3, sha256: SHA }],
		});
	});
});
