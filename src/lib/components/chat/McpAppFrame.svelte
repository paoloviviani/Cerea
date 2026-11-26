<script lang="ts">
	import { tick, untrack } from "svelte";
	import { base } from "$app/paths";
	import { m } from "$lib/paraglide/messages";
	import { AppBridge, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge";
	import type { McpUiHostContext } from "@modelcontextprotocol/ext-apps/app-bridge";
	import {
		MCP_APP_SANDBOX,
		MAX_APP_HTML_BYTES,
		buildMcpAppSrcdoc,
		cleanDomains,
		type McpAppSnapshot,
	} from "$lib/utils/mcpApp";
	import { MCP_APP_STYLE_VARIABLES } from "$lib/utils/mcpAppTheme";
	import { getAppMessageSink, MAX_APP_MESSAGE_CHARS } from "$lib/utils/appMessageDraft";
	import { parseExternalUrl } from "$lib/utils/externalLink";
	import { subscribeToTheme } from "$lib/switchTheme";
	import ExternalLinkModal from "$lib/components/ExternalLinkModal.svelte";
	import CarbonMaximize from "~icons/carbon/maximize";
	import { MCP_APP_DIAG_MAX_CHARS, MCP_APP_DIAG_MAX_COUNT } from "$lib/utils/mcpApp";
	import CarbonClose from "~icons/carbon/close";

	/**
	 * An MCP App page in the tool card (docs/dev/adr-mcp-apps.md): the HTML the server stored when the
	 * tool answered, in a sandboxed iframe with an opaque origin and the CSP its resource declared, talking
	 * to this component through the official `AppBridge`. The page is untrusted: everything it can do is
	 * one of the handlers below, and a request with no handler is refused.
	 */
	interface Props {
		app: McpAppSnapshot;
		conversationId: string;
		/** The call's own arguments. */
		toolInput: Record<string, unknown>;
		/** The tool's result, as an MCP `CallToolResult`. */
		toolResult: {
			content: unknown[];
			structuredContent?: Record<string, unknown>;
			isError?: boolean;
		};
		/** Test seam: where the stored page is read from. */
		pageUrl?: string;
	}

	let { app, conversationId, toolInput, toolResult, pageUrl }: Props = $props();

	const messageSink = getAppMessageSink();

	/** Page-initiated calls the browser forwards: a lower ceiling than the server's, for kindness. */
	const CALLS_PER_WINDOW = 20;
	const CALL_WINDOW_MS = 10_000;
	const MIN_HEIGHT = 60;
	const MAX_INLINE_HEIGHT = 720;
	const INITIAL_HEIGHT = 240;

	/** Cards in a long conversation start their iframe and bridge when they come near the screen, and keep running after. */
	const NEAR_MARGIN = "600px";
	const MAX_WAITING_APPROVALS = 3;

	/** What went wrong in the page, as its own shim and its logs told the card (see "Diagnostics" below). */
	interface Diagnostic {
		kind: string;
		message: string;
		source: string;
		line: number;
	}
	const REPORTED_TO_SERVER = 5;

	let diagnostics = $state<Diagnostic[]>([]);
	let detailsOpen = $state(false);
	let copied = $state(false);
	/** Bumped to mount a fresh frame. */
	let frameKey = $state(0);
	let reportedToServer = false;
	let reportTimer: ReturnType<typeof setTimeout> | undefined;

	let cardEl = $state<HTMLElement>();
	let toggleEl = $state<HTMLButtonElement>();
	let near = $state(false);
	/**
	 * The card has a real size: a page given its document while hidden (a folded row, `display: none`) or
	 * before layout draws at zero or default size and may never draw again. Nothing starts before this.
	 */
	let sized = $state(false);
	/** The card's width as the page is told it (the frame is as wide). */
	let cardWidth = $state(0);
	let sizedWaiters: Array<() => void> = [];
	let contextTimer: ReturnType<typeof setTimeout> | undefined;
	let html = $state<string | null>(null);
	let unavailable = $state(false);
	let iframeEl = $state<HTMLIFrameElement>();
	let srcdoc = $state<string>();
	let frameHeight = $state(INITIAL_HEIGHT);
	let fullscreen = $state(false);
	/** The frame's size in full screen, as the page is told it. */
	let frameSize = $state<{ width: number; height: number } | null>(null);
	let isDark = $state(false);
	let note = $state<string | null>(null);
	/** The page left its document (self-navigation): the bridge is closed and the frame is gone. */
	let dead = $state(false);
	/** The anti-clickjacking delay: the approval's buttons do nothing for a moment after it appears. */
	let approvalReady = $state(false);
	let nextApprovalId = 0;
	let linkUrl = $state<URL | null>(null);
	let linkAnswer: ((opened: boolean) => void) | null = null;
	type PendingApproval = {
		/** Not the object: the list is reactive, and what it holds is a proxy of what was added. */
		id: number;
		tool: string;
		args: Record<string, unknown>;
		answer: (choice: "once" | "conversation" | "deny") => void;
	};
	/** Calls waiting for the user's answer, in the order they asked: the first one is shown. */
	let approvals = $state<PendingApproval[]>([]);
	const approval = $derived(approvals[0] ?? null);

	let bridge: AppBridge | undefined;
	let started = false;
	let initialized = false;
	/** Documents loaded in the frame since it was given the page: only the first may talk to the bridge. */
	let armed = false;
	let pageLoads = 0;
	let initializations = 0;
	const APPROVAL_DELAY_MS = 500;

	/** Where Cerea itself is served: never a domain the page may be given. */
	const ownOrigins = () => (typeof location === "undefined" ? [] : [location.origin]);
	const callTimes: number[] = [];

	const declaredDomains = $derived(
		[
			...cleanDomains(app.csp?.connectDomains, { ownOrigins: ownOrigins() }).kept,
			...cleanDomains(app.csp?.resourceDomains, { ownOrigins: ownOrigins() }).kept,
			...cleanDomains(app.csp?.frameDomains, { ownOrigins: ownOrigins() }).kept,
		].filter((value, index, all) => all.indexOf(value) === index)
	);

	const url = $derived(pageUrl ?? `${base}/conversation/${conversationId}/mcp-app/${app.sha256}`);

	// The stored page: fetched once per card. Anything wrong (gone, blocked, too large) leaves the
	// card as it was before apps, with the tool's text result.
	$effect(() => {
		const el = cardEl;
		if (!el || typeof ResizeObserver === "undefined") {
			if (el) {
				sized = el.clientWidth > 0 && el.clientHeight > 0;
				cardWidth = el.clientWidth;
			} else sized = false;
			return;
		}
		const observer = new ResizeObserver(() => {
			sized = el.clientWidth > 0 && el.clientHeight > 0;
			if (sized) {
				cardWidth = el.clientWidth;
				const waiting = sizedWaiters;
				sizedWaiters = [];
				for (const resolve of waiting) resolve();
			}
			if (fullscreen) measureFrame();
			// The page sizes itself from the host context: it hears about a new size, once resizing settles.
			clearTimeout(contextTimer);
			contextTimer = setTimeout(pushContext, 150);
		});
		observer.observe(el);
		return () => {
			observer.disconnect();
			clearTimeout(contextTimer);
		};
	});

	const whenSized = () =>
		sized ? Promise.resolve() : new Promise<void>((resolve) => sizedWaiters.push(resolve));

	$effect(() => {
		if (near || !cardEl) return;
		if (typeof IntersectionObserver === "undefined") {
			near = true;
			return;
		}
		const observer = new IntersectionObserver(
			(entries) => {
				if (entries.some((entry) => entry.isIntersecting)) {
					near = true;
					observer.disconnect();
				}
			},
			{ rootMargin: NEAR_MARGIN }
		);
		observer.observe(cardEl);
		return () => observer.disconnect();
	});

	$effect(() => {
		const source = url;
		// Near the screen, and laid out: a hidden or not yet sized card does not start its page.
		if (!near || !sized) return;
		let cancelled = false;
		html = null;
		unavailable = false;
		void (async () => {
			try {
				const response = await fetch(source, { credentials: "same-origin" });
				if (!response.ok) throw new Error(String(response.status));
				const text = await response.text();
				if (text.length > MAX_APP_HTML_BYTES * 2) throw new Error("too large");
				if (!cancelled) html = text;
			} catch {
				if (!cancelled) unavailable = true;
			}
		})();
		return () => {
			cancelled = true;
		};
	});

	$effect(() => subscribeToTheme(({ isDark: dark }) => (isDark = dark)));

	function hostContext(): McpUiHostContext {
		return {
			theme: isDark ? "dark" : "light",
			styles: { variables: MCP_APP_STYLE_VARIABLES as never },
			displayMode: fullscreen ? "fullscreen" : "inline",
			availableDisplayModes: ["inline", "fullscreen"],
			// Inline the page is told its height limit; in full screen, the size it actually has.
			containerDimensions:
				fullscreen && frameSize
					? { width: frameSize.width, height: frameSize.height }
					: cardWidth > 0
						? { width: cardWidth, maxHeight: MAX_INLINE_HEIGHT }
						: { maxHeight: MAX_INLINE_HEIGHT },
			locale: typeof navigator === "undefined" ? undefined : navigator.language,
			timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
			userAgent: "Cerea",
			platform: "web",
			toolInfo: { tool: { name: app.tool, inputSchema: { type: "object" } } },
		};
	}

	function failure(text: string) {
		return { isError: true as const, content: [{ type: "text" as const, text }] };
	}

	/** Calls that need approval queue up and wait their turn; past a few waiting, one is refused. */
	function askApproval(
		tool: string,
		args: Record<string, unknown>
	): Promise<"once" | "conversation" | "deny"> | null {
		if (approvals.length >= MAX_WAITING_APPROVALS) return null;
		return new Promise<"once" | "conversation" | "deny">((resolve) => {
			const id = (nextApprovalId += 1);
			const entry: PendingApproval = {
				id,
				tool,
				args,
				answer: (choice) => {
					if (!approvalReady && choice !== "deny") return;
					if (!approvals.some((other) => other.id === id)) return;
					approvals = approvals.filter((other) => other.id !== id);
					resolve(choice);
				},
			};
			approvals = [...approvals, entry];
		});
	}

	/** Calls the server turned away because another card holds its one waiting slot: they retry when it is free. */
	let busyWaiters = 0;
	let slotFreed: Array<() => void> = [];
	const waitForFreeSlot = () => new Promise<void>((resolve) => slotFreed.push(resolve));
	$effect(() => {
		if (approvals.length > 0) return;
		const waiting = slotFreed;
		slotFreed = [];
		for (const resolve of waiting) resolve();
	});

	// The anti-clickjacking delay restarts for every card that comes to the front.
	$effect(() => {
		if (!approval) return;
		approvalReady = false;
		const timer = setTimeout(() => (approvalReady = true), APPROVAL_DELAY_MS);
		return () => clearTimeout(timer);
	});

	async function forwardCall(
		name: string,
		args: Record<string, unknown>,
		approvalAnswer?: { id: string; choice: "once" | "conversation" | "deny" },
		busyRetries = 0
	): Promise<{
		content: unknown[];
		structuredContent?: Record<string, unknown>;
		isError?: boolean;
	}> {
		const response = await fetch(`${base}/conversation/${conversationId}/mcp-app/call`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				connector: app.connector,
				tool: name,
				arguments: args,
				...(approvalAnswer ? { approval: approvalAnswer } : {}),
			}),
		});
		const body = (await response.json().catch(() => null)) as {
			ok?: boolean;
			result?: {
				content: unknown[];
				structuredContent?: Record<string, unknown>;
				isError?: boolean;
			};
			code?: string;
			message?: string;
			approval?: { id?: string };
		} | null;
		if (response.ok && body?.ok && body.result) return body.result;
		// The server holds one waiting card per conversation: a second call waits for its turn here.
		if (response.status === 429 && body?.code === "approval_busy" && !approvalAnswer) {
			if (
				busyRetries >= MAX_WAITING_APPROVALS ||
				approvals.length + busyWaiters >= MAX_WAITING_APPROVALS
			) {
				return failure("Too many calls are waiting for the user's answer."); // i18n: server text
			}
			busyWaiters += 1;
			try {
				await (approvals.length > 0 ? waitForFreeSlot() : new Promise((r) => setTimeout(r, 400)));
			} finally {
				busyWaiters -= 1;
			}
			return forwardCall(name, args, undefined, busyRetries + 1);
		}
		if (response.status === 409 && body?.code === "approval_required" && body.approval?.id) {
			const id = body.approval.id;
			const asked = askApproval(name, args);
			// Texts below go to the page, not to the user: they are not interface copy.
			if (!asked) return failure("Too many calls are waiting for the user's answer."); // i18n: server text
			const answer = await asked;
			if (answer === "deny") {
				// Frees the server's one waiting slot; what the page sees does not depend on it.
				void forwardCall(name, args, { id, choice: "deny" }).catch(() => undefined);
				return failure("The user denied this call."); // i18n: server text
			}
			return forwardCall(name, args, { id, choice: answer });
		}
		return failure(body?.message ?? "The call failed."); // i18n: server text
	}

	async function onCallTool(params: { name: string; arguments?: Record<string, unknown> }) {
		const now = Date.now();
		while (callTimes.length > 0 && now - callTimes[0] > CALL_WINDOW_MS) callTimes.shift();
		if (callTimes.length >= CALLS_PER_WINDOW) {
			return failure("This view is making calls too fast."); // i18n: server text
		}
		callTimes.push(now);
		try {
			return await forwardCall(params.name, params.arguments ?? {});
		} catch (err) {
			return failure(err instanceof Error ? err.message : "The call failed."); // i18n: server text
		}
	}

	function confirmLink(target: URL): Promise<boolean> {
		return new Promise((resolve) => {
			linkAnswer?.(false);
			linkAnswer = resolve;
			linkUrl = target;
		});
	}

	function closeLink(opened: boolean) {
		const answer = linkAnswer;
		linkAnswer = null;
		linkUrl = null;
		answer?.(opened);
	}

	async function start(win: Window, page: string) {
		const instance = new AppBridge(
			null,
			{ name: "Cerea", version: "1.0.0" },
			{ openLinks: {}, serverTools: {}, message: { text: {} }, logging: {} },
			{ hostContext: hostContext() }
		);
		bridge = instance;
		instance.oninitialized = () => {
			// A document that says it is ready a second time is not the page that was given: close.
			initializations += 1;
			if (initializations > 1) return kill();
			initialized = true;
			void whenSized()
				// The size it was given at the handshake may be stale if the card was hidden then.
				.then(() => pushContext())
				// Snapshots: a reactive proxy cannot be posted to another window.
				.then(() => instance.sendToolInput({ arguments: $state.snapshot(toolInput) }))
				.then(() => instance.sendToolResult($state.snapshot(toolResult) as never))
				.catch((err) => console.debug("[mcp-app] could not send the tool data", err));
		};
		instance.onsizechange = ({ height }) => {
			if (typeof height === "number" && Number.isFinite(height)) {
				frameHeight = Math.min(MAX_INLINE_HEIGHT, Math.max(MIN_HEIGHT, Math.ceil(height)));
			}
		};
		instance.oncalltool = (params) => onCallTool(params) as never;
		instance.onmessage = async (params) => {
			// The schema of this bridge version takes a list of content blocks; the spec text shows one.
			const blocks = Array.isArray(params.content) ? params.content : [params.content];
			const texts = blocks.map((block) => {
				const b = block as { type?: string; text?: unknown } | undefined;
				return b?.type === "text" && typeof b.text === "string" ? b.text : null;
			});
			// Text only: a page that sends anything else gets a refusal, not a partial message.
			if (params.role !== "user" || texts.length === 0 || texts.some((t) => t === null)) {
				return { isError: true };
			}
			const text = texts.join("\n").trim().slice(0, MAX_APP_MESSAGE_CHARS);
			// A suggestion the user sees above the composer, never text written into it.
			if (!text || !messageSink || !messageSink(text, app.server)) return { isError: true };
			note = m["chat.mcp_app.message_added"]({ server: app.server });
			return {};
		};
		instance.onopenlink = async ({ url: href }) => {
			const target = parseExternalUrl(href);
			if (!target) return { isError: true };
			return (await confirmLink(target)) ? {} : { isError: true };
		};
		instance.onrequestdisplaymode = async ({ mode }) => {
			if (mode === "fullscreen" || mode === "inline") setFullscreen(mode === "fullscreen");
			return { mode: fullscreen ? "fullscreen" : "inline" };
		};
		// The page's diagnostics shim shares the window with the bridge: a message that is not JSON-RPC is
		// not a failure of the bridge.
		instance.onerror = (err) => console.debug("[mcp-app] ignored a message", err.message);
		instance.onloggingmessage = (params) => {
			console.debug("[mcp-app]", app.server, params);
			if (params.level === "error" || params.level === "warning") {
				const data = typeof params.data === "string" ? params.data : JSON.stringify(params.data);
				addDiagnostic({ kind: `log ${params.level}`, message: data ?? "", source: "", line: 0 });
			}
		};
		await instance.connect(new PostMessageTransport(win, win));
		// Only now does the page get its document: the bridge is listening before its first message.
		armed = true;
		srcdoc = buildMcpAppSrcdoc(page, app.csp, { ownOrigins: ownOrigins() });
	}

	/**
	 * The frame loaded a document. The first after the page was given is the page; any later one means it
	 * navigated itself (script, meta refresh, a link to itself): that document is outside the CSP we built and
	 * must not keep the bridge, so the bridge is closed and the frame removed.
	 */
	function onFrameLoad() {
		if (!armed) return;
		try {
			// The initial blank document is readable, a sandboxed one is not.
			if (iframeEl?.contentWindow?.location.href === "about:blank") return;
		} catch {
			// Opaque origin: this is the page (or a document it moved to).
		}
		pageLoads += 1;
		if (pageLoads > 1) kill();
	}

	// Diagnostics. The page's shim posts `{ cereaDiag }` to this window; only the frame's own window is
	// believed, and a message is read as data (truncated, counted, never rendered as markup).
	function addDiagnostic(entry: Diagnostic) {
		const text = (value: unknown) => String(value ?? "").slice(0, MCP_APP_DIAG_MAX_CHARS);
		const clean: Diagnostic = {
			kind: text(entry.kind).slice(0, 20),
			message: text(entry.message),
			source: text(entry.source),
			line: Number.isFinite(entry.line) ? Math.trunc(entry.line) : 0,
		};
		if (diagnostics.length >= MCP_APP_DIAG_MAX_COUNT) return;
		const same = (d: Diagnostic) =>
			d.kind === clean.kind &&
			d.message === clean.message &&
			d.source === clean.source &&
			d.line === clean.line;
		if (diagnostics.some(same)) return;
		diagnostics = [...diagnostics, clean];
		scheduleReport();
	}

	/** The first few go to the server once, so an administrator tailing the logs can see them. */
	function scheduleReport() {
		if (reportedToServer || reportTimer) return;
		reportTimer = setTimeout(() => {
			reportTimer = undefined;
			reportedToServer = true;
			void fetch(`${base}/conversation/${conversationId}/mcp-app/diag`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					connector: app.connector,
					uri: app.uri,
					errors: $state.snapshot(diagnostics).slice(0, REPORTED_TO_SERVER),
				}),
			}).catch(() => undefined);
		}, 1500);
	}

	$effect(() => {
		const onMessage = (event: MessageEvent) => {
			if (!iframeEl || event.source !== iframeEl.contentWindow) return;
			const data = event.data as { cereaDiag?: unknown } | null;
			const diag = data && typeof data === "object" ? data.cereaDiag : undefined;
			if (!diag || typeof diag !== "object") return;
			addDiagnostic(diag as Diagnostic);
		};
		window.addEventListener("message", onMessage);
		return () => {
			window.removeEventListener("message", onMessage);
			clearTimeout(reportTimer);
		};
	});

	const diagnosticsText = $derived(
		diagnostics
			.map(
				(d) =>
					`[${d.kind}] ${d.message}${d.source ? ` (${d.source}${d.line ? `:${d.line}` : ""})` : ""}`
			)
			.join("\n")
	);

	async function copyDiagnostics() {
		try {
			await navigator.clipboard.writeText(diagnosticsText);
			copied = true;
			setTimeout(() => (copied = false), 1500);
		} catch {
			// No clipboard here: the text is selectable in the panel.
		}
	}

	/** Mounts the frame again, with a fresh bridge: what the page was doing is lost, as with any reload. */
	function reloadView() {
		const instance = bridge;
		bridge = undefined;
		void instance?.close().catch(() => undefined);
		started = false;
		armed = false;
		initialized = false;
		pageLoads = 0;
		initializations = 0;
		srcdoc = undefined;
		dead = false;
		diagnostics = [];
		reportedToServer = false;
		detailsOpen = false;
		frameKey += 1;
	}

	function kill() {
		if (dead) return;
		dead = true;
		addDiagnostic({
			kind: "closed",
			message: "The page left its document, so the view was closed.",
			source: "",
			line: 0,
		});
		const instance = bridge;
		bridge = undefined;
		srcdoc = undefined;
		initialized = false;
		void instance?.close().catch(() => undefined);
	}

	$effect(() => {
		const win = iframeEl?.contentWindow;
		const page = html;
		if (started || !win || page === null || !sized) return;
		started = true;
		untrack(() => void start(win, page));
	});

	// Theme changes reach the page as a context update, after it has said it is ready.
	$effect(() => {
		void isDark;
		pushContext();
	});

	/** Switches the display mode. The card stays where it is in the DOM (its iframe must not reload): in full
	 * screen only its styles change, to a fixed layer over the whole window (see the lift rule in main.css). */
	function setFullscreen(on: boolean) {
		if (fullscreen === on) return;
		fullscreen = on;
		if (!on) frameSize = null;
		// After the layout has settled, so the size told to the page is the one it has.
		void tick().then(() => {
			if (fullscreen !== on) return;
			measureFrame();
			pushContext();
		});
	}

	function measureFrame() {
		if (fullscreen && iframeEl) {
			frameSize = { width: iframeEl.clientWidth, height: iframeEl.clientHeight };
		}
	}

	/** The whole context goes to the bridge, which sends the page only what changed. */
	function pushContext() {
		if (!bridge || !initialized) return;
		try {
			bridge.setHostContext(hostContext());
		} catch (err) {
			console.debug("[mcp-app] could not send the host context", err);
		}
	}

	$effect(() => {
		if (!fullscreen) return;
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				// A dialog above the layer (the link confirmation) takes its own Escape first.
				if (event.defaultPrevented) return;
				setFullscreen(false);
			}
		};
		window.addEventListener("keydown", onKey);
		const onResize = () => {
			measureFrame();
			pushContext();
		};
		window.addEventListener("resize", onResize);
		// The window behind the layer does not scroll, and the shell's stacking is lifted so the layer
		// can sit above the sidebar and the composer.
		const root = document.documentElement;
		const overflow = document.body.style.overflow;
		document.body.style.overflow = "hidden";
		root.dataset.appFullscreen = "";
		toggleEl?.focus();
		return () => {
			window.removeEventListener("keydown", onKey);
			window.removeEventListener("resize", onResize);
			document.body.style.overflow = overflow;
			delete root.dataset.appFullscreen;
			toggleEl?.focus();
		};
	});

	$effect(() => {
		return () => {
			const instance = bridge;
			bridge = undefined;
			linkAnswer?.(false);
			for (const entry of approvals) entry.answer("deny");
			if (!instance) return;
			// Best effort: the page is told it is going, and is not waited for.
			void instance
				.teardownResource({})
				.catch(() => undefined)
				.finally(() => void instance.close().catch(() => undefined));
		};
	});
</script>

{#if !unavailable}
	<!-- Full screen is this same element restyled as a fixed layer over the window, never moved: moving an
	     iframe in the DOM reloads it, and a second load closes the bridge. What could trap it, the chat
	     column's own stacking context and its container query, is lifted while it is open (main.css). -->
	<div
		bind:this={cardEl}
		data-testid="mcp-app"
		data-display-mode={fullscreen ? "fullscreen" : "inline"}
		role={fullscreen ? "dialog" : undefined}
		aria-modal={fullscreen ? "true" : undefined}
		aria-label={fullscreen ? m["chat.mcp_app.title"]({ server: app.server }) : undefined}
		class={fullscreen
			? "fixed inset-0 z-50 flex flex-col bg-white pt-[env(safe-area-inset-top)] pr-[env(safe-area-inset-right)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] dark:bg-gray-900"
			: "relative my-2 flex w-full flex-col overflow-hidden rounded-xl bg-white dark:bg-gray-900 " +
				(app.prefersBorder === false ? "" : "border border-gray-200 dark:border-gray-700")}
	>
		<div
			class="flex shrink-0 items-center justify-between gap-2 border-b border-gray-100 px-3 text-xs text-gray-500 dark:border-gray-800 dark:text-gray-400 {fullscreen
				? 'py-1'
				: 'py-1.5'}"
		>
			<div class="min-w-0">
				<div class="truncate">{m["chat.mcp_app.title"]({ server: app.server })}</div>
				{#if fullscreen && declaredDomains.length > 0}
					<div
						data-testid="mcp-app-domains"
						class="truncate text-xxs text-gray-400 dark:text-gray-500"
						title={declaredDomains.join(", ")}
					>
						{m["chat.mcp_app.domains"]({ domains: declaredDomains.join(", ") })}
					</div>
				{/if}
			</div>
			<button
				bind:this={toggleEl}
				type="button"
				class="shrink-0 rounded-md p-1 hover:bg-gray-100 dark:hover:bg-gray-800 {fullscreen
					? 'p-2'
					: ''}"
				aria-label={fullscreen
					? m["chat.mcp_app.exit_fullscreen"]()
					: m["chat.mcp_app.fullscreen"]()}
				title={fullscreen ? m["chat.mcp_app.exit_fullscreen"]() : m["chat.mcp_app.fullscreen"]()}
				onclick={() => setFullscreen(!fullscreen)}
			>
				{#if fullscreen}<CarbonClose class="size-5" />{:else}<CarbonMaximize class="size-4" />{/if}
			</button>
		</div>

		{#if !fullscreen && declaredDomains.length > 0}
			<p
				data-testid="mcp-app-domains"
				class="truncate border-b border-gray-100 px-3 py-1 text-xxs text-gray-400 dark:border-gray-800 dark:text-gray-500"
				title={declaredDomains.join(", ")}
			>
				{m["chat.mcp_app.domains"]({ domains: declaredDomains.join(", ") })}
			</p>
		{/if}

		{#if approval}
			<!-- In the flow, above the frame (an iframe paints over what it overlaps, and the full-screen
			     header must stay reachable), so a page with a modal of its own cannot hide it. -->
			<div
				data-testid="mcp-app-approval"
				role="alertdialog"
				aria-label={m["chat.mcp_app.approval.title"]({ server: app.server, tool: approval.tool })}
				class="max-h-[60%] shrink-0 space-y-2 overflow-auto border-b border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900/50 dark:bg-amber-900/20 dark:text-amber-100"
			>
				<p>
					{m["chat.mcp_app.approval.title"]({ server: app.server, tool: approval.tool })}
					{#if approvals.length > 1}
						<span class="text-xs opacity-70">+{approvals.length - 1}</span>
					{/if}
				</p>
				<div class="text-xxs font-semibold uppercase">{m["chat.mcp_app.approval.args"]()}</div>
				<pre
					class="scrollbar-custom max-h-32 overflow-auto rounded-lg bg-white/70 p-2 font-mono text-xs break-all whitespace-pre-wrap dark:bg-black/20">{JSON.stringify(
						approval.args,
						null,
						2
					)}</pre>
				<div class="flex flex-wrap gap-2">
					<button
						type="button"
						disabled={!approvalReady}
						class="rounded-lg bg-gray-900 px-3 py-1 text-xs font-semibold text-white hover:bg-black disabled:opacity-40 dark:bg-gray-100 dark:text-gray-900"
						onclick={() => approval?.answer("once")}>{m["chat.approval.allow_once"]()}</button
					>
					<button
						type="button"
						disabled={!approvalReady}
						class="rounded-lg border border-gray-300 bg-white px-3 py-1 text-xs font-medium text-gray-900 hover:bg-gray-50 disabled:opacity-40 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100"
						onclick={() => approval?.answer("conversation")}
						>{m["chat.mcp_app.approval.allow_conversation"]()}</button
					>
					<button
						type="button"
						class="rounded-lg px-3 py-1 text-xs font-medium text-gray-700 hover:bg-white/60 dark:text-gray-300"
						onclick={() => approval?.answer("deny")}>{m["chat.approval.deny"]()}</button
					>
				</div>
			</div>
		{/if}

		{#if note}
			<p
				data-testid="mcp-app-note"
				class="border-b border-blue-100 bg-blue-50 px-3 py-1.5 text-xs text-blue-800 dark:border-blue-900/40 dark:bg-blue-900/20 dark:text-blue-200"
			>
				{note}
			</p>
		{/if}

		{#if dead}
			<p data-testid="mcp-app-closed" class="px-3 py-6 text-center text-xs text-gray-500">
				{m["chat.mcp_app.closed"]()}
			</p>
		{:else if html === null}
			<div class="px-3 py-6 text-center text-xs text-gray-400" data-testid="mcp-app-loading">
				{m["chat.mcp_app.loading"]()}
			</div>
		{:else}
			<!-- No allow-same-origin: the page's origin is opaque, so it cannot reach this app's cookies,
			     storage or DOM. Its CSP is the first thing in its document. -->
			{#key frameKey}
				<iframe
					bind:this={iframeEl}
					title={m["chat.mcp_app.frame_title"]({ server: app.server })}
					class="w-full border-0 bg-white dark:bg-gray-900 {fullscreen ? 'min-h-0 flex-1' : ''}"
					style={fullscreen ? undefined : `height: ${frameHeight}px`}
					sandbox={MCP_APP_SANDBOX}
					onload={onFrameLoad}
					referrerpolicy="no-referrer"
					{srcdoc}
				></iframe>
			{/key}
		{/if}

		{#if diagnostics.length > 0}
			<div
				data-testid="mcp-app-diagnostics"
				class="shrink-0 border-t border-gray-100 px-3 py-1 text-xs text-gray-500 dark:border-gray-800 dark:text-gray-400"
			>
				<button
					type="button"
					class="underline decoration-dotted underline-offset-2 hover:text-gray-700 dark:hover:text-gray-200"
					aria-expanded={detailsOpen}
					onclick={() => (detailsOpen = !detailsOpen)}
				>
					{detailsOpen ? m["chat.mcp_app.details_hide"]() : m["chat.mcp_app.details_show"]()}
				</button>
				{#if detailsOpen}
					<div class="mt-1 space-y-1" data-testid="mcp-app-details">
						<p>{m["chat.mcp_app.details_intro"]()}</p>
						<pre
							class="scrollbar-custom max-h-40 overflow-auto rounded-lg bg-gray-100 p-2 font-mono text-xxs break-all whitespace-pre-wrap text-gray-700 select-text dark:bg-gray-800/70 dark:text-gray-300">{diagnosticsText}</pre>
						<div class="flex gap-2">
							<button
								type="button"
								class="rounded-md border border-gray-200 px-2 py-0.5 hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-800"
								onclick={copyDiagnostics}
							>
								{copied ? m["chat.mcp_app.details_copied"]() : m["chat.mcp_app.details_copy"]()}
							</button>
							<button
								type="button"
								class="rounded-md border border-gray-200 px-2 py-0.5 hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-800"
								onclick={reloadView}
							>
								{m["chat.mcp_app.reload"]()}
							</button>
						</div>
					</div>
				{/if}
			</div>
		{/if}
	</div>
{/if}

{#if linkUrl}
	<ExternalLinkModal
		url={linkUrl}
		onconfirm={() => closeLink(true)}
		onclose={() => closeLink(false)}
	/>
{/if}
