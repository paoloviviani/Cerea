<!--
	The live view of a running browse task (ADR 0116 phase 2a): the browser's page as frames
	(Server-Sent Events from `/api/v2/browse/live/<uuid>`), small in the browse card and full screen
	when enlarged, and the controls to take the browser over and hand it back.

	While the user has taken over, the sub-agent is paused on the server; what the user does here
	goes to the page as mouse, touch, special keys and text (`.../input`), in the page's own pixels
	(the frame's `w` x `h`). Nothing is kept: a frame is shown and replaced.

	`uuid` is the browse call's uuid; the card mounts this only while the task runs. `controlled` is
	the server's word (the card's update) that the user has the browser, which also covers a
	takeover made in the headed window.
-->
<script lang="ts">
	import { base } from "$app/paths";
	import { m } from "$lib/paraglide/messages";
	import CarbonClose from "~icons/carbon/close";
	import CarbonMaximize from "~icons/carbon/maximize";
	import CarbonKeyboard from "~icons/carbon/keyboard";
	import { onDestroy } from "svelte";

	interface Props {
		uuid: string;
		controlled?: boolean;
	}
	let { uuid, controlled = false }: Props = $props();

	type MouseButton = "left" | "middle" | "right";
	type LiveInput =
		| {
				type: "mouse";
				action: "move" | "down" | "up" | "wheel";
				x: number;
				y: number;
				button?: MouseButton;
				clickCount?: number;
				deltaX?: number;
				deltaY?: number;
				modifiers?: number;
		  }
		| {
				type: "touch";
				action: "start" | "move" | "end" | "cancel";
				points: Array<{ x: number; y: number; id?: number }>;
		  }
		| { type: "key"; action: "down" | "up"; key: string; modifiers?: number }
		| { type: "text"; text: string };

	let status = $state<"connecting" | "live" | "ended" | "unavailable">("connecting");
	let frame = $state<{ src: string; w: number; h: number } | null>(null);
	let controller = $state<"agent" | "user">("agent");
	let enlarged = $state(false);
	let message = $state<string | null>(null);
	let busy = $state(false);
	let keyboard = $state<HTMLTextAreaElement | null>(null);

	// The server's word wins when it says the user has the browser (a takeover in the window).
	$effect(() => {
		if (controlled) controller = "user";
	});

	/** The width the stream is asked for: a card thumbnail, or what a full screen can show. */
	const wanted = $derived(
		enlarged ? Math.min(1600, Math.round(window.innerWidth * (window.devicePixelRatio || 1))) : 480
	);

	$effect(() => {
		const url = `${base}/api/v2/browse/live/${encodeURIComponent(uuid)}?width=${wanted}`;
		const source = new EventSource(url);
		status = "connecting";
		source.addEventListener("frame", (event) => {
			try {
				const data = JSON.parse((event as MessageEvent<string>).data) as {
					data: string;
					w: number;
					h: number;
				};
				frame = { src: `data:image/jpeg;base64,${data.data}`, w: data.w, h: data.h };
				status = "live";
			} catch {
				// A damaged frame is skipped: the next one follows.
			}
		});
		source.addEventListener("control", (event) => {
			try {
				const data = JSON.parse((event as MessageEvent<string>).data) as {
					controller: "agent" | "user";
				};
				controller = data.controller;
			} catch {
				// ignored
			}
		});
		source.addEventListener("end", () => {
			status = "ended";
			source.close();
		});
		source.onerror = () => {
			// A refused stream (not running, not yours) closes for good: there is nothing to retry.
			if (source.readyState === 2 && status !== "ended") status = "unavailable";
		};
		return () => source.close();
	});

	// ---- takeover ---------------------------------------------------------------------------

	async function control(action: "takeover" | "handback") {
		busy = true;
		message = null;
		try {
			const response = await fetch(
				`${base}/api/v2/browse/live/${encodeURIComponent(uuid)}/control`,
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ action }),
				}
			);
			if (!response.ok) {
				const body = (await response.json().catch(() => null)) as { message?: string } | null;
				message = m["chat.browse.live.take_over_failed"]({
					message: body?.message ?? String(response.status),
				});
				return;
			}
			const body = (await response.json()) as { controller: "agent" | "user" };
			controller = body.controller;
			// Taking over on a phone wants the whole screen, and the keyboard.
			if (body.controller === "user") enlarged = true;
			else queue = [];
		} catch {
			message = m["chat.browse.live.take_over_failed"]({ message: "-" });
		} finally {
			busy = false;
		}
	}

	// ---- input ------------------------------------------------------------------------------

	let queue: LiveInput[] = [];
	let flushing = false;
	let timer: ReturnType<typeof setTimeout> | undefined;

	function push(event: LiveInput) {
		const last = queue.at(-1);
		// Many moves in a row are one move: the last place the pointer was.
		if (
			last &&
			event.type === "mouse" &&
			event.action === "move" &&
			last.type === "mouse" &&
			last.action === "move"
		) {
			queue[queue.length - 1] = event;
		} else if (
			last &&
			event.type === "touch" &&
			event.action === "move" &&
			last.type === "touch" &&
			last.action === "move"
		) {
			queue[queue.length - 1] = event;
		} else {
			queue.push(event);
		}
		timer ??= setTimeout(() => {
			timer = undefined;
			void flush();
		}, 30);
	}

	async function flush() {
		if (flushing) return;
		flushing = true;
		try {
			while (queue.length > 0) {
				const events = queue.splice(0, 64);
				try {
					const response = await fetch(
						`${base}/api/v2/browse/live/${encodeURIComponent(uuid)}/input`,
						{
							method: "POST",
							headers: { "content-type": "application/json" },
							body: JSON.stringify({ events }),
						}
					);
					if (response.status === 409) {
						// Not in control any more (handed back, or the task ended).
						controller = "agent";
						queue = [];
					} else if (response.status === 429) {
						await new Promise((resolve) => setTimeout(resolve, 250));
					}
				} catch {
					// A lost batch is a lost click: the user sees it did not happen and tries again.
				}
			}
		} finally {
			flushing = false;
		}
	}

	onDestroy(() => clearTimeout(timer));

	const modifiersOf = (e: {
		altKey: boolean;
		ctrlKey: boolean;
		metaKey: boolean;
		shiftKey: boolean;
	}) => (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);

	/** A point of the frame image in the page's own pixels. */
	function pointOf(e: { clientX: number; clientY: number }, target: HTMLElement) {
		const rect = target.getBoundingClientRect();
		const w = frame?.w ?? rect.width;
		const h = frame?.h ?? rect.height;
		const x = Math.min(w, Math.max(0, ((e.clientX - rect.left) / rect.width) * w));
		const y = Math.min(h, Math.max(0, ((e.clientY - rect.top) / rect.height) * h));
		return { x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 };
	}

	const buttonOf = (e: PointerEvent): MouseButton =>
		e.button === 2 ? "right" : e.button === 1 ? "middle" : "left";

	function onPointerDown(e: PointerEvent) {
		if (controller !== "user") return;
		const target = e.currentTarget as HTMLElement;
		target.setPointerCapture?.(e.pointerId);
		const at = pointOf(e, target);
		if (e.pointerType === "touch") {
			push({ type: "touch", action: "start", points: [{ ...at, id: 0 }] });
		} else {
			push({ type: "mouse", action: "move", ...at });
			push({
				type: "mouse",
				action: "down",
				...at,
				button: buttonOf(e),
				clickCount: Math.min(3, Math.max(1, e.detail || 1)),
				modifiers: modifiersOf(e),
			});
		}
		e.preventDefault();
	}

	function onPointerMove(e: PointerEvent) {
		if (controller !== "user") return;
		const at = pointOf(e, e.currentTarget as HTMLElement);
		if (e.pointerType === "touch") {
			if (e.buttons) push({ type: "touch", action: "move", points: [{ ...at, id: 0 }] });
		} else {
			push({ type: "mouse", action: "move", ...at, modifiers: modifiersOf(e) });
		}
	}

	function onPointerUp(e: PointerEvent) {
		if (controller !== "user") return;
		const at = pointOf(e, e.currentTarget as HTMLElement);
		if (e.pointerType === "touch") {
			push({ type: "touch", action: e.type === "pointercancel" ? "cancel" : "end", points: [] });
		} else {
			push({
				type: "mouse",
				action: "up",
				...at,
				button: buttonOf(e),
				clickCount: Math.min(3, Math.max(1, e.detail || 1)),
				modifiers: modifiersOf(e),
			});
		}
		// A tap is also how a phone's keyboard is asked for: it opens only from a user gesture.
		keyboard?.focus({ preventScroll: true });
	}

	function onWheel(e: WheelEvent) {
		if (controller !== "user") return;
		e.preventDefault();
		const line = e.deltaMode === 1 ? 16 : 1;
		push({
			type: "mouse",
			action: "wheel",
			...pointOf(e, e.currentTarget as HTMLElement),
			deltaX: e.deltaX * line,
			deltaY: e.deltaY * line,
			modifiers: modifiersOf(e),
		});
	}

	// Typing goes through a hidden field, so a phone's keyboard, an IME and a paste all work:
	// text is inserted as it comes, and the keys that are not text are sent as keys.
	const SPECIAL = new Set([
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
	let keyHandledAt = 0;

	function onKeyDown(e: KeyboardEvent) {
		if (controller !== "user" || e.isComposing) return;
		if (SPECIAL.has(e.key)) {
			keyHandledAt = Date.now();
			e.preventDefault();
			const modifiers = modifiersOf(e);
			push({ type: "key", action: "down", key: e.key, modifiers });
			push({ type: "key", action: "up", key: e.key, modifiers });
		}
	}

	function onBeforeInput(e: InputEvent) {
		if (controller !== "user" || e.isComposing) return;
		const type = e.inputType;
		// A real key already sent itself; a phone keyboard has no key event, only this.
		const keyed = Date.now() - keyHandledAt < 80;
		if (type === "insertText" || type === "insertFromPaste" || type === "insertReplacementText") {
			e.preventDefault();
			const text = e.data ?? e.dataTransfer?.getData("text/plain") ?? "";
			if (text) push({ type: "text", text });
		} else if (type === "insertLineBreak" || type === "insertParagraph") {
			e.preventDefault();
			if (!keyed) {
				push({ type: "key", action: "down", key: "Enter" });
				push({ type: "key", action: "up", key: "Enter" });
			}
		} else if (type === "deleteContentBackward" || type === "deleteContentForward") {
			e.preventDefault();
			const key = type === "deleteContentBackward" ? "Backspace" : "Delete";
			if (!keyed) {
				push({ type: "key", action: "down", key });
				push({ type: "key", action: "up", key });
			}
		}
	}

	function onCompositionEnd(e: CompositionEvent) {
		if (controller !== "user") return;
		if (e.data) push({ type: "text", text: e.data });
		(e.currentTarget as HTMLTextAreaElement).value = "";
	}

	function onWindowKey(e: KeyboardEvent) {
		if (e.key === "Escape" && enlarged && document.activeElement !== keyboard) enlarged = false;
	}
</script>

<svelte:window onkeydown={onWindowKey} />

{#snippet controls(big: boolean)}
	<div class="flex flex-wrap items-center gap-2" data-testid="browse-live-controls">
		{#if controller === "user"}
			<span class="text-xs text-amber-700 dark:text-amber-300" data-testid="browse-live-in-control">
				{m["chat.browse.live.in_control"]()}
			</span>
			<button
				type="button"
				class="rounded-md bg-gray-900 px-2.5 py-1 text-xs font-medium text-white hover:bg-gray-700 disabled:opacity-50 dark:bg-gray-100 dark:text-gray-900 dark:hover:bg-gray-300"
				disabled={busy}
				onclick={() => control("handback")}
				data-testid="browse-live-hand-back"
			>
				{m["chat.browse.live.hand_back"]()}
			</button>
			{#if big}
				<button
					type="button"
					class="inline-flex items-center gap-1 rounded-md border border-gray-300 px-2 py-1 text-xs text-gray-700 hover:bg-gray-100 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-800"
					onclick={() => keyboard?.focus({ preventScroll: true })}
					data-testid="browse-live-keyboard"
				>
					<CarbonKeyboard class="size-3.5" />
					{m["chat.browse.live.keyboard"]()}
				</button>
			{/if}
		{:else}
			<button
				type="button"
				class="rounded-md bg-gray-900 px-2.5 py-1 text-xs font-medium text-white hover:bg-gray-700 disabled:opacity-50 dark:bg-gray-100 dark:text-gray-900 dark:hover:bg-gray-300"
				disabled={busy || status !== "live"}
				onclick={() => control("takeover")}
				data-testid="browse-live-take-over"
			>
				{m["chat.browse.live.take_over"]()}
			</button>
		{/if}
		{#if message}
			<span class="text-xs text-amber-700 dark:text-amber-300" data-testid="browse-live-message">
				{message}
			</span>
		{/if}
	</div>
{/snippet}

{#if status !== "ended" && status !== "unavailable"}
	<div class="flex flex-col gap-1.5" data-testid="browse-live" data-controller={controller}>
		<span class="text-xs text-gray-500 dark:text-gray-400">{m["chat.browse.live.title"]()}</span>
		{#if frame}
			<button
				type="button"
				class="group relative block w-full max-w-sm cursor-zoom-in overflow-hidden rounded-md border border-gray-200 bg-white p-0 dark:border-gray-700"
				onclick={() => (enlarged = true)}
				aria-label={m["chat.browse.live.enlarge"]()}
				data-testid="browse-live-thumbnail"
			>
				<img
					src={frame.src}
					alt={m["chat.browse.live.image_alt"]()}
					class="block h-auto w-full"
					draggable="false"
				/>
				<span
					class="absolute top-1 right-1 rounded bg-black/50 p-1 text-white opacity-80 group-hover:opacity-100"
					aria-hidden="true"><CarbonMaximize class="size-3.5" /></span
				>
			</button>
		{:else}
			<p class="text-xs text-gray-500 dark:text-gray-400" data-testid="browse-live-connecting">
				{m["chat.browse.live.connecting"]()}
			</p>
		{/if}
		{@render controls(false)}
	</div>
{:else if status === "ended"}
	<p class="text-xs text-gray-500 dark:text-gray-400" data-testid="browse-live-ended">
		{m["chat.browse.live.ended"]()}
	</p>
{/if}

{#if enlarged && status !== "ended" && status !== "unavailable"}
	<div
		class="fixed inset-0 z-50 flex flex-col bg-black/90 text-white"
		role="dialog"
		aria-modal="true"
		aria-label={m["chat.browse.live.screen_label"]()}
		data-testid="browse-live-screen"
	>
		<div
			class="flex items-center justify-between gap-2 bg-white px-3 py-2 text-gray-900 dark:bg-gray-900 dark:text-gray-100"
		>
			{@render controls(true)}
			<button
				type="button"
				class="ml-auto rounded-md p-1.5 hover:bg-gray-100 dark:hover:bg-gray-800"
				onclick={() => (enlarged = false)}
				aria-label={m["chat.browse.live.close"]()}
				data-testid="browse-live-close"
			>
				<CarbonClose class="size-4" />
			</button>
		</div>
		<div class="relative flex min-h-0 flex-1 items-center justify-center p-1">
			{#if frame}
				<img
					src={frame.src}
					alt={m["chat.browse.live.image_alt"]()}
					class="block max-h-full max-w-full touch-none object-contain select-none {controller ===
					'user'
						? 'cursor-crosshair ring-2 ring-amber-400'
						: ''}"
					draggable="false"
					onpointerdown={onPointerDown}
					onpointermove={onPointerMove}
					onpointerup={onPointerUp}
					onpointercancel={onPointerUp}
					onwheel={onWheel}
					data-testid="browse-live-surface"
				/>
			{/if}
			<textarea
				bind:this={keyboard}
				class="pointer-events-none absolute bottom-0 left-0 size-px resize-none opacity-0"
				aria-label={m["chat.browse.live.keyboard"]()}
				autocapitalize="off"
				autocomplete="off"
				spellcheck="false"
				rows="1"
				onkeydown={onKeyDown}
				onbeforeinput={onBeforeInput}
				oncompositionend={onCompositionEnd}
				data-testid="browse-live-keyboard-field"
			></textarea>
		</div>
	</div>
{/if}
