<!--
	Paired devices, as a rail: one row per machine running the paseo daemon.

	The list is passed in — `CodePanel` owns it, so pairing, revoking and the
	detail view all read the same rows from one fetch. Selection is the
	address (`/code?device=<id>`), never local state, so a row links rather
	than opens: a copied URL lands on the same device.

	Phase 2 grows each paired device into device → workspace → agent, with the
	workspaces and agents read live from the daemon through the forwarder.
	Phase 1 rows are devices only, because without a daemon there is nothing
	under them yet — and the panel must read cleanly in exactly that state.
	With the flag on and no daemon behind it, the hierarchy below reads as a
	muted "daemon not connected" note, never an error.
-->
<script lang="ts">
	import { base } from "$app/paths";
	import { goto } from "$app/navigation";
	import IconAdd from "~icons/carbon/add";
	import IconTrash from "~icons/carbon/trash-can";
	import IconLaptop from "~icons/carbon/laptop";
	import IconFolder from "~icons/carbon/folder";
	import IconCode from "~icons/carbon/code";
	import IconRenew from "~icons/carbon/renew";
	import IconWarning from "~icons/carbon/warning-filled";
	import { listWorkspaces, listWorkspaceAgents, type CodeDeviceView } from "$lib/codeApi";
	import type { CodeAgentSession, CodeWorkspace } from "$lib/types/CodeAgent";
	import * as s from "$lib/components/overlay/styles";
	import WorkspaceDialog from "./WorkspaceDialog.svelte";
	import AgentDialog from "./AgentDialog.svelte";

	interface Props {
		devices: CodeDeviceView[];
		loading: boolean;
		failure: string | null;
		selectedId?: string;
		selectedWorkspaceId?: string;
		selectedAgentId?: string;
		onpair: () => void;
		onrevoke: (id: string) => void;
		onretry: () => void;
	}

	let {
		devices,
		loading,
		failure,
		selectedId,
		selectedWorkspaceId,
		selectedAgentId,
		onpair,
		onrevoke,
		onretry,
	}: Props = $props();

	// Live hierarchy under the selected paired device. Owned here, not by the
	// panel: device rows are Cerea's records, everything under them is the
	// daemon's live state — a rendering concern, never stored.
	let workspaces = $state<CodeWorkspace[]>([]);
	let agents = $state<CodeAgentSession[]>([]);
	let hierarchyLoading = $state(false);
	let daemonOff = $state(false);
	let hierarchyFor = $state("");
	let workspaceDialogFor = $state<string | null>(null);
	let agentDialogFor = $state<CodeWorkspace | null>(null);

	async function loadHierarchy() {
		const device = devices.find((d) => d.id === selectedId);
		if (!device || device.status !== "paired") {
			workspaces = [];
			agents = [];
			daemonOff = false;
			hierarchyLoading = false;
			return;
		}
		hierarchyLoading = true;
		daemonOff = false;
		try {
			workspaces = (await listWorkspaces(device.id)).workspaces;
			agents = selectedWorkspaceId
				? (await listWorkspaceAgents(device.id, selectedWorkspaceId)).agents
				: [];
		} catch {
			// 404 (path not offered) or 502 (no daemon behind it): the panel
			// reads cleanly either way, with the hierarchy quietly absent.
			daemonOff = true;
			workspaces = [];
			agents = [];
		} finally {
			hierarchyLoading = false;
		}
	}

	// An effect, not the body and not onMount alone: the hierarchy follows the
	// address, and a page body runs on the server where effects never fire.
	// The device's presence is part of the key: on a hard load this effect
	// fires before the device rows arrive, and without it the key guard would
	// lock in the empty first run forever.
	$effect(() => {
		const device = devices.find((d) => d.id === selectedId);
		const key = `${selectedId ?? ""}:${selectedWorkspaceId ?? ""}:${device?.status ?? ""}`;
		if (key === hierarchyFor) return;
		hierarchyFor = key;
		void loadHierarchy();
	});

	function pill(device: CodeDeviceView): { tone: s.PillTone; label: string } {
		return device.status === "paired"
			? { tone: "good", label: "paired" }
			: { tone: "busy", label: "pairing" };
	}
</script>

<div class="flex flex-col gap-2">
	<div class="flex items-center justify-between">
		<h2 class={s.SECTION_TITLE}>Devices ({devices.length})</h2>
		<button onclick={onpair} class={s.CARD_ACTION} title="Pair a new device">
			<IconAdd class="size-3.5" />
			Pair
		</button>
	</div>

	{#if loading}
		<div class="flex items-center gap-2 px-1 py-6 text-sm text-ink-muted">
			<IconRenew class="size-4 animate-spin" />
			Loading paired devices…
		</div>
	{:else if failure}
		<div class={s.ERROR}>
			<p class="flex items-center gap-1.5 font-medium">
				<IconWarning class="size-4" />
				Could not load devices
			</p>
			<p class="mt-1">{failure}</p>
			<button onclick={onretry} class="{s.SECONDARY} mt-2">Retry</button>
		</div>
	{:else if devices.length === 0}
		<div class={s.EMPTY}>
			<IconLaptop class={s.EMPTY_ICON} />
			<p class={s.EMPTY_TITLE}>No paired devices</p>
			<p class={s.EMPTY_DETAIL}>Pair the machine your coding agents run on to begin.</p>
			<button onclick={onpair} class={s.PRIMARY}>
				<IconAdd class="size-4" />
				Pair a device
			</button>
		</div>
	{:else}
		<ul class="space-y-2">
			{#each devices as device (device.id)}
				{@const active = device.id === selectedId}
				{@const { tone, label } = pill(device)}
				<li class={s.card(active)}>
					<div class={s.CARD_BODY}>
						<div class="flex items-center gap-2">
							<IconLaptop class="size-4 shrink-0 text-ink-muted" />
							<a
								href="{base}/code?device={device.id}"
								class="min-w-0 flex-1 {s.CARD_TITLE} hover:underline"
								title={device.name}
							>
								{device.name}
							</a>
							<span class="{s.PILL} {s.PILL_TONES[tone]}">{label}</span>
						</div>
						{#if device.status === "pending" && device.pairingCode}
							<p class="mt-1.5 truncate font-mono text-xs text-ink-muted" title="Pairing code">
								code <span class="font-semibold text-ink">{device.pairingCode}</span>
							</p>
						{/if}
						{#if active && device.status === "paired"}
							<div class="mt-2 border-l border-line pl-2">
								{#if hierarchyLoading}
									<p class="flex items-center gap-1.5 py-1 text-xs text-ink-muted">
										<IconRenew class="size-3 animate-spin" />
										Reading daemon…
									</p>
								{:else if daemonOff}
									<p class="py-1 text-xs text-ink-faint">Daemon not connected.</p>
								{:else if workspaces.length === 0}
									<p class="py-1 text-xs text-ink-faint">No workspaces on the daemon.</p>
									<button
										onclick={() => (workspaceDialogFor = device.id)}
										class="{s.CARD_ACTION} mt-1"
										title="Serve a directory on this machine as a workspace"
									>
										<IconAdd class="size-3.5" />
										Add workspace
									</button>
								{:else}
									<div class="mb-1 flex items-center justify-between">
										<span class="text-xs font-medium text-ink-muted">Workspaces</span>
										<button
											onclick={() => (workspaceDialogFor = device.id)}
											class="{s.CARD_ACTION} -mr-1"
											title="Serve a directory on this machine as a workspace"
										>
											<IconAdd class="size-3.5" />
											Add
										</button>
									</div>
									<ul class="space-y-px">
										{#each workspaces as ws (ws.id)}
											{@const wsActive = ws.id === selectedWorkspaceId}
											<li>
												<a
													href="{base}/code?device={device.id}&ws={ws.id}"
													class="flex items-center gap-1.5 rounded px-1 py-1 text-xs {wsActive
														? 'font-semibold text-ink'
														: 'text-ink-muted hover:text-ink'}"
													title={ws.path}
												>
													<IconFolder class="size-3.5 shrink-0" />
													<span class="min-w-0 flex-1 truncate">{ws.name}</span>
												</a>
												{#if wsActive}
													<ul class="mt-px ml-4 space-y-px border-l border-line pl-2">
														{#each agents as agent (agent.id)}
															{@const agentActive = agent.id === selectedAgentId}
															<li>
																<a
																	href="{base}/code?device={device.id}&ws={ws.id}&agent={agent.id}"
																	class="flex items-center gap-1.5 rounded px-1 py-1 text-xs {agentActive
																		? 'font-semibold text-ink'
																		: 'text-ink-muted hover:text-ink'}"
																	title={agent.title}
																>
																	<IconCode class="size-3.5 shrink-0" />
																	<span class="min-w-0 flex-1 truncate">{agent.title}</span>
																	<span
																		class="size-1.5 shrink-0 rounded-full {agent.state ===
																			'running' || agent.state === 'waiting-permission'
																			? 'bg-blue-600'
																			: agent.state === 'error'
																				? 'bg-red-600'
																				: agent.state === 'done'
																					? 'bg-green-700'
																					: 'bg-gray-400'}"
																		title={agent.state}
																	></span>
																</a>
															</li>
														{/each}
														{#if agents.length === 0}
															<li class="px-1 py-1 text-xs text-ink-faint">No agents here.</li>
														{/if}
														<li>
															<button
																onclick={() => (agentDialogFor = ws)}
																class="{s.CARD_ACTION} mt-px"
																title="Start a coding session in this workspace"
															>
																<IconAdd class="size-3.5" />
																New agent
															</button>
														</li>
													</ul>
												{/if}
											</li>
										{/each}
									</ul>
								{/if}
							</div>
						{/if}
						<div class="mt-2 flex justify-end">
							<button
								onclick={() => onrevoke(device.id)}
								class={s.CARD_DESTRUCTIVE}
								title="Remove this pairing"
							>
								<IconTrash class="size-3.5" />
								Revoke
							</button>
						</div>
					</div>
				</li>
			{/each}
		</ul>
	{/if}
</div>

{#if workspaceDialogFor}
	<WorkspaceDialog
		deviceId={workspaceDialogFor}
		onclose={() => (workspaceDialogFor = null)}
		oncreated={() => {
			// The daemon is the source of truth; reload rather than splice.
			hierarchyFor = "";
			void loadHierarchy();
		}}
	/>
{/if}

{#if agentDialogFor}
	{@const dialogWorkspace = agentDialogFor}
	<AgentDialog
		deviceId={selectedId ?? ""}
		workspace={dialogWorkspace}
		onclose={() => (agentDialogFor = null)}
		oncreated={(agent) => {
			// Same discipline as a workspace: the daemon owns the truth, and
			// the address takes the person straight to their new session.
			hierarchyFor = "";
			void loadHierarchy();
			void goto(`${base}/code?device=${selectedId}&ws=${dialogWorkspace.id}&agent=${agent.id}`, {
				keepFocus: true,
			});
		}}
	/>
{/if}
