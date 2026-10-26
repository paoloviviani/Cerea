import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/config", () => ({
	config: { OPENAI_BASE_URL: "http://gateway.test/v1" },
}));

import { gateway, GatewayTimeout } from "./gatewayServer";

/**
 * A 50-page PDF takes the local reader ~24 s. The clock here is faked, so the
 * "slow server" costs nothing: the fetch answers after 24 simulated seconds,
 * and `AbortSignal.timeout` fires on the same fake clock.
 */
const realFetch = globalThis.fetch;

beforeEach(() => {
	vi.useFakeTimers();
	vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
		const controller = new AbortController();
		setTimeout(() => controller.abort(new DOMException("timed out", "TimeoutError")), ms);
		return controller.signal;
	});
	globalThis.fetch = vi.fn((_url: unknown, init?: RequestInit) => {
		return new Promise<Response>((resolve, reject) => {
			const answer = setTimeout(
				() => resolve(new Response(JSON.stringify({ ok: true }), { status: 200 })),
				24_000
			);
			init?.signal?.addEventListener("abort", () => {
				clearTimeout(answer);
				reject(init.signal?.reason);
			});
		});
	}) as unknown as typeof fetch;
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	globalThis.fetch = realFetch;
});

describe("gateway.post with a deadline", () => {
	it("lets a 24 second answer through when the deadline is three minutes", async () => {
		const pending = gateway.post("t", "ocr", {}, { timeoutMs: 180_000 });
		await vi.advanceTimersByTimeAsync(24_000);
		await expect(pending).resolves.toEqual({ ok: true });
	});

	it("throws GatewayTimeout, with the elapsed time, when the deadline passes first", async () => {
		const pending = gateway.post("t", "ocr", {}, { timeoutMs: 10_000 });
		const assertion = expect(pending).rejects.toMatchObject({
			name: "GatewayTimeout",
			status: 504,
			timeoutMs: 10_000,
		});
		await vi.advanceTimersByTimeAsync(10_000);
		await assertion;
		await pending.catch((err) => expect(err).toBeInstanceOf(GatewayTimeout));
	});

	it("sets no deadline of its own when none is asked for", async () => {
		const pending = gateway.post("t", "ocr", {});
		await vi.advanceTimersByTimeAsync(24_000);
		await expect(pending).resolves.toEqual({ ok: true });
		expect(AbortSignal.timeout).not.toHaveBeenCalled();
	});
});
