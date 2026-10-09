import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import superjson from "superjson";
import { codeAgentStream } from "./codeAgentStream";
import { codeReauth, resetCodeReauth, signOutRedirect } from "$lib/stores/codeReauth.svelte";

/**
 * The agent stream's two ways of learning the sign-in lapsed: the server's
 * closing `reauth_required` frame (scheduled at authTime + 7d), and a refusal
 * at open — which closes an EventSource silently, so the stream asks
 * `/status` and lets the shared flag say why.
 */
class FakeSource {
	static last: FakeSource | null = null;
	static CLOSED = 2;
	readyState = 1;
	closed = false;
	private listeners = new Map<string, Array<(event: unknown) => void>>();
	constructor(readonly url: string) {
		FakeSource.last = this;
	}
	addEventListener(type: string, fn: (event: unknown) => void) {
		this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
	}
	close() {
		this.closed = true;
		this.readyState = 2;
	}
	emit(type: string, data?: string) {
		for (const fn of this.listeners.get(type) ?? []) fn({ data });
	}
}

beforeEach(() => {
	resetCodeReauth();
	FakeSource.last = null;
	vi.stubGlobal("EventSource", FakeSource);
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	resetCodeReauth();
});

describe("codeAgentStream and the sign-in", () => {
	it("flips the flag on the closing reauth_required frame, and ends", async () => {
		const abort = new AbortController();
		const frames: unknown[] = [];
		const done = (async () => {
			for await (const frame of codeAgentStream("d1", "a1", abort.signal)) frames.push(frame);
		})();
		const source = FakeSource.last as FakeSource;
		source.emit("update", JSON.stringify({ type: "reset" }));
		source.emit("reauth_required", JSON.stringify({ code: "reauth_required" }));
		await done;
		expect(frames).toEqual([{ type: "reset" }]);
		expect(codeReauth.required).toBe(true);
		expect(source.closed).toBe(true);
	});

	it("asks /status, and flips the flag, when the server refused the open", async () => {
		const fetchSpy = vi.fn(
			async (_input: RequestInfo | URL) =>
				new Response(
					superjson.stringify({
						enabled: true,
						fresh: false,
						reauthPath: "/login?reauth=1&next=/code",
					}),
					{ status: 200 }
				)
		);
		vi.stubGlobal("fetch", fetchSpy);
		const abort = new AbortController();
		const done = (async () => {
			for await (const frame of codeAgentStream("d1", "a1", abort.signal)) void frame;
		})();
		const source = FakeSource.last as FakeSource;
		source.readyState = FakeSource.CLOSED;
		source.emit("error");
		await done;
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(String(fetchSpy.mock.calls[0][0])).toContain("/api/v2/code/status");
		await vi.waitFor(() => expect(codeReauth.required).toBe(true));
	});

	it("a signed-out status at open hides the panel without the stale flag", async () => {
		// The redirect is a page navigation: stay here and assert the state.
		vi.spyOn(signOutRedirect, "go").mockImplementation(() => {});
		const fetchSpy = vi.fn(
			async (_input: RequestInfo | URL) =>
				new Response(
					superjson.stringify({
						enabled: true,
						signedIn: false,
						fresh: false,
						reauthPath: "/login?reauth=1&next=/code",
						signInPath: "/login?next=/code",
					}),
					{ status: 200 }
				)
		);
		vi.stubGlobal("fetch", fetchSpy);
		const abort = new AbortController();
		const done = (async () => {
			for await (const frame of codeAgentStream("d1", "a1", abort.signal)) void frame;
		})();
		const source = FakeSource.last as FakeSource;
		source.readyState = FakeSource.CLOSED;
		source.emit("error");
		await done;
		await vi.waitFor(() => expect(codeReauth.required).toBe(true));
		// Hidden like stale, but the card is the signed-out one: no forced
		// password prompt for an ordinary hourly expiry.
		expect(codeReauth.signedOut).toBe(true);
	});

	it("leaves an ordinary reconnecting error alone", async () => {
		const fetchSpy = vi.fn();
		vi.stubGlobal("fetch", fetchSpy);
		const abort = new AbortController();
		const done = (async () => {
			for await (const frame of codeAgentStream("d1", "a1", abort.signal)) void frame;
		})();
		const source = FakeSource.last as FakeSource;
		source.readyState = 0; // CONNECTING: EventSource is retrying by itself
		source.emit("error");
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(codeReauth.required).toBe(false);
		abort.abort();
		await done;
	});
});
