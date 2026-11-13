import BrowseLiveView from "./BrowseLiveView.svelte";
import { render, cleanup } from "vitest-browser-svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function must<T>(value: T | null | undefined): T {
	if (value === null || value === undefined) throw new Error("expected a value");
	return value;
}

/** A stand-in for the browser's EventSource that the test drives. */
class FakeEventSource {
	static all: FakeEventSource[] = [];
	readyState = 1;
	onerror: (() => void) | null = null;
	private listeners = new Map<string, Array<(e: MessageEvent) => void>>();
	constructor(readonly url: string) {
		FakeEventSource.all.push(this);
	}
	addEventListener(type: string, fn: (e: MessageEvent) => void) {
		this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
	}
	close() {
		this.readyState = 2;
	}
	emit(type: string, data: unknown) {
		for (const fn of this.listeners.get(type) ?? [])
			fn({ data: JSON.stringify(data) } as MessageEvent);
	}
}
const current = () => must(FakeEventSource.all.at(-1));

/** A real (small) JPEG, so the frame has a size on screen. */
function jpeg(): string {
	const canvas = document.createElement("canvas");
	canvas.width = 200;
	canvas.height = 100;
	const g = must(canvas.getContext("2d"));
	g.fillStyle = "#789";
	g.fillRect(0, 0, 200, 100);
	return canvas.toDataURL("image/jpeg").split(",")[1];
}

let calls: Array<{ url: string; body: unknown }>;
let reply: (url: string, body: unknown) => { status: number; json: unknown };

beforeEach(() => {
	FakeEventSource.all = [];
	calls = [];
	reply = (url, body) => {
		if (url.endsWith("/control")) {
			return {
				status: 200,
				json: { controller: (body as { action: string }).action === "takeover" ? "user" : "agent" },
			};
		}
		return { status: 200, json: { sent: 1 } };
	};
	vi.stubGlobal("EventSource", FakeEventSource);
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init?: RequestInit) => {
			const body = init?.body ? JSON.parse(String(init.body)) : undefined;
			calls.push({ url, body });
			const r = reply(url, body);
			return new Response(JSON.stringify(r.json), { status: r.status });
		})
	);
});
afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

const q = (id: string) => document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const frame = (w = 1000, h = 500) => current().emit("frame", { seq: 1, w, h, data: jpeg() });
const settle = () => new Promise((r) => setTimeout(r, 60));
const inputs = () =>
	calls
		.filter((c) => c.url.endsWith("/input"))
		.flatMap((c) => (c.body as { events: unknown[] }).events);

describe("the live view in the browse card", () => {
	it("asks for a thumbnail-sized stream, and shows the frames as they come", async () => {
		render(BrowseLiveView, { uuid: "task 1" });
		expect(current().url).toContain("/api/v2/browse/live/task%201?width=480");
		expect(q("browse-live-connecting")).not.toBeNull();
		frame();
		await settle();
		expect(q("browse-live-thumbnail")).not.toBeNull();
		expect(q("browse-live-connecting")).toBeNull();
		expect(q("browse-live-take-over")?.hasAttribute("disabled")).toBe(false);
	});

	it("enlarges to a full-screen view on a click, and asks for a bigger stream", async () => {
		render(BrowseLiveView, { uuid: "t" });
		frame();
		await settle();
		must(q("browse-live-thumbnail")).click();
		await settle();
		expect(q("browse-live-screen")).not.toBeNull();
		expect(must(q("browse-live-screen")).getAttribute("role")).toBe("dialog");
		const widths = FakeEventSource.all.map((s) =>
			Number(new URL(s.url, "http://x").searchParams.get("width"))
		);
		expect(widths[0]).toBe(480);
		expect(must(widths.at(-1))).not.toBe(480);
		// The first stream is closed: one viewer, not two.
		expect(FakeEventSource.all[0].readyState).toBe(2);
		must(q("browse-live-close")).click();
		await settle();
		expect(q("browse-live-screen")).toBeNull();
	});

	it("takes over, goes full screen, and hands back", async () => {
		render(BrowseLiveView, { uuid: "t" });
		frame();
		await settle();
		must(q("browse-live-take-over")).click();
		await vi.waitFor(() => expect(q("browse-live-in-control")).not.toBeNull());
		expect(calls[0]).toEqual({
			url: expect.stringContaining("/control"),
			body: { action: "takeover" },
		});
		expect(q("browse-live-screen")).not.toBeNull();
		expect(q("browse-live")?.getAttribute("data-controller")).toBe("user");
		must(q("browse-live-hand-back")).click();
		await vi.waitFor(() => expect(q("browse-live-in-control")).toBeNull());
		expect(must(calls.at(-1)).body).toEqual({ action: "handback" });
		expect(q("browse-live-take-over")).not.toBeNull();
	});

	it("follows the server: a takeover made in the window shows here too", async () => {
		render(BrowseLiveView, { uuid: "t" });
		frame();
		current().emit("control", { controller: "user" });
		await vi.waitFor(() => expect(q("browse-live-in-control")).not.toBeNull());
		current().emit("control", { controller: "agent" });
		await vi.waitFor(() => expect(q("browse-live-in-control")).toBeNull());
	});

	it("says why a takeover was refused", async () => {
		reply = () => ({ status: 403, json: { message: "A scheduled run cannot be taken over." } });
		render(BrowseLiveView, { uuid: "t" });
		frame();
		await settle();
		must(q("browse-live-take-over")).click();
		await vi.waitFor(() => expect(q("browse-live-message")).not.toBeNull());
		expect(must(q("browse-live-message")).textContent).toContain(
			"A scheduled run cannot be taken over."
		);
		expect(q("browse-live")?.getAttribute("data-controller")).toBe("agent");
	});

	it("goes quiet when the task ends, and shows nothing for a stream that is refused", async () => {
		render(BrowseLiveView, { uuid: "t" });
		frame();
		await settle();
		current().emit("end", { reason: "ended" });
		await vi.waitFor(() => expect(q("browse-live-ended")).not.toBeNull());
		expect(q("browse-live-take-over")).toBeNull();
		cleanup();

		render(BrowseLiveView, { uuid: "gone" });
		current().readyState = 2;
		current().onerror?.();
		await settle();
		expect(q("browse-live")).toBeNull();
		expect(q("browse-live-ended")).toBeNull();
	});
});

describe("takeover input", () => {
	async function inControl() {
		render(BrowseLiveView, { uuid: "t" });
		frame(1000, 500);
		await settle();
		must(q("browse-live-take-over")).click();
		await vi.waitFor(() => expect(q("browse-live-surface")).not.toBeNull());
		await settle();
		return q("browse-live-surface") as HTMLImageElement;
	}
	const pointer = (
		el: HTMLElement,
		type: string,
		x: number,
		y: number,
		over: PointerEventInit = {}
	) => {
		const r = el.getBoundingClientRect();
		el.dispatchEvent(
			new PointerEvent(type, {
				bubbles: true,
				clientX: r.left + r.width * x,
				clientY: r.top + r.height * y,
				pointerId: 1,
				pointerType: "mouse",
				button: 0,
				detail: 1,
				...over,
			})
		);
	};

	it("sends a click in the page's own pixels", async () => {
		const surface = await inControl();
		pointer(surface, "pointerdown", 0.5, 0.5);
		pointer(surface, "pointerup", 0.5, 0.5);
		await vi.waitFor(() => expect(inputs().length).toBeGreaterThanOrEqual(3));
		const events = inputs() as Array<{
			type: string;
			action: string;
			x: number;
			y: number;
			button?: string;
		}>;
		const down = must(events.find((e) => e.action === "down"));
		expect(down.x).toBeCloseTo(500, 0);
		expect(down.y).toBeCloseTo(250, 0);
		expect(down.button).toBe("left");
		expect(events.find((e) => e.action === "up")).toBeDefined();
	});

	it("sends a touch as touch events", async () => {
		const surface = await inControl();
		pointer(surface, "pointerdown", 0.25, 0.5, { pointerType: "touch" });
		pointer(surface, "pointermove", 0.5, 0.5, { pointerType: "touch", buttons: 1 });
		pointer(surface, "pointerup", 0.5, 0.5, { pointerType: "touch" });
		await vi.waitFor(() => expect(inputs().length).toBeGreaterThanOrEqual(3));
		const events = inputs() as Array<{
			type: string;
			action: string;
			points: Array<{ x: number }>;
		}>;
		expect(events.map((e) => `${e.type}:${e.action}`)).toEqual([
			"touch:start",
			"touch:move",
			"touch:end",
		]);
		expect(events[0].points[0].x).toBeCloseTo(250, 0);
	});

	it("sends the wheel", async () => {
		const surface = await inControl();
		surface.dispatchEvent(
			new WheelEvent("wheel", {
				bubbles: true,
				cancelable: true,
				deltaY: 120,
				clientX: 10,
				clientY: 10,
			})
		);
		await vi.waitFor(() => expect(inputs().length).toBeGreaterThanOrEqual(1));
		expect(inputs()[0]).toMatchObject({ type: "mouse", action: "wheel", deltaY: 120 });
	});

	it("types through the keyboard field: text as text, special keys as keys, an IME as it ends", async () => {
		await inControl();
		const field = q("browse-live-keyboard-field") as HTMLTextAreaElement;
		field.dispatchEvent(
			new InputEvent("beforeinput", {
				inputType: "insertText",
				data: "héllo",
				cancelable: true,
				bubbles: true,
			})
		);
		field.dispatchEvent(
			new KeyboardEvent("keydown", { key: "Backspace", cancelable: true, bubbles: true })
		);
		field.dispatchEvent(
			new InputEvent("beforeinput", {
				inputType: "deleteContentBackward",
				cancelable: true,
				bubbles: true,
			})
		);
		field.dispatchEvent(new CompositionEvent("compositionend", { data: "日本", bubbles: true }));
		await vi.waitFor(() => expect(inputs().length).toBeGreaterThanOrEqual(4));
		expect(inputs()).toEqual([
			{ type: "text", text: "héllo" },
			// The key and the input event it caused are one Backspace, not two.
			{ type: "key", action: "down", key: "Backspace", modifiers: 0 },
			{ type: "key", action: "up", key: "Backspace", modifiers: 0 },
			{ type: "text", text: "日本" },
		]);
	});

	it("sends a phone keyboard's backspace, which has no key event", async () => {
		await inControl();
		const field = q("browse-live-keyboard-field") as HTMLTextAreaElement;
		field.dispatchEvent(
			new InputEvent("beforeinput", {
				inputType: "deleteContentBackward",
				cancelable: true,
				bubbles: true,
			})
		);
		await vi.waitFor(() => expect(inputs().length).toBe(2));
		expect(inputs()[0]).toEqual({ type: "key", action: "down", key: "Backspace" });
	});

	it("sends nothing while the agent has the browser", async () => {
		render(BrowseLiveView, { uuid: "t" });
		frame();
		await settle();
		must(q("browse-live-thumbnail")).click();
		await settle();
		const surface = must(q("browse-live-surface"));
		pointer(surface, "pointerdown", 0.5, 0.5);
		pointer(surface, "pointerup", 0.5, 0.5);
		await settle();
		expect(calls).toEqual([]);
	});

	it("falls back to watching when the server says it is not in control", async () => {
		const control = reply;
		reply = (url, body) =>
			url.endsWith("/input") ? { status: 409, json: {} } : control(url, body);
		const surface = await inControl();
		pointer(surface, "pointerdown", 0.5, 0.5);
		await vi.waitFor(() => expect(q("browse-live-in-control")).toBeNull());
	});
});
