<!--
	A list of switches, one per connector a coding session could use (ADR 0108, item 3): the
	connector's name, what it is, and where it runs. Presentational: the parent owns the list and
	what is on, and is told the whole new set on every change. A connector that cannot be used
	now (switched off in Workspace, or needing a sign-in) is shown off and disabled, with why.
-->
<script lang="ts">
	import { m } from "$lib/paraglide/messages";
	import type { AgentConnectorOption } from "$lib/codeApi";

	interface Props {
		options: AgentConnectorOption[];
		selected: string[];
		disabled?: boolean;
		onchange: (keys: string[]) => void;
	}

	let { options, selected, disabled = false, onchange }: Props = $props();

	/**
	 * The parent owns what is on. The box is put back as it was and the parent's answer sets it,
	 * so a save that fails leaves the box showing what is really saved.
	 */
	function toggle(box: HTMLInputElement, key: string) {
		const on = box.checked;
		box.checked = !on;
		const rest = selected.filter((k) => k !== key);
		onchange(on ? [...rest, key] : rest);
	}

	function why(option: AgentConnectorOption): string {
		if (option.unavailable === "needs sign-in") return m["code.connectors.needs_signin"]();
		if (option.unavailable === "switched off") return m["code.connectors.switched_off"]();
		if (option.kind === "local") return m["code.connectors.on_machine"]();
		return "";
	}
</script>

{#if options.length === 0}
	<p class="text-ink-muted" data-testid="connectors-none">{m["code.connectors.none"]()}</p>
{:else}
	<ul class="space-y-2" data-testid="connector-switches">
		{#each options as option (option.key)}
			<li>
				<label class="flex items-start gap-2 text-sm text-ink">
					<input
						type="checkbox"
						class="mt-1"
						checked={selected.includes(option.key) && !option.unavailable}
						disabled={disabled || Boolean(option.unavailable)}
						onchange={(e) => toggle(e.currentTarget, option.key)}
						data-testid="connector-switch-{option.name}"
					/>
					<span class="min-w-0">
						<span class="font-medium">{option.name}</span>
						{#if why(option)}
							<span class="text-ink-faint">· {why(option)}</span>
						{/if}
						{#if option.summary}
							<span class="block text-ink-muted">{option.summary}</span>
						{/if}
					</span>
				</label>
			</li>
		{/each}
	</ul>
{/if}
