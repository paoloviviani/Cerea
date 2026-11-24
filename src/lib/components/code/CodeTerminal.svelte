<!--
	One terminal's live view (ADR 0090, PROTOCOL.md §9): xterm.js, lazily
	imported so the chat bundle never pays for it unless a terminal opens.
	Owns exactly one browser WebSocket (ticket-authenticated,
	`terminalSocketUrl`) for its whole mounted lifetime — a fresh ticket and
	socket per reconnect, never a shared one across terminals or tabs.

	What this component does NOT do: resume logic beyond remembering the
	last offset it wrote (the server decides reset vs. resume, §9.3
	terminal.attach); credential/veto/acknowledgement gating (the caller,
	CodeTerminals.svelte, only mounts this once all of that has cleared).
-->
<script lang="ts">
	import { m } from "$lib/paraglide/messages";
	import { flagCodeReauth } from "$lib/stores/codeReauth.svelte";
	import { MediaQuery } from "svelte/reactivity";
	import { tick } from "svelte";
	import IconWarning from "~icons/carbon/warning-filled";
	import IconRenew from "~icons/carbon/renew";
	import IconCopy from "~icons/carbon/copy";
	import IconClose from "~icons/carbon/close";
	import { bufferToText, TERMINAL_TEXT_MAX_LINES } from "$lib/utils/terminalText";
	import ScrollToBottomBtn from "$lib/components/ScrollToBottomBtn.svelte";
	import { subscribeToTheme } from "$lib/switchTheme";
	import { mintTerminalTicket, terminalSocketUrl, TerminalReauthRequired } from "$lib/codeApi";
	import { isMacPlatform } from "$lib/utils/terminalSelectHint";
	import { terminalKeyAction } from "$lib/utils/terminalKeys";
	import {
		encodeTerminalFrame,
		decodeTerminalFrame,
		BIN_TERM_OUTPUT,
		BIN_TERM_INPUT,
		BIN_TERM_ACK,
	} from "$lib/utils/terminalBinary";
	import type { Terminal as XTerm } from "@xterm/xterm";
	import type { FitAddon } from "@xterm/addon-fit";

	interface Props {
		deviceId: string;
		terminalId: string;
		onexit?: (code: number) => void;
		/** The OIDC step-up failed: the caller shows its own "sign in again" affordance. */
		onreauth?: () => void;
	}

	let { deviceId, terminalId, onexit, onreauth }: Props = $props();

	let host = $state<HTMLDivElement>();
	let connectionState = $state<"connecting" | "open" | "reconnecting" | "offline" | "closed">(
		"connecting"
	);
	let failure = $state<string | null>(null);
	/** True while the viewport sits above the live bottom of the scrollback:
	 * drives the jump-to-bottom button (a phone has no scroll wheel or keys to
	 * get back down with). */
	let scrolledUp = $state(false);

	/** The copy overlay: the buffer as plain DOM text, where a phone's own
	 * long-press selection and copy menu work (xterm draws its own selection
	 * from mouse events, which a touch never produces). */
	let copyOpen = $state(false);
	let copyText = $state("");
	let hasSelection = $state(false);
	let copyNote = $state<"copied" | "failed" | null>(null);
	let copyNoteTimer: ReturnType<typeof setTimeout> | null = null;
	let copyPre = $state<HTMLPreElement>();

	let term: XTerm | null = null;
	let fitAddon: FitAddon | null = null;
	let ws: WebSocket | null = null;
	let destroyed = false;
	let lastOffset = 0;
	/** Bytes written to xterm since the last ack — flushed at 64 KiB, the
	 * credit unit the machine's flow control expects (PROTOCOL.md §9.2). */
	let unackedBytes = 0;
	let ackChannel = "b";
	let resizeObserver: ResizeObserver | null = null;
	let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

	// Below the mobile breakpoint the composer and side pane use (§2.4 of the
	// terminal plan): a swipe scrolls without a keyboard and a tap
	// (not a drag or long press) focuses the textarea to type. Desktop never
	// reads any of this — the guards below are gated on `narrowViewport`.
	const narrowViewport = new MediaQuery("(max-width: 639px)");
	const macSelectHint = typeof navigator !== "undefined" && isMacPlatform(navigator);
	let typingMode = $state(false);
	let ctrlSticky = $state(false);
	let altSticky = $state(false);
	const FONT_SIZE_MIN = 10;
	const FONT_SIZE_MAX = 22;
	let fontSize = $state(13);

	// A soft keyboard overlays the page rather than resizing it (iOS Safari,
	// Android Chrome's default), so the key bar would sit underneath it.
	// Lift the bar by however much of this component the keyboard covers.
	let root = $state<HTMLDivElement>();
	let keyboardInset = $state(0);
	$effect(() => {
		const vv = window.visualViewport;
		const el = root;
		if (!vv || !el || !narrowViewport.current) {
			keyboardInset = 0;
			return;
		}
		const update = () => {
			const visibleBottom = vv.offsetTop + vv.height;
			keyboardInset = Math.max(0, Math.round(el.getBoundingClientRect().bottom - visibleBottom));
		};
		update();
		vv.addEventListener("resize", update);
		vv.addEventListener("scroll", update);
		return () => {
			vv.removeEventListener("resize", update);
			vv.removeEventListener("scroll", update);
		};
	});

	// xterm renders its own colors regardless of the page's CSS — unlike
	// ordinary DOM content, `dark:` classes on the host div do nothing for
	// the text xterm draws, so the theme has to be handed to it explicitly.
	let isDark = $state(false);
	$effect(() => subscribeToTheme((theme) => (isDark = theme.isDark)));

	function xtermTheme(dark: boolean): { background: string; foreground: string; cursor: string } {
		return dark
			? { background: "#111827", foreground: "#e5e7eb", cursor: "#e5e7eb" }
			: { background: "#ffffff", foreground: "#111827", cursor: "#111827" };
	}

	const ACK_THRESHOLD = 64 * 1024;

	async function loadXterm() {
		const [{ Terminal }, { FitAddon }, { Unicode11Addon }, { WebLinksAddon }] = await Promise.all([
			import("@xterm/xterm"),
			import("@xterm/addon-fit"),
			import("@xterm/addon-unicode11"),
			import("@xterm/addon-web-links"),
		]);
		await import("@xterm/xterm/css/xterm.css");
		return { Terminal, FitAddon, Unicode11Addon, WebLinksAddon };
	}

	function sendAckIfDue(force = false): void {
		if (unackedBytes === 0) return;
		if (!force && unackedBytes < ACK_THRESHOLD) return;
		if (ws?.readyState !== WebSocket.OPEN) return;
		ws.send(
			encodeTerminalFrame({
				kind: BIN_TERM_ACK,
				channel: ackChannel,
				offset: lastOffset,
				payload: new Uint8Array(0),
			})
		);
		unackedBytes = 0;
	}

	function scheduleReconnect(): void {
		if (destroyed) return;
		connectionState = "reconnecting";
		if (reconnectTimer) return;
		reconnectTimer = setTimeout(() => {
			reconnectTimer = null;
			void connect();
		}, 1000);
	}

	async function connect(): Promise<void> {
		if (destroyed) return;
		failure = null;
		let ticket: string;
		try {
			ticket = await mintTerminalTicket(deviceId, terminalId);
		} catch (err) {
			if (err instanceof TerminalReauthRequired) {
				onreauth?.();
				return;
			}
			failure = err instanceof Error ? err.message : m["code.terminal.could_not_connect"]();
			scheduleReconnect();
			return;
		}
		if (destroyed) return;
		const socket = new WebSocket(terminalSocketUrl(ticket, lastOffset || undefined));
		socket.binaryType = "arraybuffer";
		ws = socket;
		socket.addEventListener("open", () => {
			connectionState = "open";
		});
		socket.addEventListener("close", (event) => {
			if (ws !== socket) return; // a superseded socket closing, not this one
			ws = null;
			if (destroyed) return;
			// The machine's re-check found the sign-in older than 7 days: not a
			// blip to reconnect through. The whole panel is stale now.
			if (event.code === 4403 && event.reason === "reauth_required") {
				flagCodeReauth();
				return;
			}
			scheduleReconnect();
		});
		socket.addEventListener("error", () => {
			/* the close handler that follows drives reconnection */
		});
		socket.addEventListener("message", (event) => {
			if (typeof event.data === "string") {
				handleControlMessage(event.data);
				return;
			}
			const frame = decodeTerminalFrame(event.data as ArrayBuffer);
			if (!frame || frame.kind !== BIN_TERM_OUTPUT || !term) return;
			lastOffset = frame.offset + frame.payload.length;
			unackedBytes += frame.payload.length;
			term.write(frame.payload);
			sendAckIfDue();
		});
	}

	function handleControlMessage(raw: string): void {
		let msg: { t?: string; code?: number; prelude?: string } | null = null;
		try {
			msg = JSON.parse(raw);
		} catch {
			return;
		}
		if (!msg || !term) return;
		switch (msg.t) {
			case "reset": {
				term.reset();
				unackedBytes = 0;
				if (msg.prelude) {
					const bytes = Uint8Array.from(atob(msg.prelude), (c) => c.charCodeAt(0));
					term.write(bytes);
				}
				connectionState = "open";
				break;
			}
			case "exit":
				connectionState = "closed";
				onexit?.(msg.code ?? 0);
				break;
			case "machine-offline":
				connectionState = "offline";
				break;
			case "machine-online":
				connectionState = "open";
				break;
		}
	}

	function sendResize(cols: number, rows: number): void {
		if (ws?.readyState !== WebSocket.OPEN) return;
		ws.send(JSON.stringify({ t: "resize", cols, rows, claim: true }));
	}

	// ---- Phone selection (long press) ---------------------------------------
	// xterm's own selection listens to mouse events, which a touch never
	// produces, so on a phone the selection is driven here with `term.select`
	// (which works whatever the app's mouse-tracking mode is, like Shift+drag
	// on desktop). The model is two inclusive cells in absolute buffer rows;
	// pixels map to cells through `.xterm-screen`'s rect divided by cols/rows.
	interface Cell {
		col: number;
		row: number;
	}
	interface SelUi {
		start: { x: number; y: number; show: boolean };
		end: { x: number; y: number; show: boolean };
		menuX: number;
		menuY: number;
	}
	const LONG_PRESS_MS = 450;
	const LONG_PRESS_SLOP = 6;
	const WORD_SEPARATORS = " ()[]{}',\"`";
	let selMode = $state(false);
	let selUi = $state<SelUi | null>(null);
	let selStart: Cell | null = null;
	let selEnd: Cell | null = null;
	/** True from a long press until the finger lifts: the touch scroll ignores it. */
	let longPressActive = false;
	let drag: { role: "start" | "end"; offY: number; x: number; y: number } | null = null;
	let dragTimer: ReturnType<typeof setInterval> | null = null;

	function geometry() {
		const screen = host?.querySelector(".xterm-screen");
		const wrap = host?.parentElement;
		if (!screen || !wrap || !term || term.cols < 1 || term.rows < 1) return null;
		const r = screen.getBoundingClientRect();
		const w = wrap.getBoundingClientRect();
		if (r.width <= 0 || r.height <= 0) return null;
		return {
			left: r.left,
			top: r.top,
			cw: r.width / term.cols,
			ch: r.height / term.rows,
			ox: r.left - w.left,
			oy: r.top - w.top,
			wrapW: w.width,
		};
	}

	/** The cell under a client point, clamped to the screen; row is absolute. */
	function cellAt(x: number, y: number): Cell | null {
		const g = geometry();
		if (!g || !term) return null;
		const col = Math.min(term.cols - 1, Math.max(0, Math.floor((x - g.left) / g.cw)));
		const vrow = Math.min(term.rows - 1, Math.max(0, Math.floor((y - g.top) / g.ch)));
		return { col, row: term.buffer.active.viewportY + vrow };
	}

	/** Word bounds around a cell, like a double click; null on whitespace. */
	function wordAt(cell: Cell): { start: Cell; end: Cell } | null {
		const line = term?.buffer.active.getLine(cell.row);
		if (!line || !term) return null;
		const chars: string[] = [];
		for (let c = 0; c < term.cols; c++) {
			const cc = line.getCell(c);
			// A wide character's second cell belongs to its first.
			chars.push(cc && cc.getWidth() === 0 && c > 0 ? chars[c - 1] : cc?.getChars() || " ");
		}
		const blank = (c: number) => chars[c].trim() === "";
		const sep = (c: number) => WORD_SEPARATORS.includes(chars[c]);
		if (blank(cell.col)) return null;
		let a = cell.col;
		let b = cell.col;
		if (!sep(cell.col)) {
			while (a > 0 && !blank(a - 1) && !sep(a - 1)) a--;
			while (b < chars.length - 1 && !blank(b + 1) && !sep(b + 1)) b++;
		}
		return { start: { col: a, row: cell.row }, end: { col: b, row: cell.row } };
	}

	function layoutSelection(): void {
		if (!selMode || !selStart || !selEnd || !term) return;
		const g = geometry();
		if (!g) return;
		const vy = term.buffer.active.viewportY;
		const last = vy + term.rows - 1;
		// Nothing of the selection is on screen any more (new output pushed it
		// away): the mode ends, unless a handle is being dragged.
		if (!drag && (selEnd.row < vy || selStart.row > last)) {
			exitSelection();
			return;
		}
		const startShow = selStart.row >= vy && selStart.row <= last;
		const endShow = selEnd.row >= vy && selEnd.row <= last;
		const topRow = Math.max(selStart.row, vy) - vy;
		const botRow = Math.min(selEnd.row, last) - vy;
		const menuW = 190;
		const midX =
			selStart.row === selEnd.row
				? g.ox + ((selStart.col + selEnd.col + 1) / 2) * g.cw
				: g.ox + (term.cols * g.cw) / 2;
		const above = g.oy + topRow * g.ch - 46;
		selUi = {
			start: {
				x: g.ox + selStart.col * g.cw,
				y: g.oy + (selStart.row - vy + 1) * g.ch,
				show: startShow,
			},
			end: {
				x: g.ox + (selEnd.col + 1) * g.cw,
				y: g.oy + (selEnd.row - vy + 1) * g.ch,
				show: endShow,
			},
			menuX: Math.min(g.wrapW - menuW / 2 - 4, Math.max(menuW / 2 + 4, midX)),
			menuY: above >= 0 ? above : g.oy + (botRow + 1) * g.ch + 40,
		};
	}

	function applySelection(): void {
		if (!term || !selStart || !selEnd) return;
		const len = (selEnd.row - selStart.row) * term.cols + selEnd.col - selStart.col + 1;
		term.select(selStart.col, selStart.row, Math.max(1, len));
		layoutSelection();
	}

	function startSelectionAt(x: number, y: number): boolean {
		const cell = cellAt(x, y);
		const word = cell && wordAt(cell);
		if (!word) return false;
		selStart = word.start;
		selEnd = word.end;
		selMode = true;
		applySelection();
		try {
			navigator.vibrate?.(10);
		} catch {
			/* haptics are optional */
		}
		return true;
	}

	function exitSelection(): void {
		if (!selMode) return;
		selMode = false;
		selStart = selEnd = null;
		selUi = null;
		drag = null;
		stopDragTimer();
		term?.clearSelection();
	}

	function selectAllFromMenu(): void {
		if (!term) return;
		selStart = { col: 0, row: 0 };
		selEnd = { col: term.cols - 1, row: term.buffer.active.length - 1 };
		applySelection();
	}

	async function copyFromMenu(): Promise<void> {
		const text = term?.getSelection() ?? "";
		const ok = text !== "" && (await writeClipboard(text));
		flashCopyNote(ok);
		if (ok) exitSelection();
	}

	function stopDragTimer(): void {
		if (dragTimer) clearInterval(dragTimer);
		dragTimer = null;
	}

	const cellOrder = (a: Cell, b: Cell): number => a.row - b.row || a.col - b.col;

	/** Moves the dragged end to the cell under the finger (less the grab
	 * offset); crossing the other end swaps the roles. */
	function updateDrag(): void {
		if (!drag || !selStart || !selEnd) return;
		const cell = cellAt(drag.x, drag.y - drag.offY);
		if (!cell) return;
		if (drag.role === "start") {
			const fixed = selEnd;
			if (cellOrder(cell, fixed) <= 0) selStart = cell;
			else {
				selStart = fixed;
				selEnd = cell;
				drag.role = "end";
			}
		} else {
			const fixed = selStart;
			if (cellOrder(cell, fixed) >= 0) selEnd = cell;
			else {
				selEnd = fixed;
				selStart = cell;
				drag.role = "start";
			}
		}
		applySelection();
	}

	function onHandleDown(e: PointerEvent, role: "start" | "end"): void {
		e.preventDefault();
		e.stopPropagation();
		const g = geometry();
		const cell = role === "start" ? selStart : selEnd;
		if (!g || !cell || !term) return;
		try {
			(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
		} catch {
			/* capture is a nicety: the handle still gets its own moves */
		}
		const centerY = g.top + (cell.row - term.buffer.active.viewportY + 0.5) * g.ch;
		drag = { role, offY: e.clientY - centerY, x: e.clientX, y: e.clientY };
		stopDragTimer();
		// Near the top or bottom edge the scrollback follows the finger.
		dragTimer = setInterval(() => {
			const gg = geometry();
			if (!drag || !gg || !term) return;
			const ty = drag.y - drag.offY;
			if (ty < gg.top + gg.ch) term.scrollLines(-1);
			else if (ty > gg.top + term.rows * gg.ch - gg.ch) term.scrollLines(1);
			else return;
			updateDrag();
		}, 60);
	}

	function onHandleMove(e: PointerEvent): void {
		if (!drag) return;
		e.preventDefault();
		drag.x = e.clientX;
		drag.y = e.clientY;
		updateDrag();
	}

	function onHandleUp(): void {
		drag = null;
		stopDragTimer();
		layoutSelection();
	}

	/** Below the mobile breakpoint a touch must never reach xterm's own
	 * click-to-focus handling, wherever it is wired internally: swipes scroll
	 * the scrollback without raising the keyboard. Capturing here, ahead of
	 * anything xterm attaches on a descendant, and `stopPropagation` so the
	 * event never continues to it. A tap is told from a drag by
	 * `attachTapToType`, which focuses the textarea itself. */
	function blockXtermFocus(e: Event): void {
		if (narrowViewport.current) {
			e.preventDefault();
			e.stopPropagation();
		}
	}

	/** A tap (one pointer, up within TAP_SLOP px of down and TAP_MAX_MS) focuses
	 * the xterm textarea so the keyboard opens. It runs synchronously inside
	 * the `pointerup` handler: iOS Safari only raises the keyboard for a focus
	 * made within a user gesture. A drag, a long press or a second finger
	 * never focuses. */
	function attachTapToType(el: HTMLElement): () => void {
		const TAP_SLOP = 10;
		const TAP_MAX_MS = 300;
		let down: { id: number; x: number; y: number; t: number } | null = null;
		let active = 0;
		let lpTimer: ReturnType<typeof setTimeout> | null = null;
		const clearLp = (): void => {
			if (lpTimer) clearTimeout(lpTimer);
			lpTimer = null;
		};
		const onDown = (e: PointerEvent): void => {
			active += 1;
			clearLp();
			// A touch while a selection is showing only ends it: it is neither
			// a tap to type nor the start of a new long press.
			if (selMode && narrowViewport.current) {
				exitSelection();
				down = null;
				return;
			}
			down =
				active === 1 && e.isPrimary
					? { id: e.pointerId, x: e.clientX, y: e.clientY, t: e.timeStamp }
					: null;
			if (down && narrowViewport.current) {
				const { x, y } = down;
				lpTimer = setTimeout(() => {
					lpTimer = null;
					if (!down || !narrowViewport.current) return;
					down = null;
					longPressActive = startSelectionAt(x, y);
				}, LONG_PRESS_MS);
			}
		};
		const onMove = (e: PointerEvent): void => {
			if (down && e.pointerId === down.id) {
				const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
				if (moved > LONG_PRESS_SLOP) clearLp();
				if (moved > TAP_SLOP) down = null;
			}
		};
		const onUp = (e: PointerEvent): void => {
			active = Math.max(0, active - 1);
			clearLp();
			const d = down;
			down = null;
			if (!d || e.pointerId !== d.id || !narrowViewport.current) return;
			if (e.timeStamp - d.t > TAP_MAX_MS) return;
			if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > TAP_SLOP) return;
			enterTypingMode();
		};
		const onCancel = (): void => {
			active = Math.max(0, active - 1);
			down = null;
			clearLp();
		};
		const onContextMenu = (e: Event): void => {
			if (narrowViewport.current) e.preventDefault();
		};
		// Capture: `blockXtermFocus` stops this event before the bubble phase.
		el.addEventListener("pointerdown", onDown, true);
		el.addEventListener("pointermove", onMove);
		el.addEventListener("pointerup", onUp);
		el.addEventListener("pointercancel", onCancel);
		el.addEventListener("contextmenu", onContextMenu);
		return () => {
			clearLp();
			el.removeEventListener("contextmenu", onContextMenu);
			el.removeEventListener("pointerdown", onDown, true);
			el.removeEventListener("pointermove", onMove);
			el.removeEventListener("pointerup", onUp);
			el.removeEventListener("pointercancel", onCancel);
		};
	}

	function updateScrolledUp(): void {
		const buf = term?.buffer.active;
		scrolledUp = !!buf && buf.type === "normal" && buf.viewportY < buf.baseY;
	}

	/**
	 * Touch scrolling. xterm.js has none: a vertical swipe on a phone does
	 * nothing, or is taken by the page. A swipe becomes `scrollLines` on the
	 * normal buffer (finger delta over row height, with momentum after the
	 * finger lifts) and, on the alternate screen (vim, less, tmux), synthetic
	 * wheel events on xterm's own element, which xterm turns into mouse-wheel
	 * reports when the app asked for mouse tracking and into arrow keys when it
	 * did not — exactly what a real wheel does there. Taps are untouched: we
	 * only take over (preventDefault) once the finger has moved past a slop.
	 */
	let stopTouchMomentum: () => void = () => {};

	function attachTouchScroll(el: HTMLElement): () => void {
		const SLOP = 6;
		let startY = 0;
		let startX = 0;
		let lastY = 0;
		let lastT = 0;
		let velocity = 0; // px per ms, positive = finger moving down
		let scrolling = false;
		let tracking = false;
		let remainder = 0; // fractional rows not yet applied
		let raf = 0;

		const rowHeight = (): number => {
			const screen = el.querySelector(".xterm-screen");
			const h = screen?.getBoundingClientRect().height ?? 0;
			return term && term.rows > 0 && h > 0 ? h / term.rows : 16;
		};

		/** Positive px = finger moved down = content moves down = history. */
		const apply = (px: number): void => {
			if (!term) return;
			remainder += px / rowHeight();
			const rows = Math.trunc(remainder);
			if (rows === 0) return;
			remainder -= rows;
			if (term.buffer.active.type === "alternate") {
				const screen = el.querySelector(".xterm-screen") ?? el;
				const rect = screen.getBoundingClientRect();
				for (let i = 0; i < Math.abs(rows); i++) {
					screen.dispatchEvent(
						new WheelEvent("wheel", {
							deltaY: rows > 0 ? -rowHeight() : rowHeight(),
							deltaMode: 0,
							clientX: rect.left + rect.width / 2,
							clientY: rect.top + rect.height / 2,
							bubbles: true,
							cancelable: true,
						})
					);
				}
			} else {
				term.scrollLines(-rows);
			}
		};

		const stopMomentum = (): void => {
			if (raf) cancelAnimationFrame(raf);
			raf = 0;
		};

		stopTouchMomentum = stopMomentum;

		const onStart = (e: TouchEvent): void => {
			stopMomentum();
			longPressActive = false;
			if (e.touches.length !== 1) {
				tracking = false;
				return;
			}
			tracking = true;
			scrolling = false;
			remainder = 0;
			velocity = 0;
			startY = lastY = e.touches[0].clientY;
			startX = e.touches[0].clientX;
			lastT = e.timeStamp;
		};

		const onMove = (e: TouchEvent): void => {
			if (!tracking || e.touches.length !== 1) return;
			// A long press began a selection: this finger does not scroll.
			if (longPressActive) {
				e.preventDefault();
				return;
			}
			const t = e.touches[0];
			if (!scrolling) {
				const dy = Math.abs(t.clientY - startY);
				const dx = Math.abs(t.clientX - startX);
				// A mostly-horizontal gesture stays the page's (touch-action: pan-x).
				if (dy < SLOP || dx > dy) return;
				scrolling = true;
				lastY = t.clientY;
			}
			e.preventDefault();
			const dy = t.clientY - lastY;
			const dt = Math.max(1, e.timeStamp - lastT);
			velocity = 0.8 * (dy / dt) + 0.2 * velocity;
			lastY = t.clientY;
			lastT = e.timeStamp;
			apply(dy);
		};

		const onEnd = (e: TouchEvent): void => {
			if (!tracking) return;
			tracking = false;
			if (longPressActive) {
				// Swallow the click the finished long press would synthesise.
				longPressActive = false;
				e.preventDefault();
				return;
			}
			if (!scrolling) return;
			// Swallow the click a finished swipe would otherwise synthesise.
			e.preventDefault();
			if (e.timeStamp - lastT > 100 || Math.abs(velocity) < 0.15) return;
			let prev = performance.now();
			const step = (now: number): void => {
				const dt = now - prev;
				prev = now;
				apply(velocity * dt);
				velocity *= Math.pow(0.995, dt);
				raf = Math.abs(velocity) > 0.02 ? requestAnimationFrame(step) : 0;
			};
			raf = requestAnimationFrame(step);
		};

		const onCancel = (): void => {
			tracking = false;
			longPressActive = false;
			stopMomentum();
		};

		el.addEventListener("touchstart", onStart, { passive: true });
		el.addEventListener("touchmove", onMove, { passive: false });
		el.addEventListener("touchend", onEnd, { passive: false });
		el.addEventListener("touchcancel", onCancel, { passive: true });
		return () => {
			stopMomentum();
			el.removeEventListener("touchstart", onStart);
			el.removeEventListener("touchmove", onMove);
			el.removeEventListener("touchend", onEnd);
			el.removeEventListener("touchcancel", onCancel);
		};
	}

	/** Clipboard write: the async API first (needs a user gesture and a secure
	 * context), then a hidden textarea + execCommand for the cases it refuses. */
	async function writeClipboard(text: string): Promise<boolean> {
		try {
			if (navigator.clipboard?.writeText) {
				await navigator.clipboard.writeText(text);
				return true;
			}
		} catch {
			/* fall through to the legacy path */
		}
		const ta = document.createElement("textarea");
		ta.value = text;
		ta.setAttribute("readonly", "");
		ta.style.position = "fixed";
		ta.style.opacity = "0";
		(copyPre?.parentElement ?? document.body).appendChild(ta);
		ta.select();
		try {
			return document.execCommand("copy");
		} catch {
			return false;
		} finally {
			ta.remove();
		}
	}

	function flashCopyNote(ok: boolean): void {
		copyNote = ok ? "copied" : "failed";
		if (copyNoteTimer) clearTimeout(copyNoteTimer);
		copyNoteTimer = setTimeout(() => (copyNote = null), 2000);
	}

	async function copyAndNote(text: string): Promise<void> {
		flashCopyNote(text !== "" && (await writeClipboard(text)));
	}

	function visibleScreenText(): string {
		const buf = term?.buffer.active;
		if (!buf || !term) return "";
		return bufferToText(buf, { startRow: buf.viewportY, endRow: buf.viewportY + term.rows });
	}

	function openCopyView(): void {
		exitSelection();
		const buf = term?.buffer.active;
		if (!buf) return;
		copyText = bufferToText(buf, { maxLines: TERMINAL_TEXT_MAX_LINES });
		copyNote = null;
		copyOpen = true;
		// The terminal stays mounted underneath, so its scroll position is
		// untouched; the overlay opens at the newest output.
		void tick().then(() => {
			if (copyPre) copyPre.scrollTop = copyPre.scrollHeight;
		});
	}

	function closeCopyView(): void {
		copyOpen = false;
		copyNote = null;
	}

	function copySelection(): void {
		void copyAndNote(term?.getSelection() ?? "");
		exitSelection();
	}

	function scrollToBottom(): void {
		stopTouchMomentum();
		term?.scrollToBottom();
		updateScrolledUp();
	}

	function sendInputBytes(bytes: Uint8Array): void {
		if (ws?.readyState !== WebSocket.OPEN) return;
		ws.send(
			encodeTerminalFrame({ kind: BIN_TERM_INPUT, channel: ackChannel, offset: 0, payload: bytes })
		);
	}

	/**
	 * Copy and paste are wired by hand because xterm's defaults swallow the
	 * browser's machinery: Ctrl+C always reaches the shell as SIGINT (even
	 * over a selection) and Ctrl+V reaches it as ^V, cancel() having
	 * suppressed the copy and paste events either way. The decision matrix
	 * lives in `$lib/utils/terminalKeys`; the two "let the browser" answers
	 * step aside without preventDefault so the events fire onto xterm's own
	 * copy/paste listeners, and the manual chord writes the clipboard here.
	 */
	const isMac = /Mac|iPhone|iPad|iPod/.test(navigator.userAgent);

	function customKeyEventHandler(ev: KeyboardEvent): boolean {
		switch (
			terminalKeyAction({
				type: ev.type,
				key: ev.key,
				ctrlKey: ev.ctrlKey,
				shiftKey: ev.shiftKey,
				altKey: ev.altKey,
				metaKey: ev.metaKey,
				isMac,
				hasSelection: !!term?.hasSelection(),
			})
		) {
			case "passthrough":
				return true;
			case "letBrowserCopy":
			case "letBrowserPaste":
				return false;
			case "copySelection": {
				ev.preventDefault();
				const selection = term?.getSelection() ?? "";
				if (selection) void navigator.clipboard?.writeText(selection);
				return false;
			}
		}
	}

	/** The one path all typed input takes, real keystrokes and the extra-keys
	 * bar alike (the bar feeds it via `term.input(data, false)`, xterm's own
	 * "as if typed" API). Sticky Ctrl/Alt apply here, to whatever key comes
	 * next, then release — one shot, same as a real sticky-modifier keyboard. */
	function handleTerminalData(data: string): void {
		exitSelection();
		let bytes: Uint8Array;
		if (ctrlSticky) {
			ctrlSticky = false;
			bytes =
				data.length === 1
					? new Uint8Array([data.charCodeAt(0) & 0x1f])
					: new TextEncoder().encode(data);
		} else if (altSticky) {
			altSticky = false;
			bytes = new Uint8Array([0x1b, ...new TextEncoder().encode(data)]);
		} else {
			bytes = new TextEncoder().encode(data);
		}
		sendInputBytes(bytes);
	}

	function sendKey(data: string): void {
		term?.input(data, false);
	}

	function sendArrow(letter: "A" | "B" | "C" | "D"): void {
		const prefix = term?.modes.applicationCursorKeysMode ? "\x1bO" : "\x1b[";
		sendKey(prefix + letter);
	}

	/** Bypasses sticky Ctrl/Alt entirely: a fixed shortcut, not a modifier
	 * applied to "the next key". */
	function sendControlByte(byte: number): void {
		sendInputBytes(new Uint8Array([byte]));
	}

	/** One tap from the key bar: clipboard read needs a user gesture, which a
	 * button press is — the soft keyboard's own paste was the only path before.
	 * Read refusal (permission denied, insecure origin) pastes nothing. */
	async function pasteFromClipboard(): Promise<void> {
		try {
			const text = await navigator.clipboard?.readText();
			if (text) sendInputBytes(new TextEncoder().encode(text));
		} catch {
			/* the clipboard read was refused; there is nothing to paste */
		}
	}

	function toggleCtrl(): void {
		ctrlSticky = !ctrlSticky;
		if (ctrlSticky) altSticky = false;
	}

	function toggleAlt(): void {
		altSticky = !altSticky;
		if (altSticky) ctrlSticky = false;
	}

	function changeFontSize(delta: number): void {
		if (!term || !fitAddon) return;
		fontSize = Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, fontSize + delta));
		term.options.fontSize = fontSize;
		fitAddon.fit();
	}

	function enterTypingMode(): void {
		typingMode = true;
		term?.textarea?.focus();
	}

	$effect(() => {
		const parent = host;
		if (!parent) return;
		destroyed = false;
		parent.addEventListener("pointerdown", blockXtermFocus, true);
		const detachTapToType = attachTapToType(parent);
		let textareaEl: HTMLTextAreaElement | null = null;
		const detachTouchScroll = attachTouchScroll(parent);
		const onTextareaBlur = () => {
			typingMode = false;
		};
		// A safety net alongside `blockXtermFocus`: if the textarea ever
		// receives focus without a tap on this component regardless (a path this component
		// didn't anticipate), it is handed straight back, before a soft
		// keyboard has a chance to animate in.
		const onTextareaFocus = () => {
			if (narrowViewport.current && !typingMode) textareaEl?.blur();
		};
		void (async () => {
			const { Terminal, FitAddon, Unicode11Addon, WebLinksAddon } = await loadXterm();
			if (destroyed) return;
			term = new Terminal({
				fontFamily:
					'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
				fontSize,
				cursorBlink: true,
				scrollback: 5000,
				allowProposedApi: true,
				theme: xtermTheme(isDark),
				macOptionClickForcesSelection: true,
			});
			fitAddon = new FitAddon();
			term.loadAddon(fitAddon);
			term.loadAddon(new Unicode11Addon());
			term.loadAddon(new WebLinksAddon());
			term.unicode.activeVersion = "11";
			term.open(parent);
			fitAddon.fit();

			term.onData(handleTerminalData);
			term.onResize(({ cols, rows }) => {
				sendResize(cols, rows);
				exitSelection();
			});
			term.onScroll(() => {
				updateScrolledUp();
				layoutSelection();
			});
			term.onWriteParsed(() => {
				updateScrolledUp();
				layoutSelection();
			});
			term.buffer.onBufferChange(updateScrolledUp);
			term.attachCustomKeyEventHandler(customKeyEventHandler);
			term.onSelectionChange(() => {
				hasSelection = !!term?.hasSelection();
				if (selMode && !hasSelection) exitSelection();
			});

			textareaEl = term.textarea ?? null;
			textareaEl?.addEventListener("blur", onTextareaBlur);
			textareaEl?.addEventListener("focus", onTextareaFocus);

			resizeObserver = new ResizeObserver(() => fitAddon?.fit());
			resizeObserver.observe(parent);

			void connect();
		})();

		return () => {
			// The final partial window, before anything below drops the
			// socket — `onDestroy` would be too late to rely on here (its
			// order relative to this cleanup isn't something to build on).
			sendAckIfDue(true);
			destroyed = true;
			stopDragTimer();
			parent.removeEventListener("pointerdown", blockXtermFocus, true);
			detachTapToType();
			detachTouchScroll();
			textareaEl?.removeEventListener("blur", onTextareaBlur);
			textareaEl?.removeEventListener("focus", onTextareaFocus);
			if (reconnectTimer) clearTimeout(reconnectTimer);
			if (copyNoteTimer) clearTimeout(copyNoteTimer);
			resizeObserver?.disconnect();
			resizeObserver = null;
			ws?.close();
			ws = null;
			term?.dispose();
			term = null;
		};
	});

	$effect(() => {
		const dark = isDark;
		if (term) term.options.theme = xtermTheme(dark);
	});
</script>

<div
	bind:this={root}
	class="relative flex h-full min-h-0 flex-col"
	style:padding-bottom={keyboardInset ? `${keyboardInset}px` : undefined}
	data-testid="code-terminal"
>
	{#if connectionState === "offline" || connectionState === "reconnecting"}
		<div
			class="flex items-center gap-1.5 border-b border-amber-200 bg-amber-50 px-3 py-1 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300"
		>
			<IconRenew class="size-3.5 animate-spin" />
			{m["code.terminal.reconnecting"]()}
		</div>
	{/if}
	{#if failure}
		<div
			class="flex items-center gap-1.5 border-b border-red-200 bg-red-50 px-3 py-1 text-xs text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300"
		>
			<IconWarning class="size-3.5" />
			{failure}
		</div>
	{/if}
	<div class="relative min-h-0 flex-1">
		<!-- touch-action: pan-x — vertical swipes are ours (attachTouchScroll),
		     horizontal ones stay the page's. -->
		<div
			bind:this={host}
			class="h-full touch-pan-x overscroll-contain bg-white p-1 dark:bg-gray-900 {narrowViewport.current
				? 'select-none [-webkit-touch-callout:none]'
				: ''}"
		></div>
		<ScrollToBottomBtn
			class="right-3 bottom-3 z-10"
			visible={scrolledUp}
			onclick={scrollToBottom}
		/>
		{#if narrowViewport.current && selMode && selUi}
			<!-- Phone selection: handles at both ends and a Copy / Select all bar.
			     Pointer events reach only the handles and the bar. -->
			<div class="pointer-events-none absolute inset-0 z-10" data-testid="terminal-selection">
				{#each [{ role: "start", pos: selUi.start }, { role: "end", pos: selUi.end }] as h (h.role)}
					{#if h.pos.show}
						<button
							type="button"
							tabindex="-1"
							aria-label={h.role === "start"
								? m["code.terminal.handle_start"]()
								: m["code.terminal.handle_end"]()}
							data-testid="terminal-handle-{h.role}"
							class="pointer-events-auto absolute flex size-8 touch-none items-start {h.role ===
							'start'
								? 'justify-end pr-2'
								: 'justify-start pl-2'}"
							style:left="{h.pos.x - (h.role === 'start' ? 24 : 8)}px"
							style:top="{h.pos.y}px"
							onpointerdown={(e) => onHandleDown(e, h.role as "start" | "end")}
							onpointermove={onHandleMove}
							onpointerup={onHandleUp}
							onpointercancel={onHandleUp}
						>
							<span
								class="block size-4 bg-blue-500 {h.role === 'start'
									? 'rounded-[50%_0_50%_50%]'
									: 'rounded-[0_50%_50%_50%]'}"
							></span>
						</button>
					{/if}
				{/each}
				<div
					role="toolbar"
					aria-label={m["code.terminal.selection_menu"]()}
					data-testid="terminal-selection-menu"
					class="pointer-events-auto absolute flex -translate-x-1/2 items-center gap-1 rounded-lg border border-gray-200 bg-white p-1 text-xs shadow-lg dark:border-gray-600 dark:bg-gray-800"
					style:left="{selUi.menuX}px"
					style:top="{selUi.menuY}px"
				>
					<button
						type="button"
						data-testid="terminal-selection-copy"
						class="btn h-8 rounded-md bg-blue-600 px-3 text-xs font-medium text-white dark:bg-blue-500"
						onpointerdown={(e) => e.preventDefault()}
						onclick={() => void copyFromMenu()}
					>
						{m["code.terminal.copy_menu"]()}
					</button>
					<button
						type="button"
						data-testid="terminal-selection-all"
						class="btn h-8 rounded-md px-3 text-xs text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-700"
						onpointerdown={(e) => e.preventDefault()}
						onclick={selectAllFromMenu}
					>
						{m["code.terminal.select_all"]()}
					</button>
				</div>
			</div>
		{/if}
		{#if copyOpen}
			<div
				role="dialog"
				aria-label={m["code.terminal.copy_title"]()}
				data-testid="terminal-copy-overlay"
				class="absolute inset-0 z-20 flex flex-col bg-white dark:bg-gray-900"
			>
				<div
					class="shrink-0 border-b border-gray-200 bg-gray-50 p-1.5 dark:border-gray-700 dark:bg-gray-800"
				>
					<div class="flex items-center gap-1.5">
						<button
							type="button"
							data-testid="terminal-copy-all"
							class="btn h-8 rounded-md bg-blue-600 px-2.5 text-xs font-medium text-white dark:bg-blue-500"
							onclick={() => void copyAndNote(copyText)}
						>
							{m["code.terminal.copy_all"]()}
						</button>
						<button
							type="button"
							data-testid="terminal-copy-visible"
							class="btn h-8 rounded-md border px-2.5 text-xs dark:border-gray-600"
							onclick={() => void copyAndNote(visibleScreenText())}
						>
							{m["code.terminal.copy_visible"]()}
						</button>
						<button
							type="button"
							data-testid="terminal-copy-close"
							aria-label={m["code.terminal.copy_close"]()}
							class="ml-auto btn flex size-8 shrink-0 items-center justify-center rounded-md border dark:border-gray-600"
							onclick={closeCopyView}
						>
							<IconClose class="size-4" />
						</button>
					</div>
					<span role="status" class="mt-1.5 block text-xs text-gray-600 dark:text-gray-300">
						{#if copyNote === "copied"}{m[
								"code.terminal.copied"
							]()}{:else if copyNote === "failed"}{m["code.terminal.copy_failed"]()}{:else}{m[
								"code.terminal.copy_hint"
							]()}{/if}
					</span>
				</div>
				<!-- Plain DOM text: the OS long-press selection and copy menu work here. -->
				<pre
					bind:this={copyPre}
					data-testid="terminal-copy-text"
					class="m-0 min-h-0 flex-1 overflow-auto p-2 font-mono text-xs break-words whitespace-pre-wrap text-gray-900 select-text dark:text-gray-100">{copyText}</pre>
			</div>
		{/if}
	</div>
	{#if !narrowViewport.current}
		<!-- Nothing floats over the output: selection lives in this slim bar. -->
		<div
			class="flex h-8 shrink-0 items-center gap-1.5 border-t border-gray-200 bg-gray-50 px-1.5 text-xs dark:border-gray-700 dark:bg-gray-800"
		>
			<button
				type="button"
				data-testid="terminal-select-text"
				aria-label={m["code.terminal.select_text"]()}
				class="btn flex h-6 items-center gap-1 rounded-md border bg-white px-2 text-xs hover:bg-gray-100 dark:border-gray-600 dark:bg-gray-700 dark:hover:bg-gray-600"
				onclick={openCopyView}
			>
				<IconCopy class="size-3.5" />
				{m["code.terminal.select_text"]()}
			</button>
			{#if hasSelection}
				<button
					type="button"
					data-testid="terminal-copy-selection"
					aria-label={m["code.terminal.copy_selection"]()}
					class="btn flex h-6 items-center gap-1 rounded-md border bg-white px-2 text-xs hover:bg-gray-100 dark:border-gray-600 dark:bg-gray-700 dark:hover:bg-gray-600"
					onpointerdown={(e) => e.preventDefault()}
					onclick={copySelection}
				>
					<IconCopy class="size-3.5" />
					{m["code.terminal.copy_selection"]()}
				</button>
			{/if}
			<span class="ml-auto min-w-0 truncate text-gray-500 dark:text-gray-400">
				{macSelectHint ? m["code.terminal.select_hint_mac"]() : m["code.terminal.select_hint"]()}
			</span>
		</div>
	{/if}
	{#if narrowViewport.current}
		<div
			role="toolbar"
			aria-label={m["code.terminal.keys_label"]()}
			class="grid shrink-0 grid-cols-9 gap-1 border-t border-gray-200 bg-gray-50 p-1.5 dark:border-gray-700 dark:bg-gray-800"
		>
			{#snippet key(
				label: string,
				text: string,
				onclick: () => void,
				pressed?: boolean,
				filled = false,
				span = 1,
				extra: { testid?: string; disabled?: boolean } = {}
			)}
				<button
					type="button"
					aria-label={label}
					aria-pressed={pressed}
					data-testid={extra.testid}
					disabled={extra.disabled}
					class="flex h-8 min-w-0 items-center justify-center rounded-md text-xs disabled:opacity-40 {filled
						? 'bg-blue-600 font-medium text-white dark:bg-blue-500'
						: pressed
							? 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-200'
							: 'text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-700'} {span ===
					3
						? 'col-span-3'
						: span === 2
							? 'col-span-2'
							: ''}"
					onpointerdown={(e) => e.preventDefault()}
					{onclick}
				>
					{text}
				</button>
			{/snippet}
			<!-- i18n: literal (Esc, Tab, Ctrl, Alt are the keycaps printed on a keyboard) -->
			<!-- Three full rows of nine; the last row ends with Select (two cells)
			     and Copy (one, disabled until xterm has a selection). Modifiers and motion first, then the
			     punctuation a shell actually asks for, then the control actions
			     and the font size. A tap on the terminal opens the keyboard. -->
			{@render key(m["code.terminal.key.escape"](), "Esc", () => sendKey("\x1b"))}
			{@render key(m["code.terminal.key.tab"](), "Tab", () => sendKey("\t"))}
			{@render key(m["code.terminal.key.control"](), "Ctrl", toggleCtrl, ctrlSticky)}
			{@render key(m["code.terminal.key.alt"](), "Alt", toggleAlt, altSticky)}
			{@render key(m["code.terminal.key.arrow_up"](), "↑", () => sendArrow("A"))}
			{@render key(m["code.terminal.key.arrow_down"](), "↓", () => sendArrow("B"))}
			{@render key(m["code.terminal.key.arrow_left"](), "←", () => sendArrow("D"))}
			{@render key(m["code.terminal.key.arrow_right"](), "→", () => sendArrow("C"))}
			{@render key(m["code.terminal.key.pipe"](), "|", () => sendKey("|"))}
			{@render key(m["code.terminal.key.tilde"](), "~", () => sendKey("~"))}
			{@render key(m["code.terminal.key.slash"](), "/", () => sendKey("/"))}
			{@render key(m["code.terminal.key.hyphen"](), "-", () => sendKey("-"))}
			{@render key(m["code.terminal.key.dollar"](), "$", () => sendKey("$"))}
			{@render key(m["code.terminal.key.redirect"](), ">", () => sendKey(">"))}
			{@render key(m["code.terminal.key.double_quote"](), '"', () => sendKey('"'))}
			{@render key(m["code.terminal.key.single_quote"](), "'", () => sendKey("'"))}
			{@render key(m["code.terminal.key.glob"](), "*", () => sendKey("*"))}
			{@render key(m["code.terminal.key.ampersand"](), "&", () => sendKey("&"))}
			{@render key(m["code.terminal.key.send_ctrl_c"](), "^C", () => sendControlByte(0x03))}
			{@render key(m["code.terminal.key.send_ctrl_d"](), "^D", () => sendControlByte(0x04))}
			{@render key(m["code.terminal.key.kill_line"](), "^U", () => sendControlByte(0x15))}
			{@render key(
				m["code.terminal.key.paste"](),
				m["code.terminal.key_text.paste"](),
				() => void pasteFromClipboard()
			)}
			{@render key(m["code.terminal.key.font_smaller"](), "A−", () => changeFontSize(-1))}
			{@render key(m["code.terminal.key.font_larger"](), "A+", () => changeFontSize(1))}
			{@render key(
				m["code.terminal.select_text"](),
				m["code.terminal.key_text.select"](),
				openCopyView,
				undefined,
				false,
				2,
				{ testid: "terminal-select-text" }
			)}
			{@render key(
				m["code.terminal.copy_selection"](),
				m["code.terminal.key_text.copy"](),
				copySelection,
				undefined,
				false,
				1,
				{ testid: "terminal-copy-selection", disabled: !hasSelection }
			)}
		</div>
	{/if}
</div>
