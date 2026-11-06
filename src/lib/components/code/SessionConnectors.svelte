<!--
	The "Connectors" part of a session's Permissions sheet (ADR 0108, item 3): which of the user's
	connectors this coding session may use. Default none. Read from and saved to Cerea, which
	holds the choice; each change saves at once and the list is re-read from the answer.
-->
<script lang="ts">
	import { m } from "$lib/paraglide/messages";
	import { untrack } from "svelte";
	import {
		getSessionConnectors,
		setSessionConnectors,
		type AgentConnectorOption,
	} from "$lib/codeApi";
	import { error as errorToast } from "$lib/stores/errors";
	import ConnectorSwitches from "./ConnectorSwitches.svelte";

	interface Props {
		deviceId: string;
		sessionId: string;
	}

	let { deviceId, sessionId }: Props = $props();

	let options = $state<AgentConnectorOption[]>([]);
	let selected = $state<string[]>([]);
	let loaded = $state(false);
	let failed = $state(false);
	let saving = $state(false);

	$effect(() => {
		const device = deviceId;
		const session = sessionId;
		untrack(() => {
			getSessionConnectors(device, session)
				.then((r) => {
					options = r.options;
					selected = r.selected;
					failed = false;
				})
				.catch(() => (failed = true))
				.finally(() => (loaded = true));
		});
	});

	async function save(keys: string[]) {
		if (saving) return;
		saving = true;
		try {
			selected = (await setSessionConnectors(deviceId, sessionId, keys)).selected;
		} catch (err) {
			errorToast.set(err instanceof Error ? err.message : m["code.connectors.could_not_save"]());
		} finally {
			saving = false;
		}
	}
</script>

<div data-testid="session-connectors">
	<p class="mb-1 font-medium text-ink">{m["code.connectors.title"]()}</p>
	{#if !loaded}
		<p class="text-ink-muted">{m["code.permissions.reading"]()}</p>
	{:else if failed}
		<p class="text-ink-muted" data-testid="connectors-unavailable">
			{m["code.connectors.could_not_load"]()}
		</p>
	{:else}
		<ConnectorSwitches
			{options}
			{selected}
			disabled={saving}
			onchange={(keys) => void save(keys)}
		/>
		<p class="mt-1 text-ink-faint">{m["code.connectors.hint"]()}</p>
	{/if}
</div>
