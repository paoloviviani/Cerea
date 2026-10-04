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
	import { flagCodeReauth } from "$lib/stores/codeReauth.svelte";
	import { MediaQuery } from "svelte/reactivity";
	import IconWarning from "~icons/carbon/warning-filled";
	import IconRenew from "~icons/carbon/renew";
	import { subscribeToTheme } from "$lib/switchTheme";
	import { mintTerminalTicket, terminalSocketUrl, TerminalReauthRequired } from "$lib/codeApi";
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
	// terminal plan): a terminal opens in view mode (touch-scroll only, no
	// keyboard) so an accidental tap never types into a shell. Desktop never
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
			failure = err instanceof Error ? err.message : "Could not connect.";
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

	/** Below the mobile breakpoint, in view mode: a tap must never reach
	 * xterm's own click-to-focus handling, wherever it is wired internally —
	 * capturing here, ahead of anything xterm attaches on a descendant, and
	 * `stopPropagation` so the event never continues to it. */
	function blockFocusInViewMode(e: Event): void {
		if (narrowViewport.current && !typingMode) {
			e.preventDefault();
			e.stopPropagation();
		}
	}

	function sendInputBytes(bytes: Uint8Array): void {
		if (ws?.readyState !== WebSocket.OPEN) return;
		ws.send(
			encodeTerminalFrame({ kind: BIN_TERM_INPUT, channel: ackChannel, offset: 0, payload: bytes })
		);
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

	function exitTypingMode(): void {
		typingMode = false;
		term?.textarea?.blur();
	}

	$effect(() => {
		const parent = host;
		if (!parent) return;
		destroyed = false;
		parent.addEventListener("pointerdown", blockFocusInViewMode, true);
		let textareaEl: HTMLTextAreaElement | null = null;
		const onTextareaBlur = () => {
			typingMode = false;
		};
		// A safety net alongside `blockFocusInViewMode`: if the textarea ever
		// receives focus while in view mode regardless (a path this component
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
			parent.removeEventListener("pointerdown", blockFocusInViewMode, true);
			textareaEl?.removeEventListener("blur", onTextareaBlur);
			textareaEl?.removeEventListener("focus", onTextareaFocus);
			if (reconnectTimer) clearTimeout(reconnectTimer);
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
			Reconnecting…
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
	<div bind:this={host} class="min-h-0 flex-1 bg-white p-1 dark:bg-gray-900"></div>
	{#if narrowViewport.current}
		<div
			role="toolbar"
			aria-label="Terminal keys"
			class="grid shrink-0 grid-cols-9 gap-1 border-t border-gray-200 bg-gray-50 p-1.5 dark:border-gray-700 dark:bg-gray-800"
		>
			{#snippet key(
				label: string,
				text: string,
				onclick: () => void,
				pressed?: boolean,
				wide = false
			)}
				<button
					type="button"
					aria-label={label}
					aria-pressed={pressed}
					class="flex h-8 min-w-0 items-center justify-center rounded-md text-xs {wide
						? 'col-span-2 bg-blue-600 font-medium text-white dark:bg-blue-500'
						: pressed
							? 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-200'
							: 'text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-700'}"
					onpointerdown={(e) => e.preventDefault()}
					{onclick}
				>
					{text}
				</button>
			{/snippet}
			{@render key("Escape", "Esc", () => sendKey("\x1b"))}
			{@render key("Tab", "Tab", () => sendKey("\t"))}
			{@render key("Control", "Ctrl", toggleCtrl, ctrlSticky)}
			{@render key("Alt", "Alt", toggleAlt, altSticky)}
			{@render key("Arrow up", "↑", () => sendArrow("A"))}
			{@render key("Arrow down", "↓", () => sendArrow("B"))}
			{@render key("Arrow left", "←", () => sendArrow("D"))}
			{@render key("Arrow right", "→", () => sendArrow("C"))}
			{@render key("Pipe", "|", () => sendKey("|"))}
			{@render key("Tilde", "~", () => sendKey("~"))}
			{@render key("Slash", "/", () => sendKey("/"))}
			{@render key("Hyphen", "-", () => sendKey("-"))}
			{@render key("Send Ctrl+C", "^C", () => sendControlByte(0x03))}
			{@render key("Send Ctrl+D", "^D", () => sendControlByte(0x04))}
			{@render key("Decrease font size", "A−", () => changeFontSize(-1))}
			{@render key("Increase font size", "A+", () => changeFontSize(1))}
			{#if typingMode}
				{@render key("Done", "Done", exitTypingMode, undefined, true)}
			{:else}
				{@render key("Type", "Type", enterTypingMode, undefined, true)}
			{/if}
		</div>
	{/if}
</div>
