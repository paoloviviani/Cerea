<!--
	Start a pairing, and finish one.

	Two steps in one dialog rather than two screens: naming the machine, then
	completing the handshake. The person runs `paseo daemon pair` on the
	machine — which prints a pairing link — and pastes that link here; Cerea
	verifies the single-use code against this person's pending row and
	completes the encrypted handshake through the relay before recording the
	pairing. A failed handshake is a failed pairing, not a row that pretends.
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
	let offer = $state("");
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
		if (!device?.pairingCode || !offer.trim() || busy) return;
		busy = true;
		failure = null;
		try {
			const paired = await claimPairing(device.pairingCode, offer.trim());
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
						: "Bring the pairing link back from that machine."}
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
			<div class="mb-4 rounded-lg bg-sunken p-4">
				<p class="text-center text-xs text-ink-muted">
					On <span class="font-medium">{device.name}</span>, run
					<span class="mt-1 block font-mono text-lg font-semibold tracking-widest text-ink">
						paseo daemon pair
					</span>
					and paste the pairing link it prints. The code
					<span class="font-mono font-semibold text-ink">{device.pairingCode}</span> proves the pairing
					is yours.
				</p>
			</div>
			<form
				onsubmit={(e) => {
					e.preventDefault();
					void handleClaim();
				}}
			>
				<label class={s.LABEL} for="pair-device-offer">Pairing link</label>
				<textarea
					id="pair-device-offer"
					class="{s.INPUT} h-24 font-mono text-xs"
					placeholder="https://app.paseo.sh/#offer=…"
					bind:value={offer}
					disabled={busy}
				></textarea>
				<p class={s.HINT}>
					Cerea connects to the daemon through the relay with this link before the pairing is
					recorded. The code expires with the row; the link is single-use.
				</p>
				<div class="mt-4 flex justify-end gap-2">
					<button type="button" onclick={onclose} class={s.SECONDARY} disabled={busy}>
						Later
					</button>
					<button type="submit" class={s.PRIMARY} disabled={!offer.trim() || busy}>
						<IconCheckmark class="size-4" />
						{busy ? "Confirming…" : "Complete pairing"}
					</button>
				</div>
			</form>
		{/if}
	</div>
</Modal>
