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

import { uploadRunFiles, recordRunFiles } from "./runFiles";

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

		await uploadRunFiles("conv1", [{ path: "/home/pyodide/small.txt", size: 10 }]);

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

		await uploadRunFiles("conv1", [{ path: "/home/pyodide/big.bin", size: 100_000 }]);

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
