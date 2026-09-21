<!--
	The `/code` panel: a full-screen remote-control surface for coding agents.

	NOT a chat mode — a mode is conversation-bound, and this surface has no
	conversation. It is a top-level route (`/code`), reached from the sidebar
	footer and gated on the deployment flag, that drives the paseo daemon
	through the Cerea server.

	**The address is the selection.** `?device=` picks the paired device;
	`?ws=` and `?agent=` pick the daemon's workspace and session (Phase 2
	reads those live through the forwarder; Phase 1 parses them so links keep
	working, and the main pane says what is still to come). A new address
	remounts, exactly as a fresh WorkspacePanel tab does.

	h-full and min-h-0 bound this frame to the row the root layout gives it,
	mirroring WorkspacePanel: the root shell is `fixed h-dvh
	overflow-hidden`, so the page scrolls in its own pane under the pinned
	header. The device list loads in `onMount`, never in the component body —
	a page body runs on the server and a relative fetch there 502s.
-->
<script lang="ts">
	import { onMount } from "svelte";
	import { page } from "$app/state";
	import { base } from "$app/paths";
	import { goto } from "$app/navigation";
	import IconCode from "~icons/carbon/code";
	import IconLaptop from "~icons/carbon/laptop";
	import DeviceTree from "./DeviceTree.svelte";
	import PairDeviceDialog from "./PairDeviceDialog.svelte";
	import { listDevices, revokeDevice, type CodeDeviceView } from "$lib/codeApi";
	import * as s from "$lib/components/overlay/styles";

	interface Props {
		/** The deployment flag. The route 404s without it; this is the backstop message. */
		enabled: boolean;
	}

	let { enabled }: Props = $props();

	let devices = $state<CodeDeviceView[]>([]);
	let loading = $state(true);
	let failure = $state<string | null>(null);
	let pairingOpen = $state(false);

	// The address is the selection. `ws` and `agent` name the daemon's own
	// workspace and session: Phase 2 reads them live, Phase 1 only keeps them
	// in the address so links written now still land later.
	const selectedDeviceId = $derived(page.url.searchParams.get("device") ?? undefined);
	const selectedWorkspaceId = $derived(page.url.searchParams.get("ws") ?? undefined);
	const selectedAgentId = $derived(page.url.searchParams.get("agent") ?? undefined);
	const selected = $derived(devices.find((d) => d.id === selectedDeviceId));

	async function load() {
		failure = null;
		try {
			devices = (await listDevices()).devices;
		} catch (err) {
			failure = err instanceof Error ? err.message : "Could not load paired devices.";
		} finally {
			loading = false;
		}
	}

	onMount(() => void load());

	async function handleRevoke(id: string) {
		try {
			await revokeDevice(id);
			devices = devices.filter((d) => d.id !== id);
			if (selectedDeviceId === id) {
				await goto(`${base}/code`, { keepFocus: true });
			}
		} catch (err) {
			failure = err instanceof Error ? err.message : "Could not revoke the device.";
		}
	}

	function handlePaired(device: CodeDeviceView) {
		devices = [device, ...devices.filter((d) => d.id !== device.id)];
		void goto(`${base}/code?device=${device.id}`, { keepFocus: true });
	}
</script>

<div class="mx-auto flex h-full min-h-0 w-full max-w-5xl flex-col gap-6 p-6">
	<header class="flex flex-col gap-1">
		<h1 class="flex items-center gap-2 text-xl font-semibold">
			<IconCode class="size-5" />
			Code Agents
		</h1>
		<p class="text-sm text-gray-500 dark:text-gray-400">
			Drive the coding agents on your own machines, through a paired device.
		</p>
	</header>

	{#if !enabled}
		<div class={s.EMPTY}>
			<IconCode class={s.EMPTY_ICON} />
			<p class={s.EMPTY_TITLE}>Coding agents are not enabled</p>
			<p class={s.EMPTY_DETAIL}>This deployment has no paseo overlay beside it.</p>
		</div>
	{:else}
		<div class="grid min-h-0 flex-1 grid-cols-1 gap-6 md:grid-cols-[280px_1fr]">
			<aside class="scrollbar-custom min-h-0 overflow-y-auto">
				<DeviceTree
					{devices}
					{loading}
					{failure}
					selectedId={selectedDeviceId}
					onpair={() => (pairingOpen = true)}
					onrevoke={(id) => void handleRevoke(id)}
					onretry={() => {
						loading = true;
						void load();
					}}
				/>
			</aside>

			<div class="scrollbar-custom min-h-0 overflow-y-auto">
				{#key `${selectedDeviceId ?? ""}:${selectedWorkspaceId ?? ""}:${selectedAgentId ?? ""}`}
					{#if loading}
						<div class={s.EMPTY}>
							<IconLaptop class={s.EMPTY_ICON} />
							<p class={s.EMPTY_TITLE}>Loading…</p>
						</div>
					{:else if selectedAgentId}
						<!-- Phase 2: the live agent view (timeline, diff, composer,
						     permissions) mounts here, read from the daemon through
						     the forwarder and the SSE bridge. -->
						<div class={s.EMPTY}>
							<IconCode class={s.EMPTY_ICON} />
							<p class={s.EMPTY_TITLE}>Agent view is on its way</p>
							<p class={s.EMPTY_DETAIL}>
								Live transcripts, diffs and approvals land with the daemon connection.
							</p>
						</div>
					{:else if selected}
						<div class={s.EMBEDDED}>
							<div class="p-6">
								<div class={s.HEADER}>
									<h2 class={s.TITLE}>{selected.name}</h2>
									<p class={s.SUBTITLE}>
										{selected.status === "paired"
											? "Paired. Its workspaces and agents will list here once the daemon is connected."
											: "Pairing is not finished: approve the code on the device, or revoke it and start over."}
									</p>
								</div>
								{#if selected.status === "pending" && selected.pairingCode}
									<div class="mb-4 rounded-lg bg-sunken p-4 text-center">
										<p class="text-xs text-ink-muted">On {selected.name}, run</p>
										<p class="mt-1 font-mono text-lg font-semibold tracking-widest text-ink">
											paseo pair {selected.pairingCode}
										</p>
									</div>
								{/if}
								<div class={s.TIPS}>
									<h4 class={s.TIPS_TITLE}>Quick Tips</h4>
									<ul class={s.TIPS_LIST}>
										<li>• Live agent state stays on the daemon; Cerea keeps only the pairing.</li>
										<li>• Revoking removes the pairing — nothing on the machine is touched.</li>
									</ul>
								</div>
							</div>
						</div>
					{:else}
						<div class={s.EMPTY}>
							<IconLaptop class={s.EMPTY_ICON} />
							<p class={s.EMPTY_TITLE}>
								{devices.length === 0 ? "No device selected" : "Select a device"}
							</p>
							<p class={s.EMPTY_DETAIL}>
								{devices.length === 0
									? "Pair the machine your coding agents run on to begin."
									: "Pick a paired device on the left to manage it."}
							</p>
						</div>
					{/if}
				{/key}
			</div>
		</div>
	{/if}
</div>

{#if pairingOpen}
	<PairDeviceDialog onclose={() => (pairingOpen = false)} onpaired={handlePaired} />
{/if}
