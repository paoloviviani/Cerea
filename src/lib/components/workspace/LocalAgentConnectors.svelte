<!--
	Workspace -> Agents: which of the user's Cerea connectors their OWN agents may use (goose
	Desktop, the goose CLI, an editor extension), through galopin's local MCP endpoint, set up
	with `galopin goose setup` (ADR 0110). Default none. Calls made this way are not governed by a
	session's Plan / Ask / Allow: the agent's own approval applies; each call is audited.
-->
<script lang="ts">
	import { onMount } from "svelte";
	import { base } from "$app/paths";
	import { m } from "$lib/paraglide/messages";

	interface Option {
		key: string;
		name: string;
		summary: string;
		unavailable?: "switched off" | "needs sign-in";
	}

	let loading = $state(true);
	let loadFailure = $state<string | null>(null);
	let options = $state<Option[]>([]);
	let selected = $state<string[]>([]);
	let busyKey = $state<string | null>(null);
	let failure = $state<string | null>(null);

	async function read(response: Response): Promise<Record<string, unknown>> {
		if (!response.ok) {
			const parsed = (await response.json().catch(() => null)) as { message?: string } | null;
			throw new Error(
				parsed?.message ?? m["workspace.agents.error_status"]({ status: response.status })
			);
		}
		return (await response.json()) as Record<string, unknown>;
	}

	async function load() {
		try {
			const data = await read(await fetch(`${base}/api/v2/code/local-agents`));
			options = Array.isArray(data.options) ? (data.options as Option[]) : [];
			selected = Array.isArray(data.selected) ? (data.selected as string[]) : [];
		} catch (err) {
			loadFailure = err instanceof Error ? err.message : m["workspace.agents.read_failed"]();
		} finally {
			loading = false;
		}
	}
	onMount(load);

	async function toggle(option: Option, on: boolean) {
		busyKey = option.key;
		failure = null;
		const keys = on ? [...selected, option.key] : selected.filter((k) => k !== option.key);
		try {
			const data = await read(
				await fetch(`${base}/api/v2/code/local-agents`, {
					method: "PUT",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ keys }),
				})
			);
			selected = data.selected as string[];
		} catch (err) {
			failure = err instanceof Error ? err.message : m["workspace.agents.save_failed"]();
		} finally {
			busyKey = null;
		}
	}
</script>

<section
	id="local-agents"
	aria-labelledby="local-agents-title"
	class="flex flex-col gap-3"
	data-testid="local-agent-connectors"
>
	<div>
		<h2 id="local-agents-title" class="text-lg font-semibold">
			{m["workspace.agents.local.title"]()}
		</h2>
		<p class="mt-1 text-sm text-gray-600 dark:text-gray-400">
			{m["workspace.agents.local.intro"]()}
		</p>
	</div>
	{#if loading}
		<p class="text-sm text-gray-600 dark:text-gray-400">{m["workspace.agents.loading"]()}</p>
	{:else if loadFailure}
		<p class="text-sm text-red-600" role="alert">{loadFailure}</p>
	{:else if options.length === 0}
		<p class="text-sm text-gray-600 dark:text-gray-400" data-testid="local-agents-none">
			{m["workspace.agents.local.none"]()}
		</p>
	{:else}
		<ul class="flex flex-col gap-1.5">
			{#each options as option (option.key)}
				<li>
					<label class="flex items-start gap-2 text-sm">
						<input
							type="checkbox"
							class="mt-0.5"
							checked={selected.includes(option.key)}
							disabled={busyKey !== null ||
								(option.unavailable !== undefined && !selected.includes(option.key))}
							onchange={(e) => toggle(option, e.currentTarget.checked)}
							data-testid="local-agent-{option.key}"
						/>
						<span>
							<span class="font-medium">{option.name}</span>
							{#if option.unavailable}
								<span class="text-gray-500">
									· {option.unavailable === "needs sign-in"
										? m["workspace.agents.local.needs_sign_in"]()
										: m["workspace.agents.local.switched_off"]()}</span
								>
							{/if}
							{#if option.summary}
								<span class="block text-gray-600 dark:text-gray-400">{option.summary}</span>
							{/if}
						</span>
					</label>
				</li>
			{/each}
		</ul>
	{/if}
	{#if failure}<p class="text-sm text-red-600" role="alert">{failure}</p>{/if}
</section>
