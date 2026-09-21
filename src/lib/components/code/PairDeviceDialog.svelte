<!--
	Start a pairing, and finish one.

	Two steps in one dialog rather than two screens: naming the machine, then
	the single-use code. The person types the code into their daemon
	(`paseo pair <code>`); until a live daemon calls back to complete the
	handshake, the second step's "I've approved it" button claims the pairing
	from here — that button is the stand-in for the daemon's callback, and
	says so, rather than pretending the daemon answered.
-->
<script lang="ts">
	import Modal from "$lib/components/Modal.svelte";
	import IconLaptop from "~icons/carbon/laptop";
	import IconCheckmark from "~icons/carbon/checkmark-filled";
	import IconWarning from "~icons/carbon/warning-filled";
	import { claimPairing, startPairing, type CodeDeviceView } from "$lib/codeApi";
	import * as s from "$lib/components/overlay/styles";

	interface Props {
		onclose: () => void;
		onpaired: (device: CodeDeviceView) => void;
	}

	let { onclose, onpaired }: Props = $props();

	type Step = "name" | "code";
	let step = $state<Step>("name");
	let name = $state("");
	let device = $state<CodeDeviceView | null>(null);
	let busy = $state(false);
	let failure = $state<string | null>(null);

	async function handleStart() {
		if (!name.trim() || busy) return;
		busy = true;
		failure = null;
		try {
			const created = await startPairing(name.trim());
			device = created.device;
			step = "code";
		} catch (err) {
			failure = err instanceof Error ? err.message : "Could not start pairing.";
		} finally {
			busy = false;
		}
	}

	async function handleClaim() {
		if (!device?.pairingCode || busy) return;
		busy = true;
		failure = null;
		try {
			const paired = await claimPairing(device.pairingCode);
			onpaired(paired.device);
			onclose();
		} catch (err) {
			failure = err instanceof Error ? err.message : "Could not complete pairing.";
		} finally {
			busy = false;
		}
	}
</script>

<Modal width="max-w-md" closeButton labelledBy="pair-device-title" {onclose}>
	<div class="p-6">
		<div class="mb-6 flex items-center gap-3">
			<div class={s.STRIP_TILE}>
				<IconLaptop class="size-5 text-blue-600" />
			</div>
			<div>
				<h2 id="pair-device-title" class={s.TITLE}>Pair a device</h2>
				<p class={s.SUBTITLE}>
					{step === "name"
						? "Name the machine your coding agents run on."
						: "Approve the pairing on that machine."}
				</p>
			</div>
		</div>

		{#if failure}
			<div class="{s.ERROR} mb-4">
				<p class="flex items-center gap-1.5 font-medium">
					<IconWarning class="size-4" />
					Pairing failed
				</p>
				<p class="mt-1">{failure}</p>
			</div>
		{/if}

		{#if step === "name"}
			<form
				onsubmit={(e) => {
					e.preventDefault();
					void handleStart();
				}}
			>
				<label class={s.LABEL} for="pair-device-name">Device name</label>
				<input
					id="pair-device-name"
					class={s.INPUT}
					placeholder="my laptop"
					maxlength={64}
					bind:value={name}
					disabled={busy}
				/>
				<p class={s.HINT}>Something you will recognise in the device list.</p>
				<div class="mt-4 flex justify-end gap-2">
					<button type="button" onclick={onclose} class={s.SECONDARY} disabled={busy}>
						Cancel
					</button>
					<button type="submit" class={s.PRIMARY} disabled={!name.trim() || busy}>
						{busy ? "Starting…" : "Start pairing"}
					</button>
				</div>
			</form>
		{:else if device}
			<div class="mb-4 rounded-lg bg-sunken p-4 text-center">
				<p class="text-xs text-ink-muted">On <span class="font-medium">{device.name}</span>, run</p>
				<p class="mt-1 font-mono text-lg font-semibold tracking-widest text-ink">
					paseo pair {device.pairingCode}
				</p>
				<p class="mt-1 text-xs text-ink-muted">The code is single-use and expires with the row.</p>
			</div>
			<div class={s.TIPS}>
				<h4 class={s.TIPS_TITLE}>Without a daemon yet?</h4>
				<ul class={s.TIPS_LIST}>
					<li>
						• "I've approved it" completes the pairing from here — it stands in for the daemon's
						callback until a live daemon calls back itself.
					</li>
					<li>• Revoking a device only removes the pairing; nothing on the machine is touched.</li>
				</ul>
			</div>
			<div class="mt-4 flex justify-end gap-2">
				<button onclick={onclose} class={s.SECONDARY} disabled={busy}>Later</button>
				<button onclick={() => void handleClaim()} class={s.PRIMARY} disabled={busy}>
					<IconCheckmark class="size-4" />
					{busy ? "Confirming…" : "I've approved it"}
				</button>
			</div>
		{/if}
	</div>
</Modal>
