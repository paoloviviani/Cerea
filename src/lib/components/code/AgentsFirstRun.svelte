<!--
	The Agents first screen when no computer is paired: what an agent is, and the
	one step that starts it. Without it the main pane stayed the ordinary chat
	first screen while the sidebar said Agents, and nothing explained the switch.
-->
<script lang="ts">
	import { goto } from "$app/navigation";
	import { base } from "$app/paths";
	import { m } from "$lib/paraglide/messages";
	import IconLaptop from "~icons/carbon/laptop";
	import PairDeviceDialog from "./PairDeviceDialog.svelte";
	import { refreshCodeDevices } from "$lib/stores/codeDeviceList.svelte";
	import type { CodeDeviceView } from "$lib/codeApi";
	import * as s from "$lib/components/overlay/styles";

	let pairing = $state(false);

	function paired(device: CodeDeviceView) {
		pairing = false;
		void refreshCodeDevices();
		void goto(`${base}/code?device=${device.id}`, { keepFocus: true });
	}
</script>

<div
	class="pointer-events-auto m-auto flex max-w-sm flex-col items-center px-6 py-10 text-center"
	data-testid="agents-first-run"
>
	<IconLaptop class="mb-4 size-8 text-ink-faint" />
	<h1 class="mb-2 text-lg font-semibold text-ink">{m["code.first_run.title"]()}</h1>
	<p class="mb-5 text-sm text-ink-muted">{m["code.first_run.body"]()}</p>
	<button type="button" class={s.PRIMARY} onclick={() => (pairing = true)}>
		{m["code.first_run.connect"]()}
	</button>
</div>

{#if pairing}
	<PairDeviceDialog onclose={() => (pairing = false)} onpaired={paired} />
{/if}
