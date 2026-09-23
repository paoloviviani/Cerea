<!--
	The agent screen: one coding session, opened the way a chat is.

	The sidebar's Agents panel (the switch at the foot of the chat list)
	owns devices, workspaces and every mutating action; this pane only
	**shows** what the address names — `?device=&ws=&agent=`. On a phone
	that is the whole screen under the top bar, exactly like a
	conversation; on a desktop it fills the pane beside the rail. There is
	deliberately no page header: the agent's own header and the mobile top
	bar carry the title.

	A new address remounts ({#key}), so both tabs fetch fresh and never see
	a stale agent. h-full and min-h-0 bind this frame to the row the root
	layout gives it; the page scrolls in its own panes under pinned bars.
-->
<script lang="ts">
	import { onMount } from "svelte";
	import { page } from "$app/state";
	import { browser } from "$app/environment";
	import IconCode from "~icons/carbon/code";
	import IconLaptop from "~icons/carbon/laptop";
	import AgentView from "./AgentView.svelte";
	import { checkEnrollment, listDevices, type CodeDeviceView } from "$lib/codeApi";
	import { codeNav } from "$lib/stores/codeNav.svelte";
	import { codeEnrollment } from "$lib/stores/codeEnrollment.svelte";
	import { openMobileNav } from "$lib/components/MobileNav.svelte";
	import * as s from "$lib/components/overlay/styles";

	interface Props {
		/** The deployment flag. The route 404s without it; this is the backstop message. */
		enabled: boolean;
	}

	let { enabled }: Props = $props();

	let devices = $state<CodeDeviceView[]>([]);
	let loading = $state(true);

	// The address is the selection; `ws` rides along so the sidebar can
	// highlight the workspace the session belongs to, and the agent screen
	// can name the workspace in its strip without guessing.
	const selectedDeviceId = $derived(page.url.searchParams.get("device") ?? undefined);
	const selectedAgentId = $derived(page.url.searchParams.get("agent") ?? undefined);
	const selectedWorkspaceId = $derived(page.url.searchParams.get("ws") ?? undefined);
	const selected = $derived(devices.find((d) => d.id === selectedDeviceId));

	/** Quiet on every call after the first: `loading` only ever flips false
	 * here, so a poll or a focus refetch never re-shows the loading state —
	 * the list just redraws when the daemon's word changed. */
	async function loadDevices() {
		try {
			devices = (await listDevices()).devices;
		} catch {
			// The agent view carries its own states; the address renders
			// regardless, and a failed device read only dulls the fallbacks.
			devices = [];
		} finally {
			loading = false;
		}
	}

	// A device paired from elsewhere (a headless `enroll pair`, another tab,
	// the sidebar's own pairing dialog) must show up here without a page
	// reload: poll on a sensible cadence while this pane is mounted, and
	// refetch the moment the tab regains focus — the two ways this list goes
	// stale between polls.
	const DEVICES_POLL_MS = 8000;
	onMount(() => {
		void loadDevices();
		const interval = setInterval(() => void loadDevices(), DEVICES_POLL_MS);
		const onFocus = () => void loadDevices();
		window.addEventListener("focus", onFocus);
		return () => {
			clearInterval(interval);
			window.removeEventListener("focus", onFocus);
		};
	});

	// The enrollment probe: on agent open and on every device switch (the
	// same two triggers the task calls for), ask the daemon to prove its
	// stored credentials are still good — before the person types anything,
	// not after a doomed send. Keyed on the address's device+agent so
	// switching agents on the same device re-probes too, and a stale answer
	// from a since-abandoned address never overwrites the current one.
	$effect(() => {
		const deviceId = selectedDeviceId;
		const agentId = selectedAgentId;
		void agentId;
		if (!deviceId) return;
		let cancelled = false;
		void checkEnrollment(deviceId).then((status) => {
			if (!cancelled) codeEnrollment[deviceId] = status;
		});
		return () => {
			cancelled = true;
		};
	});

	/** The empty panes point at the Agents panel, which is where pairing
	 * and every other action now live. On a phone that means opening the
	 * drawer with the panel switched. */
	function openAgentsPanel() {
		codeNav.view = "agents";
		if (browser && window.innerWidth < 768) openMobileNav();
	}
</script>

<!-- pointer-events-none: the agent screen nests the message column, which
     paints at z-[-1] (ChatMessageColumn's own contract) — any
     pointer-enabled wrapper above it intercepts clicks meant for the
     composer. Every branch here re-enables pointer events itself, the
     ChatWindow contract (its own tree does the same above the column). -->
<div class="pointer-events-none flex h-full min-h-0 flex-col overflow-hidden">
	{#if !enabled}
		<div class="pointer-events-auto {s.EMPTY}">
			<IconCode class={s.EMPTY_ICON} />
			<p class={s.EMPTY_TITLE}>Coding agents are not enabled</p>
			<p class={s.EMPTY_DETAIL}>This deployment has no paseo overlay beside it.</p>
		</div>
	{:else}
		{#key `${selectedDeviceId ?? ""}:${selectedAgentId ?? ""}`}
			{#if selectedAgentId && selectedDeviceId}
				<AgentView
					deviceId={selectedDeviceId}
					agentId={selectedAgentId}
					workspaceId={selectedWorkspaceId}
					deviceName={selected?.name}
				/>
			{:else if loading}
				<div class="pointer-events-auto {s.EMPTY}">
					<IconLaptop class={s.EMPTY_ICON} />
					<p class={s.EMPTY_TITLE}>Loading…</p>
				</div>
			{:else if selected?.status === "pending" && selected.pairingCode}
				<div class="pointer-events-auto scrollbar-custom min-h-0 flex-1 overflow-y-auto p-6">
					<div class={s.EMBEDDED}>
						<div class="p-6">
							<div class={s.HEADER}>
								<h2 class={s.TITLE}>{selected.name}</h2>
								<p class={s.SUBTITLE}>
									Pairing is not finished: approve the code on the device, or revoke it and start
									over.
								</p>
							</div>
							<div class="mb-4 rounded-lg bg-sunken p-4">
								<p class="text-center text-xs text-ink-muted">
									On {selected.name}, run
									<span class="mt-1 block font-mono text-lg font-semibold tracking-widest text-ink">
										paseo daemon pair
									</span>
									and paste the link under "Pair" in the Agents panel to finish.
								</p>
							</div>
						</div>
					</div>
				</div>
			{:else}
				<!-- The empty state is deliberately small and generously
				     surrounded: a faint dashed box adrift in the pane reads as
				     "nothing here yet", while a full-width panel would read as
				     a surface to work in. Local classes, not `s.EMPTY` — the
				     shared constants size for settings pages, not this pane. -->
				<div
					class="pointer-events-auto scrollbar-custom flex min-h-0 flex-1 overflow-y-auto p-8 sm:p-24"
				>
					<div
						class="m-auto flex w-full max-w-xs flex-col items-center rounded-lg border-2 border-dashed border-line-strong px-8 py-10 text-center sm:px-14 sm:py-14"
					>
						<IconLaptop class="mb-3 size-7 text-ink-faint" />
						<p class="mb-1 text-xs font-medium text-ink">
							{devices.length === 0 ? "No paired devices" : "No agent selected"}
						</p>
						<p class="mb-4 text-xs text-ink-muted">
							{devices.length === 0
								? "Pair the machine your coding agents run on to begin."
								: "Pick a session from the Agents panel in the sidebar."}
						</p>
						<button onclick={openAgentsPanel} class={s.PRIMARY}>
							<IconCode class="size-4" />
							Open Agents panel
						</button>
					</div>
				</div>
			{/if}
		{/key}
	{/if}
</div>
