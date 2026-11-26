<!--
	Workspace -> Agents: the ONE list of connectors the user's agents may use: their Cerea
	connectors and each paired computer's own servers. Coding sessions started from Cerea inherit
	it (and may turn items off for themselves; calls still follow Plan / Ask / Allow / Auto). One
	switch lets apps on the user's computers (goose Desktop, Claude Code in a terminal, any MCP
	client, through galopin's local endpoint, set up with `galopin goose setup`, ADR 0110) use the
	Cerea connectors too, under their own approval; it is on by default. Default list: none.
-->
<script lang="ts">
	import { delayedLoading } from "$lib/utils/delayedLoading.svelte";
	import SkeletonBusy from "$lib/components/skeleton/SkeletonBusy.svelte";
	import SkeletonFormRow from "$lib/components/skeleton/SkeletonFormRow.svelte";
	import { onMount } from "svelte";
	import { base } from "$app/paths";
	import { m } from "$lib/paraglide/messages";

	interface Option {
		key: string;
		name: string;
		summary: string;
		detail?: string;
		unavailable?: "switched off" | "needs sign-in" | "same name";
	}

	let loading = $state(true);
	const sk = delayedLoading(() => loading);
	let loadFailure = $state<string | null>(null);
	interface Computer {
		deviceId: string;
		name: string;
		options: Option[];
	}

	let options = $state<Option[]>([]);
	let computers = $state<Computer[]>([]);
	let appsToo = $state(true);
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
			computers = Array.isArray(data.computers) ? (data.computers as Computer[]) : [];
			selected = Array.isArray(data.selected) ? (data.selected as string[]) : [];
			appsToo = data.appsToo !== false;
		} catch (err) {
			loadFailure = err instanceof Error ? err.message : m["workspace.agents.read_failed"]();
		} finally {
			loading = false;
		}
	}
	onMount(load);

	async function save(body: { keys?: string[]; appsToo?: boolean }, busy: string) {
		busyKey = busy;
		failure = null;
		try {
			const data = await read(
				await fetch(`${base}/api/v2/code/local-agents`, {
					method: "PUT",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(body),
				})
			);
			selected = data.selected as string[];
			appsToo = data.appsToo !== false;
		} catch (err) {
			failure = err instanceof Error ? err.message : m["workspace.agents.save_failed"]();
		} finally {
			busyKey = null;
		}
	}

	function toggle(option: Option, on: boolean) {
		const keys = on ? [...selected, option.key] : selected.filter((k) => k !== option.key);
		return save({ keys }, option.key);
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
	{#if sk.visible}
		<SkeletonBusy label={m["workspace.agents.loading"]()}>
			<SkeletonFormRow count={3} />
		</SkeletonBusy>
	{:else if loading}
		<!-- inside the delay: nothing yet -->
	{:else if loadFailure}
		<p class="text-sm text-red-600" role="alert">{loadFailure}</p>
	{:else if options.length === 0 && computers.every((c) => c.options.length === 0)}
		<p class="text-sm text-gray-600 dark:text-gray-400" data-testid="local-agents-none">
			{m["workspace.agents.local.none"]()}
		</p>
	{:else}
		{#snippet rows(list: Option[])}
			<ul class="flex flex-col gap-1.5">
				{#each list as option (option.key)}
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
								{#if option.detail}
									<span class="text-gray-500">({option.detail})</span>
								{/if}
								{#if option.unavailable}
									<span class="text-gray-500">
										· {option.unavailable === "needs sign-in"
											? m["workspace.agents.local.needs_sign_in"]()
											: option.unavailable === "same name"
												? m["workspace.agents.local.same_name"]()
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
		{/snippet}
		{@render rows(options)}
		{#each computers.filter((c) => c.options.length > 0) as computer (computer.deviceId)}
			<div data-testid="local-agents-computer-{computer.deviceId}">
				<h3 class="mb-1.5 text-sm font-medium">
					{m["workspace.agents.local.computer"]({ name: computer.name })}
				</h3>
				{@render rows(computer.options)}
			</div>
		{/each}
		<label class="flex items-start gap-2 border-t pt-3 text-sm dark:border-gray-700">
			<input
				type="checkbox"
				class="mt-0.5"
				checked={appsToo}
				disabled={busyKey !== null}
				onchange={(e) => save({ appsToo: e.currentTarget.checked }, "apps-too")}
				data-testid="local-agents-apps-too"
			/>
			<span>
				<span class="font-medium">{m["workspace.agents.local.apps_too"]()}</span>
				<span class="block text-gray-600 dark:text-gray-400">
					{m["workspace.agents.local.apps_too_hint"]()}
				</span>
			</span>
		</label>
	{/if}
	{#if failure}<p class="text-sm text-red-600" role="alert">{failure}</p>{/if}
</section>
