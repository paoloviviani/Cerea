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
	import { onDestroy } from "svelte";
	import IconWarning from "~icons/carbon/warning-filled";
	import IconRenew from "~icons/carbon/renew";
	import {
		mintTerminalTicket,
		terminalSocketUrl,
		TerminalReauthRequired,
	} from "$lib/codeApi";
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
		/** Bumped by the caller (e.g. after "Restart") to force a fresh mount. */
		mountKey?: number;
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
		socket.addEventListener("close", () => {
			if (ws !== socket) return; // a superseded socket closing, not this one
			ws = null;
			if (destroyed) return;
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

	$effect(() => {
		const parent = host;
		if (!parent) return;
		destroyed = false;
		void (async () => {
			const { Terminal, FitAddon, Unicode11Addon, WebLinksAddon } = await loadXterm();
			if (destroyed) return;
			term = new Terminal({
				fontFamily:
					'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
				fontSize: 13,
				cursorBlink: true,
				scrollback: 5000,
				allowProposedApi: true,
			});
			fitAddon = new FitAddon();
			term.loadAddon(fitAddon);
			term.loadAddon(new Unicode11Addon());
			term.loadAddon(new WebLinksAddon());
			term.unicode.activeVersion = "11";
			term.open(parent);
			fitAddon.fit();

			term.onData((data) => {
				if (ws?.readyState !== WebSocket.OPEN) return;
				ws.send(
					encodeTerminalFrame({
						kind: BIN_TERM_INPUT,
						channel: ackChannel,
						offset: 0,
						payload: new TextEncoder().encode(data),
					})
				);
			});
			term.onResize(({ cols, rows }) => sendResize(cols, rows));

			resizeObserver = new ResizeObserver(() => fitAddon?.fit());
			resizeObserver.observe(parent);

			void connect();
		})();

		return () => {
			destroyed = true;
			if (reconnectTimer) clearTimeout(reconnectTimer);
			resizeObserver?.disconnect();
			resizeObserver = null;
			ws?.close();
			ws = null;
			term?.dispose();
			term = null;
		};
	});

	onDestroy(() => {
		sendAckIfDue(true);
	});
</script>

<div class="relative flex h-full min-h-0 flex-col" data-testid="code-terminal">
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
</div>
