<!--
	Agents: a model with instructions, and knowledge bases attached (ADR 0062).

	The thing worth knowing about this list: an agent created here shows up in
	the **model picker**, as `agent:<name>`. That is not a convenience of this
	page — it is how agents work. They are addressed as models, so every part of
	this app that already picks a model can use one without knowing agents
	exist.

	Creating and configuring are one dialog. They were two steps, and for an
	agent that was worse than for a knowledge base: an agent with no
	instructions and no knowledge bases is not half-built, it is the underlying
	model with a new name, and everything that made it an agent was on the
	second screen.
-->
<script lang="ts">
	import { onMount } from "svelte";
	import { base } from "$app/paths";
	import CarbonAdd from "~icons/carbon/add";
	import AgentModal from "$lib/components/AgentModal.svelte";
	import { GatewayError, gwGet, type Agent, type VectorStore } from "$lib/gateway";

	interface ModelCard {
		id: string;
		display_name?: string | null;
		kind?: string;
	}

	let agents = $state<Agent[]>([]);
	let models = $state<ModelCard[]>([]);
	let stores = $state<VectorStore[]>([]);
	let loading = $state(true);
	let failure = $state<string | null>(null);
	let showCreate = $state(false);

	async function load() {
		failure = null;
		try {
			const [listed, catalogue, bases] = await Promise.all([
				gwGet<{ data: Agent[] }>("agents"),
				gwGet<{ data: ModelCard[] }>("models"),
				// Fetched here rather than in the dialog so opening it is instant
				// and needs no spinner of its own.
				gwGet<{ data: VectorStore[] }>("vector_stores"),
			]);
			agents = listed.data;
			// Chat models only, and agents filtered out: an agent on an agent is
			// not a thing, and the list already excludes models this person
			// cannot use.
			models = catalogue.data.filter(
				(entry) => !entry.id.startsWith("agent:") && (entry.kind ?? "chat") === "chat"
			);
			stores = bases.data;
		} catch (err) {
			failure = err instanceof GatewayError ? err.message : "Could not reach the gateway.";
		} finally {
			loading = false;
		}
	}

	onMount(load);

	function saved(agent: Agent) {
		agents = [...agents.filter((entry) => entry.id !== agent.id), agent].sort((a, b) =>
			a.name.localeCompare(b.name)
		);
	}
</script>

<svelte:head><title>Agents</title></svelte:head>

<div class="mx-auto flex w-full max-w-3xl flex-col gap-6 overflow-y-auto p-6">
	<header class="flex flex-wrap items-start justify-between gap-3">
		<div class="flex flex-col gap-1">
			<h1 class="text-xl font-semibold">Agents</h1>
			<p class="text-sm text-gray-500 dark:text-gray-400">
				A model with standing instructions and knowledge bases attached. One you create appears in
				the model picker as <code class="text-xs">agent:name</code>.
			</p>
		</div>
		<button
			type="button"
			onclick={() => (showCreate = true)}
			disabled={models.length === 0}
			class="flex items-center gap-1.5 rounded-full bg-black px-4 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-white dark:text-black"
		>
			<CarbonAdd /> New
		</button>
	</header>

	{#if failure}
		<p
			class="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-200"
		>
			{failure}
		</p>
	{/if}

	{#if !loading && models.length === 0}
		<p
			class="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100"
		>
			You have no chat models available, so there is nothing to build an agent on. Ask an
			administrator for access to one.
		</p>
	{/if}

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

{#if showCreate}
	<AgentModal {models} {stores} onsaved={saved} onclose={() => (showCreate = false)} />
{/if}
