/**
 * Client side of the live view (ADR 0116 phase 2a), as a module and a store: no markup, no final
 * UI. A surface (the browse card, the Open browser modal, an agent machine's browser) creates a
 * `LiveViewSession` for a stream URL, hands it a canvas, and reads `info`, `status` and
 * `controller` to draw its own chrome.
 *
 * It subscribes to the Server-Sent Events of `GET <stream>`, draws each frame to the canvas, and,
 * while the user has taken over, sends their pointer, touch, wheel and keyboard input to
 * `POST <stream>/input` in the page's own pixels (the frame's size). `takeover()` and
 * `handBack()` post to `<stream>/control`.
 *
 * Generic on purpose: the stream URL is all it needs, and every payload says where it runs
 * (`info`: machine id and name, address, kind).
 */
import { base } from "$app/paths";

export type LiveKind = "browse_task" | "lent_tab" | "agent_machine";
export interface LiveSessionInfo {
	id: string;
	machineId: string;
	machineName: string;
	kind: LiveKind;
	url: string | null;
	origin: string | null;
	controller: "agent" | "user";
	unattended: boolean;
}
export type LiveStatus = "connecting" | "live" | "ended" | "unavailable";

type Point = { x: number; y: number };
type LiveInput =
	| {
			type: "mouse";
			action: "move" | "down" | "up" | "wheel";
			x: number;
			y: number;
			button?: "left" | "middle" | "right";
			clickCount?: number;
			deltaX?: number;
			deltaY?: number;
			modifiers?: number;
	  }
	| {
			type: "touch";
			action: "start" | "move" | "end" | "cancel";
			points: Array<Point & { id?: number }>;
	  }
	| { type: "key"; action: "down" | "up"; key: string; modifiers?: number }
	| { type: "text"; text: string };

const SPECIAL_KEYS = new Set([
	"Enter",
	"Backspace",
	"Tab",
	"Escape",
	"Delete",
	"ArrowLeft",
	"ArrowUp",
	"ArrowRight",
	"ArrowDown",
	"Home",
	"End",
	"PageUp",
	"PageDown",
	"F5",
]);

const modifiersOf = (e: {
	altKey: boolean;
	ctrlKey: boolean;
	metaKey: boolean;
	shiftKey: boolean;
}) => (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);

export class LiveViewSession {
	status = $state<LiveStatus>("connecting");
	info = $state<LiveSessionInfo | null>(null);
	controller = $state<"agent" | "user">("agent");
	/** The size of the page's viewport in CSS pixels (the last frame's). */
	frameSize = $state<{ width: number; height: number } | null>(null);
	error = $state<string | null>(null);

	private source?: EventSource;
	private canvas?: HTMLCanvasElement;
	private detachers: Array<() => void> = [];
	private queue: LiveInput[] = [];
	private flushing = false;
	private timer?: ReturnType<typeof setTimeout>;
	private keyHandledAt = 0;
	private drawing = false;
	private nextFrame?: string;

	/** `stream` is the stream's URL path, e.g. `/api/v2/browse/live/<id>` (the base path is added). */
	constructor(private readonly stream: string) {}

	private url(suffix = ""): string {
		return `${base}${this.stream}${suffix}`;
	}

	/** Starts (or restarts, for another width) the stream. `width` is what the surface can show. */
	connect(width: number): void {
		this.source?.close();
		this.status = "connecting";
		const source = new EventSource(`${this.url()}?width=${Math.round(width)}`);
		this.source = source;
		source.addEventListener("session", (e) => {
			const info = parse<LiveSessionInfo>(e);
			if (info) {
				this.info = info;
				this.controller = info.controller;
			}
		});
		source.addEventListener("control", (e) => {
			const data = parse<{ controller: "agent" | "user" }>(e);
			if (data) this.controller = data.controller;
		});
		source.addEventListener("frame", (e) => {
			const data = parse<{ data: string; w: number; h: number }>(e);
			if (!data) return;
			this.frameSize = { width: data.w, height: data.h };
			this.status = "live";
			this.draw(data.data);
		});
		source.addEventListener("end", () => {
			this.status = "ended";
			source.close();
		});
		source.onerror = () => {
			// A refused stream (not running, not yours) closes for good: nothing to retry.
			if (source.readyState === 2 && this.status !== "ended") this.status = "unavailable";
		};
	}

	disconnect(): void {
		this.source?.close();
		this.source = undefined;
		clearTimeout(this.timer);
		for (const off of this.detachers.splice(0)) off();
	}

	// ---- drawing ----------------------------------------------------------------------------

	/** Draws frames on this canvas, and sends the user's pointer input from it while they have taken over. */
	attachCanvas(canvas: HTMLCanvasElement): () => void {
		this.canvas = canvas;
		canvas.style.touchAction = "none";
		const listeners: Array<[string, (e: never) => void]> = [
			["pointerdown", (e: PointerEvent) => this.onPointerDown(e)],
			["pointermove", (e: PointerEvent) => this.onPointerMove(e)],
			["pointerup", (e: PointerEvent) => this.onPointerUp(e)],
			["pointercancel", (e: PointerEvent) => this.onPointerUp(e)],
			["wheel", (e: WheelEvent) => this.onWheel(e)],
		];
		for (const [type, fn] of listeners)
			canvas.addEventListener(type, fn as EventListener, { passive: false });
		const off = () => {
			for (const [type, fn] of listeners) canvas.removeEventListener(type, fn as EventListener);
			if (this.canvas === canvas) this.canvas = undefined;
		};
		this.detachers.push(off);
		return off;
	}

	private draw(base64: string): void {
		// Only the newest frame matters: one being decoded makes the next wait, and older ones go.
		this.nextFrame = base64;
		if (this.drawing) return;
		void this.drawNext();
	}

	private async drawNext(): Promise<void> {
		this.drawing = true;
		try {
			while (this.nextFrame) {
				const data = this.nextFrame;
				this.nextFrame = undefined;
				const canvas = this.canvas;
				if (!canvas) continue;
				try {
					const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
					const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/jpeg" }));
					if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
						canvas.width = bitmap.width;
						canvas.height = bitmap.height;
					}
					canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
					bitmap.close();
				} catch {
					// A damaged frame is skipped: the next one follows.
				}
			}
		} finally {
			this.drawing = false;
		}
	}

	// ---- takeover ---------------------------------------------------------------------------

	async takeover(): Promise<boolean> {
		return this.control("takeover");
	}
	async handBack(): Promise<boolean> {
		return this.control("handback");
	}

	private async control(action: "takeover" | "handback"): Promise<boolean> {
		this.error = null;
		try {
			const response = await fetch(this.url("/control"), {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ action }),
			});
			if (!response.ok) {
				const body = (await response.json().catch(() => null)) as { message?: string } | null;
				this.error = body?.message ?? String(response.status);
				return false;
			}
			this.controller = ((await response.json()) as { controller: "agent" | "user" }).controller;
			if (this.controller === "agent") this.queue = [];
			return true;
		} catch {
			this.error = "network";
			return false;
		}
	}

	// ---- input ------------------------------------------------------------------------------

	/** Queues one event (successive moves collapse into the last) and sends in small batches. */
	push(event: LiveInput): void {
		if (this.controller !== "user") return;
		const last = this.queue.at(-1);
		const sameMove =
			last &&
			last.type === event.type &&
			(event.type === "mouse" || event.type === "touch") &&
			"action" in last &&
			last.action === "move" &&
			event.action === "move";
		if (sameMove) this.queue[this.queue.length - 1] = event;
		else this.queue.push(event);
		this.timer ??= setTimeout(() => {
			this.timer = undefined;
			void this.flush();
		}, 30);
	}

	private async flush(): Promise<void> {
		if (this.flushing) return;
		this.flushing = true;
		try {
			while (this.queue.length > 0) {
				const events = this.queue.splice(0, 64);
				try {
					const response = await fetch(this.url("/input"), {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ events }),
					});
					if (response.status === 409) {
						this.controller = "agent";
						this.queue = [];
					} else if (response.status === 429) {
						await new Promise((resolve) => setTimeout(resolve, 250));
					}
				} catch {
					// A lost batch is a lost click: the user sees it and tries again.
				}
			}
		} finally {
			this.flushing = false;
		}
	}

	/** A point of the canvas in the page's own pixels. */
	private pointOf(e: { clientX: number; clientY: number }): Point {
		const canvas = this.canvas as HTMLCanvasElement;
		const rect = canvas.getBoundingClientRect();
		const w = this.frameSize?.width ?? rect.width;
		const h = this.frameSize?.height ?? rect.height;
		const x = Math.min(w, Math.max(0, ((e.clientX - rect.left) / rect.width) * w));
		const y = Math.min(h, Math.max(0, ((e.clientY - rect.top) / rect.height) * h));
		return { x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 };
	}

	private onPointerDown(e: PointerEvent): void {
		if (this.controller !== "user") return;
		(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
		const at = this.pointOf(e);
		if (e.pointerType === "touch") {
			this.push({ type: "touch", action: "start", points: [{ ...at, id: 0 }] });
		} else {
			this.push({ type: "mouse", action: "move", ...at });
			this.push({
				type: "mouse",
				action: "down",
				...at,
				button: e.button === 2 ? "right" : e.button === 1 ? "middle" : "left",
				clickCount: Math.min(3, Math.max(1, e.detail || 1)),
				modifiers: modifiersOf(e),
			});
		}
		e.preventDefault();
	}

	private onPointerMove(e: PointerEvent): void {
		if (this.controller !== "user") return;
		const at = this.pointOf(e);
		if (e.pointerType === "touch") {
			if (e.buttons) this.push({ type: "touch", action: "move", points: [{ ...at, id: 0 }] });
		} else {
			this.push({ type: "mouse", action: "move", ...at, modifiers: modifiersOf(e) });
		}
	}

	private onPointerUp(e: PointerEvent): void {
		if (this.controller !== "user") return;
		if (e.pointerType === "touch") {
			this.push({
				type: "touch",
				action: e.type === "pointercancel" ? "cancel" : "end",
				points: [],
			});
		} else {
			this.push({
				type: "mouse",
				action: "up",
				...this.pointOf(e),
				button: e.button === 2 ? "right" : e.button === 1 ? "middle" : "left",
				clickCount: Math.min(3, Math.max(1, e.detail || 1)),
				modifiers: modifiersOf(e),
			});
		}
	}

	private onWheel(e: WheelEvent): void {
		if (this.controller !== "user") return;
		e.preventDefault();
		const line = e.deltaMode === 1 ? 16 : 1;
		this.push({
			type: "mouse",
			action: "wheel",
			...this.pointOf(e),
			deltaX: e.deltaX * line,
			deltaY: e.deltaY * line,
			modifiers: modifiersOf(e),
		});
	}

	/**
	 * Typing goes through a (hidden) text field the surface owns, so a phone's keyboard, an IME and
	 * a paste all work: text is inserted as it comes, keys that are not text are sent as keys.
	 */
	attachKeyboard(field: HTMLTextAreaElement): () => void {
		const onKeyDown = (e: KeyboardEvent) => {
			if (this.controller !== "user" || e.isComposing) return;
			if (SPECIAL_KEYS.has(e.key)) {
				this.keyHandledAt = Date.now();
				e.preventDefault();
				const modifiers = modifiersOf(e);
				this.push({ type: "key", action: "down", key: e.key, modifiers });
				this.push({ type: "key", action: "up", key: e.key, modifiers });
			}
		};
		const onBeforeInput = (e: InputEvent) => {
			if (this.controller !== "user" || e.isComposing) return;
			const keyed = Date.now() - this.keyHandledAt < 80;
			const t = e.inputType;
			const key = (name: string) => {
				e.preventDefault();
				if (keyed) return;
				this.push({ type: "key", action: "down", key: name });
				this.push({ type: "key", action: "up", key: name });
			};
			if (t === "insertText" || t === "insertFromPaste" || t === "insertReplacementText") {
				e.preventDefault();
				const text = e.data ?? e.dataTransfer?.getData("text/plain") ?? "";
				if (text) this.push({ type: "text", text });
			} else if (t === "insertLineBreak" || t === "insertParagraph") key("Enter");
			else if (t === "deleteContentBackward") key("Backspace");
			else if (t === "deleteContentForward") key("Delete");
		};
		const onCompositionEnd = (e: CompositionEvent) => {
			if (this.controller !== "user") return;
			if (e.data) this.push({ type: "text", text: e.data });
			field.value = "";
		};
		field.addEventListener("keydown", onKeyDown);
		field.addEventListener("beforeinput", onBeforeInput as EventListener);
		field.addEventListener("compositionend", onCompositionEnd);
		const off = () => {
			field.removeEventListener("keydown", onKeyDown);
			field.removeEventListener("beforeinput", onBeforeInput as EventListener);
			field.removeEventListener("compositionend", onCompositionEnd);
		};
		this.detachers.push(off);
		return off;
	}
}

function parse<T>(event: Event): T | null {
	try {
		return JSON.parse((event as MessageEvent<string>).data) as T;
	} catch {
		return null;
	}
}
