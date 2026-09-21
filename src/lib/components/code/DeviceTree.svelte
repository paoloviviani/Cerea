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
-->
<script lang="ts">
	import { base } from "$app/paths";
	import IconAdd from "~icons/carbon/add";
	import IconTrash from "~icons/carbon/trash-can";
	import IconLaptop from "~icons/carbon/laptop";
	import IconRenew from "~icons/carbon/renew";
	import IconWarning from "~icons/carbon/warning-filled";
	import type { CodeDeviceView } from "$lib/codeApi";
	import * as s from "$lib/components/overlay/styles";

	interface Props {
		devices: CodeDeviceView[];
		loading: boolean;
		failure: string | null;
		selectedId?: string;
		onpair: () => void;
		onrevoke: (id: string) => void;
		onretry: () => void;
	}

	let { devices, loading, failure, selectedId, onpair, onrevoke, onretry }: Props = $props();

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
