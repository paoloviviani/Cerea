/** The live view's routes: only the owner of a running task reaches anything. */
import { afterEach, describe, expect, it } from "vitest";
import { ObjectId } from "mongodb";
import { FakeBrowserRuntime } from "$lib/server/browser/fakeRuntime";
import { registerLiveTask, type LiveRuntime } from "$lib/server/browser/liveView";
import { TaskControl } from "$lib/server/browser/takeover";
import { GET } from "./[uuid]/+server";
import { POST as CONTROL } from "./[uuid]/control/+server";
import { POST as INPUT } from "./[uuid]/input/+server";

function must<T>(value: T | null | undefined): T {
	if (value === null || value === undefined) throw new Error("expected a value");
	return value;
}

const owner = new ObjectId();
const stranger = new ObjectId();

let stop: (() => void) | undefined;
let push: ((seq: number, payload: Buffer) => void) | undefined;
afterEach(() => stop?.());

function run(unattended = false) {
	const runtime = new FakeBrowserRuntime([
		{ id: "p", url: "https://a.test/", title: "A", elements: [] },
	]);
	stop = registerLiveTask({
		taskId: "t1",
		userId: owner.toString(),
		deviceId: "d1",
		machineName: "Laptop",
		runtime: runtime as unknown as LiveRuntime,
		control: new TaskControl(runtime),
		unattended,
		subscribeFrames: (_d, listener) => {
			push = listener;
			return () => {};
		},
	});
	return runtime;
}

const as = (user: ObjectId | undefined) => ({ user: user ? { _id: user } : undefined }) as never;
const post = (body: unknown) =>
	new Request("http://x/", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
const call = async (fn: () => unknown) => {
	try {
		return (await fn()) as Response;
	} catch (err) {
		return err as { status: number };
	}
};
const status = (r: { status: number }) => r.status;

describe("the live view routes", () => {
	it("answer nobody who is not signed in, and nobody but the owner", async () => {
		run();
		const params = { uuid: "t1" };
		const get = (user?: ObjectId) =>
			call(() =>
				GET({
					locals: as(user),
					params,
					url: new URL("http://x/?width=300"),
					request: new Request("http://x/"),
				} as never)
			);
		expect(status(await get(undefined))).toBe(401);
		expect(status(await get(stranger))).toBe(404);
		const control = (user: ObjectId | undefined) =>
			call(() =>
				CONTROL({ locals: as(user), params, request: post({ action: "takeover" }) } as never)
			);
		expect(status(await control(undefined))).toBe(401);
		expect(status(await control(stranger))).toBe(404);
		const input = (user: ObjectId | undefined) =>
			call(() =>
				INPUT({
					locals: as(user),
					params,
					request: post({ events: [{ type: "text", text: "x" }] }),
				} as never)
			);
		expect(status(await input(undefined))).toBe(401);
		expect(status(await input(stranger))).toBe(404);
		// A task that is not running is a 404 too.
		const gone = await call(() =>
			GET({
				locals: as(owner),
				params: { uuid: "nope" },
				url: new URL("http://x/"),
				request: new Request("http://x/"),
			} as never)
		);
		expect(status(gone)).toBe(404);
	});

	it("stream frames to the owner as events, and ask nothing of a stranger's stream", async () => {
		run();
		const abort = new AbortController();
		const response = (await GET({
			locals: as(owner),
			params: { uuid: "t1" },
			url: new URL("http://x/?width=300"),
			request: new Request("http://x/", { signal: abort.signal }),
		} as never)) as Response;
		expect(response.headers.get("content-type")).toBe("text/event-stream");
		const reader = must(response.body).getReader();
		const decoder = new TextDecoder();
		let text = "";
		const read = async (until: RegExp) => {
			for (let i = 0; i < 50 && !until.test(text); i += 1) {
				const chunk = await Promise.race([
					reader.read(),
					new Promise<{ done: true; value: undefined }>((r) =>
						setTimeout(() => r({ done: true, value: undefined }), 200)
					),
				]);
				if (chunk.value) text += decoder.decode(chunk.value);
				if (chunk.done && !until.test(text)) await new Promise((r) => setTimeout(r, 10));
			}
		};
		await read(/event: control/);
		expect(text).toContain('event: control\ndata: {"controller":"agent"}');
		must(push)(5, Buffer.from([1, 0, 0, 1, 0xff, 0xd8]));
		await read(/event: frame/);
		expect(text).toContain("event: frame");
		expect(text).toContain('"seq":5');
		expect(text).toContain('"data":"/9g="');
		abort.abort();
		stop?.();
	});

	it("take over, take input, hand back; a scheduled run cannot be taken over", async () => {
		const runtime = run();
		const params = { uuid: "t1" };
		const takeover = await CONTROL({
			locals: as(owner),
			params,
			request: post({ action: "takeover" }),
		} as never);
		expect(await takeover.json()).toEqual({ controller: "user" });
		const sent = await INPUT({
			locals: as(owner),
			params,
			request: post({ events: [{ type: "text", text: "hello" }] }),
		} as never);
		expect(await sent.json()).toEqual({ sent: 1 });
		expect(runtime.userInput).toEqual([{ type: "text", text: "hello" }]);
		const back = await CONTROL({
			locals: as(owner),
			params,
			request: post({ action: "handback" }),
		} as never);
		expect(await back.json()).toEqual({ controller: "agent" });
		const refused = await call(() =>
			INPUT({
				locals: as(owner),
				params,
				request: post({ events: [{ type: "text", text: "x" }] }),
			} as never)
		);
		expect(status(refused)).toBe(409);
		stop?.();

		run(true);
		const scheduled = await call(() =>
			CONTROL({ locals: as(owner), params, request: post({ action: "takeover" }) } as never)
		);
		expect(status(scheduled)).toBe(403);
	});

	it("insist on JSON, and on a known action", async () => {
		run();
		const params = { uuid: "t1" };
		const plain = new Request("http://x/", {
			method: "POST",
			headers: { "content-type": "text/plain" },
			body: "{}",
		});
		expect(
			status(await call(() => CONTROL({ locals: as(owner), params, request: plain } as never)))
		).toBe(415);
		expect(
			status(
				await call(() =>
					CONTROL({ locals: as(owner), params, request: post({ action: "eval" }) } as never)
				)
			)
		).toBe(400);
	});

	it("do not queue frames for a viewer that stopped reading, and cap viewers at four", async () => {
		run();
		const aborts: AbortController[] = [];
		const open = async () => {
			const abort = new AbortController();
			aborts.push(abort);
			return (await call(() =>
				GET({
					locals: as(owner),
					params: { uuid: "t1" },
					url: new URL("http://x/?width=300"),
					request: new Request("http://x/", { signal: abort.signal }),
				} as never)
			)) as Response;
		};
		const stalled = await open();
		// 3000 frames of about 4 KiB to a viewer that never reads: far more than the backlog bound.
		const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(3_000, 7)]);
		const payload = Buffer.concat([Buffer.from([0x05, 0x00, 0x03, 0x20]), jpeg]);
		for (let seq = 1; seq <= 3000; seq += 1) must(push)(seq, payload);
		const reader = must(stalled.body).getReader();
		let bytes = 0;
		for (;;) {
			const chunk = await Promise.race([
				reader.read(),
				new Promise<{ done: true; value: undefined }>((r) =>
					setTimeout(() => r({ done: true, value: undefined }), 100)
				),
			]);
			if (chunk.done) break;
			bytes += chunk.value.length;
		}
		// 3000 frames are about 12 MB: only about the 1 MB bound was ever held.
		expect(bytes).toBeGreaterThan(0);
		expect(bytes).toBeLessThan(1_300_000);

		// The cap: the stalled one counts, three more fit, the fifth is a 429.
		for (let i = 0; i < 3; i += 1) expect((await open()).status).toBe(200);
		expect(status((await open()) as never)).toBe(429);
		for (const abort of aborts) abort.abort();
	});
});
