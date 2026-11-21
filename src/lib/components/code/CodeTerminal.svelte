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
		const onDown = (e: PointerEvent): void => {
			active += 1;
			down =
				active === 1 && e.isPrimary
					? { id: e.pointerId, x: e.clientX, y: e.clientY, t: e.timeStamp }
					: null;
		};
		const onMove = (e: PointerEvent): void => {
			if (down && e.pointerId === down.id) {
				if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > TAP_SLOP) down = null;
			}
		};
		const onUp = (e: PointerEvent): void => {
			active = Math.max(0, active - 1);
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
		};
		// Capture: `blockXtermFocus` stops this event before the bubble phase.
		el.addEventListener("pointerdown", onDown, true);
		el.addEventListener("pointermove", onMove);
		el.addEventListener("pointerup", onUp);
		el.addEventListener("pointercancel", onCancel);
		return () => {
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
			});
			fitAddon = new FitAddon();
			term.loadAddon(fitAddon);
			term.loadAddon(new Unicode11Addon());
			term.loadAddon(new WebLinksAddon());
			term.unicode.activeVersion = "11";
			term.open(parent);
			fitAddon.fit();

			term.onData(handleTerminalData);
			term.onResize(({ cols, rows }) => sendResize(cols, rows));
			term.onScroll(updateScrolledUp);
			term.onWriteParsed(updateScrolledUp);
			term.buffer.onBufferChange(updateScrolledUp);
			term.attachCustomKeyEventHandler(customKeyEventHandler);
			term.onSelectionChange(() => (hasSelection = !!term?.hasSelection()));

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
			class="h-full touch-pan-x overscroll-contain bg-white p-1 dark:bg-gray-900"
		></div>
		<div class="absolute top-2 right-3 z-10 flex gap-1.5">
			{#if hasSelection}
				<button
					type="button"
					data-testid="terminal-copy-selection"
					aria-label={m["code.terminal.copy_selection"]()}
					class="btn flex h-8 items-center gap-1 rounded-md border bg-white px-2 text-xs shadow-sm hover:bg-gray-100 dark:border-gray-600 dark:bg-gray-700 dark:hover:bg-gray-600"
					onpointerdown={(e) => e.preventDefault()}
					onclick={copySelection}
				>
					<IconCopy class="size-3.5" />
					{m["code.terminal.copy_selection"]()}
				</button>
			{/if}
			<button
				type="button"
				data-testid="terminal-select-text"
				aria-label={m["code.terminal.select_text"]()}
				class="btn flex h-8 items-center gap-1 rounded-md border bg-white px-2 text-xs shadow-sm hover:bg-gray-100 dark:border-gray-600 dark:bg-gray-700 dark:hover:bg-gray-600"
				onclick={openCopyView}
			>
				<IconCopy class="size-3.5" />
				{m["code.terminal.select_text"]()}
			</button>
		</div>
		<ScrollToBottomBtn
			class="right-3 bottom-3 z-10"
			visible={scrolledUp}
			onclick={scrollToBottom}
		/>
		{#if copyOpen}
			<div
				role="dialog"
				aria-label={m["code.terminal.copy_title"]()}
				data-testid="terminal-copy-overlay"
				class="absolute inset-0 z-20 flex flex-col bg-white dark:bg-gray-900"
			>
				<div
					class="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-gray-200 bg-gray-50 p-1.5 dark:border-gray-700 dark:bg-gray-800"
				>
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
					<span
						role="status"
						class="min-w-0 flex-1 truncate text-xs text-gray-600 dark:text-gray-300"
					>
						{#if copyNote === "copied"}{m[
								"code.terminal.copied"
							]()}{:else if copyNote === "failed"}{m["code.terminal.copy_failed"]()}{:else}{m[
								"code.terminal.copy_hint"
							]()}{/if}
					</span>
					<button
						type="button"
						data-testid="terminal-copy-close"
						aria-label={m["code.terminal.copy_close"]()}
						class="btn flex size-8 items-center justify-center rounded-md border dark:border-gray-600"
						onclick={closeCopyView}
					>
						<IconClose class="size-4" />
					</button>
				</div>
				<!-- Plain DOM text: the OS long-press selection and copy menu work here. -->
				<pre
					bind:this={copyPre}
					data-testid="terminal-copy-text"
					class="m-0 min-h-0 flex-1 overflow-auto p-2 font-mono text-xs break-words whitespace-pre-wrap text-gray-900 select-text dark:text-gray-100">{copyText}</pre>
			</div>
		{/if}
	</div>
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
				span = 1
			)}
				<button
					type="button"
					aria-label={label}
					aria-pressed={pressed}
					class="flex h-8 min-w-0 items-center justify-center rounded-md text-xs {filled
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
			<!-- Three full rows of nine. Modifiers and motion first, then the
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
		</div>
	{/if}
</div>
