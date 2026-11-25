<script lang="ts">
	import { untrack } from "svelte";
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
	import CarbonMinimize from "~icons/carbon/minimize";

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
	const CALLS_PER_WINDOW = 10;
	const CALL_WINDOW_MS = 10_000;
	const MIN_HEIGHT = 60;
	const MAX_INLINE_HEIGHT = 720;
	const INITIAL_HEIGHT = 240;

	let html = $state<string | null>(null);
	let unavailable = $state(false);
	let iframeEl = $state<HTMLIFrameElement>();
	let srcdoc = $state<string>();
	let frameHeight = $state(INITIAL_HEIGHT);
	let fullscreen = $state(false);
	let isDark = $state(false);
	let note = $state<string | null>(null);
	let linkUrl = $state<URL | null>(null);
	let linkAnswer: ((opened: boolean) => void) | null = null;
	type PendingApproval = {
		tool: string;
		args: Record<string, unknown>;
		answer: (choice: "once" | "conversation" | "deny") => void;
	};
	let approval = $state<PendingApproval | null>(null);

	let bridge: AppBridge | undefined;
	let started = false;
	let initialized = false;
	const callTimes: number[] = [];

	const declaredDomains = $derived(
		[
			...cleanDomains(app.csp?.connectDomains).kept,
			...cleanDomains(app.csp?.resourceDomains).kept,
			...cleanDomains(app.csp?.frameDomains).kept,
		].filter((value, index, all) => all.indexOf(value) === index)
	);

	const url = $derived(pageUrl ?? `${base}/conversation/${conversationId}/mcp-app/${app.sha256}`);

	// The stored page: fetched once per card. Anything wrong (gone, blocked, too large) leaves the
	// card as it was before apps, with the tool's text result.
	$effect(() => {
		const source = url;
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
			containerDimensions: { maxHeight: MAX_INLINE_HEIGHT },
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

	/** One answer at a time: two calls that both need approval are asked one after the other. */
	let askChain: Promise<unknown> = Promise.resolve();
	function askApproval(
		tool: string,
		args: Record<string, unknown>
	): Promise<"once" | "conversation" | "deny"> {
		const next = askChain.then(
			() =>
				new Promise<"once" | "conversation" | "deny">((resolve) => {
					approval = {
						tool,
						args,
						answer: (choice) => {
							approval = null;
							resolve(choice);
						},
					};
				})
		);
		askChain = next.catch(() => undefined);
		return next;
	}

	async function forwardCall(
		name: string,
		args: Record<string, unknown>,
		choice?: "once" | "conversation"
	) {
		const response = await fetch(`${base}/conversation/${conversationId}/mcp-app/call`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				connector: app.connector,
				tool: name,
				arguments: args,
				...(choice ? { approval: choice } : {}),
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
		} | null;
		if (response.ok && body?.ok && body.result) return body.result;
		if (response.status === 409 && body?.code === "approval_required") {
			const answer = await askApproval(name, args);
			// Texts below go to the page, not to the user: they are not interface copy.
			if (answer === "deny") return failure("The user denied this call."); // i18n: server text
			return forwardCall(name, args, answer);
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
			initialized = true;
			void instance
				// Snapshots: a reactive proxy cannot be posted to another window.
				.sendToolInput({ arguments: $state.snapshot(toolInput) })
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
			if (!text || !messageSink) return { isError: true };
			messageSink(text, app.server);
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
		instance.onloggingmessage = (params) => {
			console.debug("[mcp-app]", app.server, params);
		};
		await instance.connect(new PostMessageTransport(win, win));
		// Only now does the page get its document: the bridge is listening before its first message.
		srcdoc = buildMcpAppSrcdoc(page, app.csp);
	}

	$effect(() => {
		const win = iframeEl?.contentWindow;
		const page = html;
		if (started || !win || page === null) return;
		started = true;
		untrack(() => void start(win, page));
	});

	// Theme changes reach the page as a context update, after it has said it is ready.
	$effect(() => {
		const theme = isDark ? "dark" : "light";
		if (!bridge || !initialized) return;
		void bridge.sendHostContextChange({ theme });
	});

	function setFullscreen(on: boolean) {
		if (fullscreen === on) return;
		fullscreen = on;
		if (bridge && initialized) {
			void bridge.sendHostContextChange({
				displayMode: on ? "fullscreen" : "inline",
				containerDimensions: on ? undefined : { maxHeight: MAX_INLINE_HEIGHT },
			});
		}
	}

	$effect(() => {
		if (!fullscreen) return;
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") setFullscreen(false);
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	});

	$effect(() => {
		return () => {
			const instance = bridge;
			bridge = undefined;
			linkAnswer?.(false);
			approval?.answer("deny");
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
	<div
		data-testid="mcp-app"
		class={fullscreen
			? "fixed inset-0 z-50 flex flex-col bg-white dark:bg-gray-900"
			: "my-2 flex flex-col overflow-hidden rounded-xl bg-white dark:bg-gray-900 " +
				(app.prefersBorder === false ? "" : "border border-gray-200 dark:border-gray-700")}
	>
		<div
			class="flex items-center justify-between gap-2 border-b border-gray-100 px-3 py-1.5 text-xs text-gray-500 dark:border-gray-800 dark:text-gray-400"
		>
			<span class="min-w-0 truncate">{m["chat.mcp_app.title"]({ server: app.server })}</span>
			<button
				type="button"
				class="shrink-0 rounded-md p-1 hover:bg-gray-100 dark:hover:bg-gray-800"
				aria-label={fullscreen
					? m["chat.mcp_app.exit_fullscreen"]()
					: m["chat.mcp_app.fullscreen"]()}
				title={fullscreen ? m["chat.mcp_app.exit_fullscreen"]() : m["chat.mcp_app.fullscreen"]()}
				onclick={() => setFullscreen(!fullscreen)}
			>
				{#if fullscreen}<CarbonMinimize class="size-4" />{:else}<CarbonMaximize
						class="size-4"
					/>{/if}
			</button>
		</div>

		{#if declaredDomains.length > 0}
			<p
				data-testid="mcp-app-domains"
				class="truncate border-b border-gray-100 px-3 py-1 text-xxs text-gray-400 dark:border-gray-800 dark:text-gray-500"
				title={declaredDomains.join(", ")}
			>
				{m["chat.mcp_app.domains"]({ domains: declaredDomains.join(", ") })}
			</p>
		{/if}

		{#if approval}
			<div
				data-testid="mcp-app-approval"
				class="space-y-2 border-b border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900/50 dark:bg-amber-900/20 dark:text-amber-100"
			>
				<p>{m["chat.mcp_app.approval.title"]({ server: app.server, tool: approval.tool })}</p>
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
						class="rounded-lg bg-gray-900 px-3 py-1 text-xs font-semibold text-white hover:bg-black dark:bg-gray-100 dark:text-gray-900"
						onclick={() => approval?.answer("once")}>{m["chat.approval.allow_once"]()}</button
					>
					<button
						type="button"
						class="rounded-lg border border-gray-300 bg-white px-3 py-1 text-xs font-medium text-gray-900 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100"
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

		{#if html === null}
			<div class="px-3 py-6 text-center text-xs text-gray-400" data-testid="mcp-app-loading">
				{m["chat.mcp_app.loading"]()}
			</div>
		{:else}
			<!-- No allow-same-origin: the page's origin is opaque, so it cannot reach this app's cookies,
			     storage or DOM. Its CSP is the first thing in its document. -->
			<iframe
				bind:this={iframeEl}
				title={m["chat.mcp_app.frame_title"]({ server: app.server })}
				class="w-full border-0 bg-white dark:bg-gray-900 {fullscreen ? 'min-h-0 flex-1' : ''}"
				style={fullscreen ? undefined : `height: ${frameHeight}px`}
				sandbox={MCP_APP_SANDBOX}
				allow="clipboard-write *"
				referrerpolicy="no-referrer"
				{srcdoc}
			></iframe>
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
