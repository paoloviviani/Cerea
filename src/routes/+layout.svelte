<script lang="ts">
	import { m } from "$lib/paraglide/messages";
	import "../styles/main.css";

	import { onDestroy, onMount } from "svelte";
	import { browser } from "$app/environment";
	import { beforeNavigate, goto, invalidateAll } from "$app/navigation";
	import { base } from "$app/paths";
	import { page, updated } from "$app/state";

	import { error } from "$lib/stores/errors";
	import { createSettingsStore } from "$lib/stores/settings";
	import { applyPalette } from "$lib/utils/palettes";
	import { setHapticsEnabled } from "$lib/utils/haptics";
	import { initWithServers } from "$lib/stores/mcpServers";
	import { getExecutionSession } from "$lib/utils/execution/runtime";
	import { setClientExecutionBackend } from "$lib/utils/execution/backend.svelte";
	import { runTimeoutMsFromSeconds } from "$lib/utils/execution/protocol";

	import Toast from "$lib/components/Toast.svelte";
	import NotificationToasts from "$lib/components/NotificationToasts.svelte";
	import GenerationLiveWatcher from "$lib/components/GenerationLiveWatcher.svelte";
	import UpdateBanner from "$lib/components/UpdateBanner.svelte";
	import { watchChunkErrors } from "$lib/utils/appReload";
	import { onAppResume } from "$lib/utils/appResume";
	import NavMenu from "$lib/components/NavMenu.svelte";
	import NavigationLoadingBar from "$lib/components/NavigationLoadingBar.svelte";
	import MobileNav from "$lib/components/MobileNav.svelte";
	import ExpandNavigation from "$lib/components/ExpandNavigation.svelte";
	import { setContext } from "svelte";
	import { handleResponse, useAPIClient } from "$lib/APIClient";
	import { isAborted } from "$lib/stores/isAborted";
	import { codeNav } from "$lib/stores/codeNav.svelte";
	import { requireAuthUser } from "$lib/utils/auth";
	import { createConversationsStore } from "$lib/stores/conversations.svelte";
	import { createActiveGenerationsStore } from "$lib/stores/activeGenerations.svelte";
	import { projectTitle } from "$lib/stores/projectTitle";
	import { createNotificationsStore } from "$lib/stores/notifications.svelte";
	import { initAppViewport } from "$lib/utils/appViewport";
	import { adoptServerLocale } from "$lib/i18n/locale";

	let { data = $bindable(), children } = $props();

	// Before anything below reads a message: the browser answers with the language
	// the server rendered in, so hydration produces the HTML it was sent.
	adoptServerLocale(data.locale);

	setContext("publicConfig", data.publicConfig);

	const publicConfig = data.publicConfig;
	const client = useAPIClient();

	const convsStore = createConversationsStore();
	// Cross-conversation generation liveness: the watcher (mounted below) feeds both.
	createActiveGenerationsStore();
	createNotificationsStore();
	// Synchronous seed for SSR: $effect is stripped by the server-side compiler,
	// so we must call init() immediately to populate the list on first paint.
	// The $effect below handles client-side resyncs when data.conversations
	// reference changes after subsequent invalidations.
	// Last-write-wins from server is acceptable; see conversations.svelte.ts.
	convsStore.init(data.conversations);

	$effect(() => {
		convsStore.init(data.conversations);
	});

	let isNavCollapsed = $state(false);
	let cleanupAppViewport: (() => void) | undefined;

	let errorToastTimeout: ReturnType<typeof setTimeout>;
	let currentError: string | undefined = $state();

	async function onError() {
		// If a new different error comes, wait for the current error to hide first
		if ($error && currentError && $error !== currentError) {
			clearTimeout(errorToastTimeout);
			currentError = undefined;
			await new Promise((resolve) => setTimeout(resolve, 300));
		}

		currentError = $error;

		errorToastTimeout = setTimeout(() => {
			$error = undefined;
			currentError = undefined;
		}, 5000);
	}

	async function deleteConversation(id: string) {
		client
			.conversations({ id })
			.delete()
			.then(handleResponse)
			.then(async () => {
				convsStore.remove(id);

				if (page.params.id === id) {
					await goto(`${base}/`, { invalidateAll: true });
				}
			})
			.catch((err) => {
				console.error(err);
				$error = String(err);
			});
	}

	async function editConversationTitle(id: string, title: string) {
		client
			.conversations({ id })
			.patch({ title })
			.then(handleResponse)
			.then(async () => {
				convsStore.update(id, { title });
			})
			.catch((err) => {
				console.error(err);
				$error = String(err);
			});
	}

	// Global keyboard shortcut: New Chat (Ctrl/Cmd + Shift + O)
	const onKeydown = (e: KeyboardEvent) => {
		// Ignore when a modal has focus (app is inert)
		const appEl = document.getElementById("app");
		if (appEl?.hasAttribute("inert")) return;

		const oPressed = e.key?.toLowerCase() === "o";
		const metaOrCtrl = e.metaKey || e.ctrlKey;
		if (oPressed && e.shiftKey && metaOrCtrl) {
			e.preventDefault();
			isAborted.set(true);
			if (requireAuthUser()) return;
			goto(`${base}/`, { invalidateAll: true });
		}
	};

	// A deploy happened since this tab loaded (see kit.version in
	// svelte.config.js): load the next page from the server, with the new
	// client, instead of navigating inside the old one.
	beforeNavigate(({ willUnload, to }) => {
		if (updated.current && !willUnload && to?.url) location.href = to.url.href;
	});

	const cleanups: Array<() => void> = [];

	onDestroy(() => {
		for (const stop of cleanups) stop();
		clearTimeout(errorToastTimeout);
		cleanupAppViewport?.();
		if (browser) window.removeEventListener("keydown", onKeydown, { capture: true });
	});

	$effect(() => {
		if ($error) onError();
	});

	// Where code runs, before any child decides whether to run, resume or hint.
	setClientExecutionBackend(data.codeExecution);
	$effect(() => {
		setClientExecutionBackend(data.codeExecution);
	});

	const settings = createSettingsStore(data.settings);

	$effect(() => {
		setHapticsEnabled($settings.hapticsEnabled);
	});

	// The server renders <html> with the saved palette; this keeps it in step
	// when the person picks another one, so a choice applies without a reload.
	$effect(() => {
		applyPalette(document.documentElement, $settings);
	});

	// The effective PyPI-install flag is the user's own opt-in AND the
	// deployment not having killed it (data.pyodidePyPiInstallAllowed, from
	// FeatureFlags — computed server-side from CHAT_PYODIDE_PYPI_DISABLED).
	// Re-evaluated on every relevant change so toggling the setting takes
	// effect immediately, without a page reload or a fresh sandbox session.
	$effect(() => {
		getExecutionSession()?.configure(
			!!(data.pyodidePyPiInstallAllowed && $settings.pyodidePyPiInstallEnabled),
			runTimeoutMsFromSeconds(data.codeRunTimeoutSeconds)
		);
	});

	onMount(async () => {
		// A lazily loaded chunk that 404s after a deploy: reload the page once.
		const stopChunkWatch = watchChunkErrors();
		// A tab or PWA that slept (or lost the network) re-reads what the
		// server knows — session, conversations — instead of showing a stale,
		// broken shell until someone reloads.
		const stopResume = onAppResume(() => void invalidateAll());
		cleanups.push(stopChunkWatch, stopResume);
		// Measure the window's real height for the shell (see appViewport):
		// `100dvh` can go stale when an Android PWA returns from the login
		// Custom Tab, cutting the composer off with no way to scroll it back.
		cleanupAppViewport = initAppViewport();
		// Seed the MCP store from the SSR payload before anything else runs.
		// onMount never fires during SSR, so this matches the server-rendered HTML
		// (stores at defaults) and avoids hydration mismatches in NavMenu / ChatWindow.
		// The layout onMount fires after child onMounts (Svelte 5 order), but that
		// is fine: writeMessage's mcpServersLoaded gate is an async Promise/subscriber,
		// so when initWithServers sets mcpServersLoaded=true synchronously here, the
		// subscriber resolves immediately without any added network latency.
		initWithServers(data.mcpBaseServers ?? []);

		if (page.url.searchParams.has("model")) {
			await settings
				.instantSet({
					activeModel: page.url.searchParams.get("model") ?? $settings.activeModel,
				})
				.then(async () => {
					const query = new URLSearchParams(page.url.searchParams.toString());
					query.delete("model");
					await goto(`${base}/?${query.toString()}`, {
						invalidateAll: true,
					});
				});
		}

		if (page.url.searchParams.has("token")) {
			const token = page.url.searchParams.get("token");

			await fetch(`${base}/api/user/validate-token`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ token }),
			}).then(() => {
				goto(`${base}/`, { invalidateAll: true });
			});
		}

		window.addEventListener("keydown", onKeydown, { capture: true });
	});

	let mobileNavTitle = $derived(
		["/models", "/privacy"].includes(page.route.id ?? "")
			? ""
			: page.route.id === "/projects/[id]"
				? $projectTitle || m["app.layout.project"]()
				: page.route.id === "/code"
					? // The agent screen names itself once the daemon answers.
						codeNav.agentTitle || m["app.layout.agents"]()
					: convsStore.list.find((conv) => conv.id === page.params.id)?.title
	);
</script>

<svelte:head>
	<title>{m["app.layout.title"]({ name: publicConfig.PUBLIC_APP_NAME })}</title>
	<meta name="description" content={publicConfig.PUBLIC_APP_DESCRIPTION} />

	<!-- use those meta tags everywhere except on special listing pages -->
	<!-- feel free to refacto if there's a better way -->
	{#if !page.url.pathname.includes("/models/")}
		<meta name="twitter:card" content="summary_large_image" />
		<meta
			name="twitter:title"
			content={m["app.layout.title"]({ name: publicConfig.PUBLIC_APP_NAME })}
		/>
		<meta name="twitter:description" content={publicConfig.PUBLIC_APP_DESCRIPTION} />
		<meta
			name="twitter:image"
			content="{publicConfig.PUBLIC_ORIGIN ||
				page.url.origin}{publicConfig.assetPath}/thumbnail.png"
		/>
		<meta
			name="twitter:image:alt"
			content={m["app.layout.preview"]({ name: publicConfig.PUBLIC_APP_NAME })}
		/>
		<meta
			property="og:title"
			content={m["app.layout.title"]({ name: publicConfig.PUBLIC_APP_NAME })}
		/>
		<meta property="og:type" content="website" />
		<meta property="og:url" content="{publicConfig.PUBLIC_ORIGIN || page.url.origin}{base}" />
		<meta property="og:image" content="{publicConfig.assetPath}/thumbnail.png" />
		<meta property="og:description" content={publicConfig.PUBLIC_APP_DESCRIPTION} />
		<meta property="og:site_name" content={publicConfig.PUBLIC_APP_NAME} />
		<meta property="og:locale" content="en_US" />
	{/if}
	<link rel="icon" href="{publicConfig.assetPath}/icon.svg?v=2" type="image/svg+xml" />
	{#if publicConfig.PUBLIC_ORIGIN}
		<link
			rel="icon"
			href="{publicConfig.assetPath}/favicon.svg?v=2"
			type="image/svg+xml"
			media="(prefers-color-scheme: light)"
		/>
		<link
			rel="icon"
			href="{publicConfig.assetPath}/favicon-dark.svg?v=2"
			type="image/svg+xml"
			media="(prefers-color-scheme: dark)"
		/>
	{:else}
		<link rel="icon" href="{publicConfig.assetPath}/favicon-dev.svg?v=2" type="image/svg+xml" />
	{/if}
	<link rel="apple-touch-icon" href="{publicConfig.assetPath}/apple-touch-icon.png?v=2" />
	<!-- The manifest is served from a route (base-aware URLs). -->
	<link rel="manifest" href="{base}/manifest.webmanifest" />

	{#if publicConfig.PUBLIC_PLAUSIBLE_SCRIPT_URL}
		<script async src={publicConfig.PUBLIC_PLAUSIBLE_SCRIPT_URL}></script>
	{/if}

	{#if publicConfig.PUBLIC_APPLE_APP_ID}
		<meta name="apple-itunes-app" content={`app-id=${publicConfig.PUBLIC_APPLE_APP_ID}`} />
	{/if}
</svelte:head>

<NavigationLoadingBar />

<div
	class="fixed grid h-[var(--app-dvh,100dvh)] w-screen grid-cols-1 grid-rows-[auto_1fr] overflow-hidden pb-[env(safe-area-inset-bottom)] text-smd {!isNavCollapsed
		? 'md:grid-cols-[var(--nav-width)_1fr]'
		: 'md:grid-cols-[0px_1fr]'} transition-[300ms] [transition-property:grid-template-columns] md:grid-rows-[1fr] dark:text-gray-300"
>
	<ExpandNavigation
		isCollapsed={isNavCollapsed}
		onClick={() => (isNavCollapsed = !isNavCollapsed)}
		classNames="absolute inset-y-0 z-10 my-auto {!isNavCollapsed
			? 'left-(--nav-width)'
			: 'left-0'} *:transition-transform"
	/>

	<MobileNav title={mobileNavTitle}>
		<NavMenu
			conversations={convsStore.list}
			user={data.user}
			gatewayIsAdmin={data.gatewayIsAdmin}
			codeAgentsEnabled={data.codeAgentsEnabled}
			ondeleteConversation={(id) => deleteConversation(id)}
			oneditConversationTitle={(payload) => editConversationTitle(payload.id, payload.title)}
		/>
	</MobileNav>
	<nav
		class="grid max-h-dvh grid-cols-1 grid-rows-[auto_1fr_auto_auto] overflow-hidden *:w-(--nav-width) max-md:hidden"
	>
		<NavMenu
			conversations={convsStore.list}
			user={data.user}
			gatewayIsAdmin={data.gatewayIsAdmin}
			codeAgentsEnabled={data.codeAgentsEnabled}
			ondeleteConversation={(id) => deleteConversation(id)}
			oneditConversationTitle={(payload) => editConversationTitle(payload.id, payload.title)}
		/>
	</nav>
	{#if currentError}
		<Toast message={currentError} />
	{/if}
	<GenerationLiveWatcher />
	<NotificationToasts />
	<UpdateBanner show={updated.current} />
	{@render children?.()}

	{#if publicConfig.PUBLIC_PLAUSIBLE_SCRIPT_URL}
		<script>
			((window.plausible =
				window.plausible ||
				function () {
					(plausible.q = plausible.q || []).push(arguments);
				}),
				(plausible.init =
					plausible.init ||
					function (i) {
						plausible.o = i || {};
					}));
			plausible.init();
		</script>
	{/if}
</div>
