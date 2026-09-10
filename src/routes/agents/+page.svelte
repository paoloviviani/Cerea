<!--
	Agents: a model with instructions, and knowledge bases attached (ADR 0062).

	The thing worth knowing about this list: an agent created here shows up in
	the **model picker**, as `agent:<name>`. That is not a convenience of this
	page — it is how agents work. They are addressed as models, so every part of
	this app that already picks a model can use one without knowing agents
	exist.
-->
<script lang="ts">
	import { onMount } from "svelte";
	import { base } from "$app/paths";
	import { GatewayError, gwGet, gwPost, type Agent } from "$lib/gateway";

	interface ModelCard {
		id: string;
		display_name?: string | null;
		kind?: string;
	}

	let agents = $state<Agent[]>([]);
	let models = $state<ModelCard[]>([]);
	let loading = $state(true);
	let failure = $state<string | null>(null);
	let creating = $state(false);
	let name = $state("");
	let model = $state("");
	let description = $state("");

	async function load() {
		failure = null;
		try {
			const [listed, catalogue] = await Promise.all([
				gwGet<{ data: Agent[] }>("agents"),
				gwGet<{ data: ModelCard[] }>("models"),
			]);
			agents = listed.data;
			// Chat models only, and agents filtered out: an agent on an agent is
			// not a thing, and the list already excludes models this person
			// cannot use.
			models = catalogue.data.filter(
				(entry) => !entry.id.startsWith("agent:") && (entry.kind ?? "chat") === "chat"
			);
			if (!model && models.length > 0) model = models[0].id;
		} catch (err) {
			failure = err instanceof GatewayError ? err.message : "Could not reach the gateway.";
		} finally {
			loading = false;
		}
	}

	onMount(load);

	async function create(event: SubmitEvent) {
		event.preventDefault();
		if (!name.trim() || !model) return;
		creating = true;
		failure = null;
		try {
			const made = await gwPost<Agent>("agents", {
				name: name.trim(),
				model,
				description: description.trim(),
			});
			agents = [...agents, made].sort((a, b) => a.name.localeCompare(b.name));
			name = "";
			description = "";
		} catch (err) {
			failure = err instanceof GatewayError ? err.message : "Could not create it.";
		} finally {
			creating = false;
		}
	}
</script>

<svelte:head><title>Agents</title></svelte:head>

<div class="mx-auto flex w-full max-w-3xl flex-col gap-6 overflow-y-auto p-6">
	<header class="flex flex-col gap-1">
		<h1 class="text-xl font-semibold">Agents</h1>
		<p class="text-sm text-gray-500 dark:text-gray-400">
			A model with standing instructions, tools and knowledge bases attached. An agent you
			create appears in the model picker as <code class="text-xs">agent:name</code>.
		</p>
	</header>

	{#if failure}
		<p
			class="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-200"
		>
			{failure}
		</p>
	{/if}

	<form
		class="flex flex-col gap-3 rounded-lg border border-gray-200 p-4 dark:border-gray-700"
		onsubmit={create}
	>
		<h2 class="text-sm font-medium">New agent</h2>
		<input
			class="rounded-lg border border-gray-300 bg-white p-2 text-sm dark:border-gray-600 dark:bg-gray-900"
			placeholder="Name — letters, digits, dots, dashes"
			pattern="[A-Za-z0-9][A-Za-z0-9._\-]*"
			maxlength="128"
			bind:value={name}
			required
		/>
		<label class="flex flex-col gap-1">
			<span class="text-xs text-gray-500 dark:text-gray-400">
				Runs on — only models you can already use are listed
			</span>
			<select
				class="rounded-lg border border-gray-300 bg-white p-2 text-sm dark:border-gray-600 dark:bg-gray-900"
				bind:value={model}
				disabled={models.length === 0}
			>
				{#each models as entry (entry.id)}
					<option value={entry.id}>{entry.display_name || entry.id}</option>
				{/each}
			</select>
		</label>
		<input
			class="rounded-lg border border-gray-300 bg-white p-2 text-sm dark:border-gray-600 dark:bg-gray-900"
			placeholder="What it is for (optional)"
			maxlength="500"
			bind:value={description}
		/>
		<div class="flex justify-end">
			<button
				type="submit"
				disabled={creating || !name.trim() || !model}
				class="rounded-full bg-black px-4 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-white dark:text-black"
			>
				{creating ? "Creating…" : "Create"}
			</button>
		</div>
	</form>

	{#if loading}
		<p class="text-sm text-gray-500">Loading…</p>
	{:else if agents.length === 0}
		<p class="text-sm text-gray-500">No agents yet.</p>
	{:else}
		<ul class="flex flex-col gap-2">
			{#each agents as agent (agent.id)}
				<li>
					<a
						href="{base}/agents/{agent.id}"
						class="flex flex-col gap-1 rounded-lg border border-gray-200 p-4 no-underline hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-900"
					>
						<div class="flex flex-wrap items-center gap-2">
							<span class="font-medium">{agent.name}</span>
							<code class="text-xs text-gray-500">{agent.model_name}</code>
							{#if !agent.owned}
								<span
									class="rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-700 dark:bg-gray-800 dark:text-gray-300"
									>shared · {agent.role}</span
								>
							{/if}
						</div>
						{#if agent.description}
							<div class="text-sm text-gray-500 dark:text-gray-400">{agent.description}</div>
						{/if}
						<div class="text-xs text-gray-500 dark:text-gray-400">
							{agent.model}
							{#if agent.knowledge_base_ids.length > 0}
								· {agent.knowledge_base_ids.length} knowledge base{agent.knowledge_base_ids
									.length === 1
									? ""
									: "s"}
							{/if}
						</div>
					</a>
				</li>
			{/each}
		</ul>
	{/if}
</div>
