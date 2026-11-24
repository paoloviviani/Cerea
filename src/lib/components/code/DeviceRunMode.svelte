<!--
	How this computer's galopin is kept running, in the Agents panel: a short label under the
	computer's row, the explanation (and how to stop or remove it) in its tooltip. galopin reports
	it in its hello (`agent.runMode`); an older galopin reports none and nothing is shown.
-->
<script lang="ts">
	import { m } from "$lib/paraglide/messages";
	import type { CodeDeviceView } from "$lib/server/codeDevices";
	import { knownRunMode } from "$lib/galopinRunMode";

	interface Props {
		device: CodeDeviceView;
	}

	let { device }: Props = $props();

	const mode = $derived(knownRunMode(device.agentRunMode));
</script>

{#if mode}
	<p
		class="mb-1 ml-7 text-[11px] text-ink-muted"
		data-testid="device-run-mode"
		data-mode={mode}
		title={mode === "service"
			? m["code.nav.run_mode_service_title"]()
			: mode === "terminal"
				? m["code.nav.run_mode_terminal_title"]()
				: mode === "mac_app"
					? m["code.nav.run_mode_mac_app_title"]()
					: m["code.nav.run_mode_docker_title"]()}
	>
		{mode === "service"
			? m["code.nav.run_mode_service"]()
			: mode === "terminal"
				? m["code.nav.run_mode_terminal"]()
				: mode === "mac_app"
					? m["code.nav.run_mode_mac_app"]()
					: m["code.nav.run_mode_docker"]()}
	</p>
{/if}
