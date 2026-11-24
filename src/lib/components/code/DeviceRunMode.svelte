<!--
	How this computer's galopin is kept running, in the Agents panel: a short label under the
	computer's row that opens (a disclosure, keyboard and screen-reader friendly, not a hover
	tooltip) to say what that means and how to stop or remove it. galopin reports it in its hello
	(`agent.runMode`); an older galopin reports none and nothing is shown.
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
	<details
		class="mb-1 ml-7 text-[11px] text-ink-muted"
		data-testid="device-run-mode"
		data-mode={mode}
	>
		<summary class="cursor-pointer select-none">
			{mode === "service"
				? m["code.nav.run_mode_service"]()
				: mode === "system_service"
					? m["code.nav.run_mode_system_service"]()
					: mode === "terminal"
						? m["code.nav.run_mode_terminal"]()
						: mode === "mac_app"
							? m["code.nav.run_mode_mac_app"]()
							: m["code.nav.run_mode_docker"]()}
		</summary>
		<p class="mt-0.5" data-testid="device-run-mode-help">
			{mode === "service"
				? m["code.nav.run_mode_service_title"]()
				: mode === "system_service"
					? m["code.nav.run_mode_system_service_title"]()
					: mode === "terminal"
						? m["code.nav.run_mode_terminal_title"]()
						: mode === "mac_app"
							? m["code.nav.run_mode_mac_app_title"]()
							: m["code.nav.run_mode_docker_title"]()}
		</p>
	</details>
{/if}
