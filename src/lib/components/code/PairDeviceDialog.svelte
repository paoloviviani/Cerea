<!--
	Pair a machine: run the agent, then confirm it here.

	The old two-step dialog (name it, wait for a pasted offer) is gone with
	paseo. `pystino-agent` enrolls itself against this deployment's own OIDC
	issuer and dials out with that credential (spec §3-4) — there is nothing
	to paste. It appears below as soon as it checks in, in `pending`; nothing
	is forwarded to it until this dialog's Confirm click flips it to
	`paired` — the fresh human approval a phished device-code approval alone
	never reaches (review C2). Reject is the same tombstoning action as
	revoking a paired machine (spec §4): the row becomes `revoked` and a
	reconnect under the same machine id is refused from then on.

	The pending list here is the same shared poll `CodeNavTree` shows in the
	sidebar (`codeDeviceList.svelte.ts`) — confirming from either place closes
	this dialog via `onpaired`.
-->
<script lang="ts">
	import { onMount } from "svelte";
	import { page } from "$app/state";
	import { base } from "$app/paths";
	import Modal from "$lib/components/Modal.svelte";
	import CopyToClipBoardBtn from "$lib/components/CopyToClipBoardBtn.svelte";
	import IconLaptop from "~icons/carbon/laptop";
	import IconWarning from "~icons/carbon/warning-filled";
	import IconCheck from "~icons/carbon/checkmark";
	import IconClose from "~icons/carbon/close";
	import { confirmDevice, revokeDevice, type CodeDeviceView } from "$lib/codeApi";
	import {
		codeDeviceList,
		refreshCodeDevices,
		useCodeDevicePoll,
	} from "$lib/stores/codeDeviceList.svelte";
	import { usePublicConfig } from "$lib/utils/PublicConfig.svelte";
	import * as s from "$lib/components/overlay/styles";

	interface Props {
		onclose: () => void;
		onpaired: (device: CodeDeviceView) => void;
	}

	let { onclose, onpaired }: Props = $props();

	const publicConfig = usePublicConfig();
	// The deployment's own origin plus the app's base path — the machine dials
	// out to `<this>/api/v2/code/machine` (`X-Pystino-Machine-*` headers, spec
	// §3) over WSS. Behind the Pystino stack the chat is built with
	// APP_BASE=/chat while PUBLIC_ORIGIN is the bare origin, so without the base
	// the printed command would send the machine to the gateway.
	const origin = $derived(
		(publicConfig.PUBLIC_ORIGIN || page.url.origin).replace(/\/+$/, "") + base
	);
	const commands = $derived([`pystino-agent enroll --cerea ${origin}`, "pystino-agent run"]);

	let busy = $state<string | null>(null);
	let failure = $state<string | null>(null);

	const pending = $derived(codeDeviceList.devices.filter((device) => device.status === "pending"));

	onMount(() => useCodeDevicePoll());

	async function confirm(device: CodeDeviceView) {
		busy = device.id;
		failure = null;
		try {
			await confirmDevice(device.id);
			await refreshCodeDevices();
			onpaired(device);
		} catch (err) {
			failure = err instanceof Error ? err.message : "Could not confirm the machine.";
		} finally {
			busy = null;
		}
	}

	async function reject(device: CodeDeviceView) {
		busy = device.id;
		failure = null;
		try {
			await revokeDevice(device.id);
			await refreshCodeDevices();
		} catch (err) {
			failure = err instanceof Error ? err.message : "Could not reject the machine.";
		} finally {
			busy = null;
		}
	}
</script>

<Modal width="max-w-md" closeButton labelledBy="pair-device-title" {onclose}>
	<div class="p-4 sm:p-6">
		<div class="mb-6 flex items-center gap-3">
			<div class="{s.STRIP_TILE} shrink-0">
				<IconLaptop class="size-5 text-blue-600" />
			</div>
			<div class="min-w-0 pr-8">
				<h2 id="pair-device-title" class={s.TITLE}>Pair a machine</h2>
				<p class="{s.SUBTITLE} break-words">
					Run these on the machine your coding agents run on, then confirm it below.
				</p>
			</div>
		</div>

		{#if failure}
			<div class="{s.ERROR} mb-4">
				<p class="flex items-center gap-1.5 font-medium">
					<IconWarning class="size-4" />
					{failure}
				</p>
			</div>
		{/if}

		<div class="mb-4 flex items-center gap-2 rounded-lg bg-sunken p-4">
			<p class="min-w-0 flex-1 text-xs text-ink-muted">
				`enroll` signs the machine into your account with this deployment's identity provider; `run`
				starts the agent, which dials out here and appears below once it checks in.
			</p>
			<CopyToClipBoardBtn
				classNames="flex size-8 shrink-0 items-center justify-center rounded-lg border border-line bg-surface text-ink-muted hover:bg-sunken"
				value={commands.join("\n")}
			/>
		</div>
		<div class="rounded-lg border border-line bg-surface p-3">
			{#each commands as command (command)}
				<p class="font-mono text-xs break-all text-ink">{command}</p>
			{/each}
		</div>

		<p class="{s.LABEL} mt-6">Waiting for confirmation</p>
		{#if pending.length === 0}
			<p class="mt-1 text-xs text-ink-muted">No machine has checked in yet.</p>
		{:else}
			<ul class="mt-2 flex flex-col gap-2">
				{#each pending as device (device.id)}
					<li class="flex items-center gap-2 rounded-lg border border-line bg-surface p-2">
						<IconLaptop class="size-4 shrink-0 text-ink-muted" />
						<span class="min-w-0 flex-1 truncate text-sm text-ink">{device.name}</span>
						<button
							type="button"
							class="flex h-7 items-center gap-1 rounded-lg bg-blue-600 px-2 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-60"
							disabled={busy === device.id}
							onclick={() => void confirm(device)}
						>
							<IconCheck class="size-3.5" />
							Confirm
						</button>
						<button
							type="button"
							class="flex h-7 items-center gap-1 rounded-lg border border-line px-2 text-xs font-medium text-ink-muted hover:bg-sunken disabled:opacity-60"
							disabled={busy === device.id}
							onclick={() => void reject(device)}
						>
							<IconClose class="size-3.5" />
							Reject
						</button>
					</li>
				{/each}
			</ul>
		{/if}

		<div class="mt-4 flex justify-end">
			<button type="button" onclick={onclose} class={s.SECONDARY}>Close</button>
		</div>
	</div>
</Modal>
