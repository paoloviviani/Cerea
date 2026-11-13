import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LiveViewSession } from "./liveViewSession.svelte";

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
const stream = () => {
	const s = FakeEventSource.all.at(-1);
	if (!s) throw new Error("no stream");
	return s;
};

function jpeg(): string {
	const c = document.createElement("canvas");
	c.width = 200;
	c.height = 100;
	const g = c.getContext("2d");
	if (g) g.fillRect(0, 0, 200, 100);
	return c.toDataURL("image/jpeg").split(",")[1];
}

const INFO = {
	id: "t1",
	machineId: "m1",
	machineName: "Laptop",
	kind: "browse_task",
	url: "https://shop.example.com/cart",
	origin: "https://shop.example.com",
	controller: "agent",
	unattended: false,
	userOwned: false,
};

let calls: Array<{ url: string; body: { action?: string; events?: unknown[] } }>;
let reply: (url: string) => { status: number; json: unknown };

beforeEach(() => {
	FakeEventSource.all = [];
	calls = [];
	reply = (url) => ({
		status: 200,
		json: url.endsWith("/control") ? { controller: "user" } : { sent: 1 },
	});
	vi.stubGlobal("EventSource", FakeEventSource);
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init?: RequestInit) => {
			calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : {} });
			const r = reply(url);
			return new Response(JSON.stringify(r.json), { status: r.status });
		})
	);
});
afterEach(() => vi.unstubAllGlobals());

const inputs = () =>
	calls.filter((c) => c.url.endsWith("/input")).flatMap((c) => c.body.events ?? []);

function rig() {
	const session = new LiveViewSession("/api/v2/browse/live/t1");
	const canvas = document.createElement("canvas");
	canvas.style.cssText = "width:200px;height:100px;display:block";
	document.body.append(canvas);
	session.attachCanvas(canvas);
	session.connect(480);
	return { session, canvas };
}
const pointer = (
	el: HTMLElement,
	type: string,
	fx: number,
	fy: number,
	over: PointerEventInit = {}
) => {
	const r = el.getBoundingClientRect();
	el.dispatchEvent(
		new PointerEvent(type, {
			bubbles: true,
			clientX: r.left + r.width * fx,
			clientY: r.top + r.height * fy,
			pointerId: 1,
			pointerType: "mouse",
			button: 0,
			detail: 1,
			...over,
		})
	);
};
const takeOver = async (session: LiveViewSession) => {
	stream().emit("frame", { seq: 1, w: 1000, h: 500, data: jpeg() });
	expect(await session.takeover()).toBe(true);
};

describe("LiveViewSession", () => {
	it("subscribes at the requested width and says where it runs", () => {
		const { session } = rig();
		expect(stream().url).toContain("/api/v2/browse/live/t1?width=480");
		expect(session.status).toBe("connecting");
		stream().emit("session", INFO);
		expect(session.info).toMatchObject({
			machineId: "m1",
			machineName: "Laptop",
			kind: "browse_task",
			origin: "https://shop.example.com",
		});
		stream().emit("session", { ...INFO, kind: "lent_tab" });
		expect(session.info?.kind).toBe("lent_tab");
	});

	it("draws frames on its canvas and reports the page's size", async () => {
		const { session, canvas } = rig();
		stream().emit("frame", { seq: 1, w: 1280, h: 800, data: jpeg() });
		expect(session.status).toBe("live");
		expect(session.frameSize).toEqual({ width: 1280, height: 800 });
		await vi.waitFor(() => expect(canvas.width).toBe(200));
	});

	it("reconnects for another width, with one stream open", () => {
		const { session } = rig();
		session.connect(1200);
		expect(FakeEventSource.all[0].readyState).toBe(2);
		expect(stream().url).toContain("width=1200");
	});

	it("takes over and hands back, and follows the server's control events", async () => {
		const { session } = rig();
		await takeOver(session);
		expect(session.controller).toBe("user");
		expect(calls[0]).toMatchObject({ body: { action: "takeover" } });
		reply = () => ({ status: 200, json: { controller: "agent" } });
		await session.handBack();
		expect(session.controller).toBe("agent");
		stream().emit("control", { controller: "user" });
		expect(session.controller).toBe("user");
	});

	it("keeps the server's reason when a takeover is refused", async () => {
		const { session } = rig();
		reply = () => ({ status: 403, json: { message: "A scheduled run cannot be taken over." } });
		expect(await session.takeover()).toBe(false);
		expect(session.error).toContain("scheduled run");
		expect(session.controller).toBe("agent");
	});

	it("ends, and is unavailable when the stream is refused", () => {
		const { session } = rig();
		stream().emit("end", { reason: "ended" });
		expect(session.status).toBe("ended");
		const other = rig();
		stream().readyState = 2;
		stream().onerror?.();
		expect(other.session.status).toBe("unavailable");
	});

	it("sends a click in the page's own pixels", async () => {
		const { session, canvas } = rig();
		await takeOver(session);
		pointer(canvas, "pointerdown", 0.5, 0.5);
		pointer(canvas, "pointerup", 0.5, 0.5);
		await vi.waitFor(() => expect(inputs().length).toBeGreaterThanOrEqual(3));
		const down = (inputs() as Array<{ action: string; x: number; y: number; button: string }>).find(
			(e) => e.action === "down"
		);
		expect(down).toMatchObject({ button: "left" });
		expect(down?.x).toBeCloseTo(500, 0);
		expect(down?.y).toBeCloseTo(250, 0);
	});

	it("sends touch and the wheel", async () => {
		const { session, canvas } = rig();
		await takeOver(session);
		pointer(canvas, "pointerdown", 0.25, 0.5, { pointerType: "touch" });
		pointer(canvas, "pointermove", 0.5, 0.5, { pointerType: "touch", buttons: 1 });
		pointer(canvas, "pointerup", 0.5, 0.5, { pointerType: "touch" });
		canvas.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 120 }));
		await vi.waitFor(() => expect(inputs().length).toBe(4));
		expect(
			(inputs() as Array<{ type: string; action: string }>).map((e) => `${e.type}:${e.action}`)
		).toEqual(["touch:start", "touch:move", "touch:end", "mouse:wheel"]);
	});

	it("types through its keyboard field: text, special keys once, an IME at its end", async () => {
		const { session } = rig();
		const field = document.createElement("textarea");
		session.attachKeyboard(field);
		await takeOver(session);
		field.dispatchEvent(
			new InputEvent("beforeinput", { inputType: "insertText", data: "héllo", cancelable: true })
		);
		field.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", cancelable: true }));
		field.dispatchEvent(
			new InputEvent("beforeinput", { inputType: "deleteContentBackward", cancelable: true })
		);
		field.dispatchEvent(new CompositionEvent("compositionend", { data: "日本" }));
		await vi.waitFor(() => expect(inputs().length).toBe(4));
		expect(inputs()).toEqual([
			{ type: "text", text: "héllo" },
			{ type: "key", action: "down", key: "Backspace", modifiers: 0 },
			{ type: "key", action: "up", key: "Backspace", modifiers: 0 },
			{ type: "text", text: "日本" },
		]);
	});

	it("sends nothing while the agent has the browser, and falls back on a 409", async () => {
		const { session, canvas } = rig();
		pointer(canvas, "pointerdown", 0.5, 0.5);
		await new Promise((r) => setTimeout(r, 60));
		expect(calls).toEqual([]);
		await takeOver(session);
		reply = (url) =>
			url.endsWith("/input")
				? { status: 409, json: {} }
				: { status: 200, json: { controller: "user" } };
		pointer(canvas, "pointerdown", 0.5, 0.5);
		await vi.waitFor(() => expect(session.controller).toBe("agent"));
	});
});
