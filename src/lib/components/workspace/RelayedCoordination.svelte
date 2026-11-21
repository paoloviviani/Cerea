<!--
	Workspace -> Agents: the switch for relayed coordination (ADR 0121). On by default, per user. When
	it is on, an agent on one of the user's computers can read, message and start sessions on
	another of theirs, always after a card the user answers. The administrator can switch the
	feature off for the whole service; then this says so and the switch does nothing.
-->
<script lang="ts">
	import { page } from "$app/state";
	import { m } from "$lib/paraglide/messages";
	import Switch from "$lib/components/Switch.svelte";
	import { useSettingsStore } from "$lib/stores/settings";

	const settings = useSettingsStore();
	const availableHere = $derived(
		(page.data as { codeRelayedCoordinationEnabled?: boolean }).codeRelayedCoordinationEnabled !==
			false
	);

	// Read from the shared store, so the change reaches every page at once and saves through the
	// one debounced path every other preference uses. Absent means on.
	function getEnabled() {
		return $settings.relayedCoordinationEnabled !== false;
	}
	function setEnabled(value: boolean) {
		settings.update((current) => ({ ...current, relayedCoordinationEnabled: value }));
	}
</script>

<section
	id="relayed-coordination"
	aria-labelledby="relay-title"
	class="flex flex-col gap-3"
	data-testid="relayed-coordination"
>
	<h2 id="relay-title" class="text-lg font-semibold">{m["workspace.agents.relay.title"]()}</h2>
	<div class="flex items-start gap-3">
		<Switch
			name="relayedCoordinationEnabled"
			bind:checked={getEnabled, setEnabled}
			disabled={!availableHere}
		/>
		<div class="text-sm">
			<p class="font-medium">{m["workspace.agents.relay.label"]()}</p>
			<p class="mt-1 text-gray-600 dark:text-gray-400">{m["workspace.agents.relay.detail"]()}</p>
			{#if !availableHere}
				<p class="mt-1 text-gray-600 dark:text-gray-400" data-testid="relay-off-here">
					{m["workspace.agents.relay.off_here"]()}
				</p>
			{/if}
		</div>
	</div>
</section>
