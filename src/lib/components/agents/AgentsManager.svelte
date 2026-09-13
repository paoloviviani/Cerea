<!--
	Agents, as an overlay in this app's own dialog language — and, since
	ADR 0067, **chat-side**: owned by the person who made them, stored beside
	their conversations, shared with nobody. The list is always exactly yours,
	which is why there is no share section and no "yours and shared with you":
	there is nothing to be shared with you.

	Two things that were true of the gateway's agents and stay true here,
	because they are about retrieval rather than about ownership:

	**An agent does not publish its knowledge bases.** Retrieval re-checks the
	user's own access to every attached base on every turn, with their token.

	**A wrapper, not a model** (clarified 2026-09-13). A conversation pointed
	at an agent keeps a plain model — the one the agent runs on — and holds the
	agent by id; each request passes through, adding the system prompt and the
	knowledge retrieval. Nothing is snapshotted: editing the agent changes what
	its existing conversations retrieve, which is what "passing through" means.
	Because conversations address it by id, the name is editable and renaming
	breaks nothing.
-->
<script lang="ts">
			import { onMount } from "svelte";
	import { base } from "$app/paths";
	import Modal from "$lib/components/Modal.svelte";
	import { GatewayError, gwGet, type VectorStore } from "$lib/gateway";
	import IconAddLarge from "~icons/carbon/add-large";
	import IconTrash from "~icons/carbon/trash-can";
	import IconArrowLeft from "~icons/carbon/arrow-left";
	import IconSettings from "~icons/carbon/settings";
	import LucideBot from "~icons/lucide/bot";
	import * as s from "$lib/components/overlay/styles";

	/** What this application stores and serves for one agent. */
	interface Agent {
		_id: string;
		name: string;
		description: string;
		model: string;
		system_prompt: string;
		knowledgeBaseIds: string[];
		retrievalLimit: number;
		retrievalMinScore: number;
	}

	interface ModelCard {
		id: string;
		display_name?: string | null;
		kind?: string;
	}

	interface Props {
		/** Open straight onto one agent, for `/agents/<id>`. */
		initialId?: string;
		onclose: () => void;
	}

	let { initialId, onclose }: Props = $props();

	type View = "list" | "form" | "detail";
	let view = $state<View>("list");

	let agents = $state<Agent[]>([]);
	let stores = $state<VectorStore[]>([]);
	let models = $state<ModelCard[]>([]);
	let loading = $state(true);
	let failure = $state<string | null>(null);
	let notice = $state<string | null>(null);
	let busy = $state(false);

	async function api<T>(path: string, init?: RequestInit): Promise<T> {
		const response = await fetch(`${base}/api/v2${path}`, {
			...init,
			headers: { "content-type": "application/json", ...init?.headers },
		});
		if (!response.ok) {
			const body = (await response.json().catch(() => null)) as { message?: string } | null;
			throw new Error(body?.message ?? `The request answered ${response.status}.`);
		}
		return (await response.json()) as T;
	}

	async function load() {
		failure = null;
		try {
			const [listed, bases, catalogue] = await Promise.all([
				api<{ data: Agent[] }>("/agents"),
				gwGet<{ data: VectorStore[] }>("vector_stores"),
				gwGet<{ data: ModelCard[] }>("models"),
			]);
			agents = listed.data;
			stores = bases.data;
			// The models an agent may run on: plain chat models.
			models = catalogue.data.filter((model) => (model.kind ?? "chat") === "chat");
		} catch (err) {
			failure = err instanceof GatewayError ? err.message : "Could not load the agents.";
		} finally {
			loading = false;
		}
	}

	// `onMount`, not the component body: these managers are also rendered as
	// pages (`/knowledge`, `/agents`, `/projects`), and a page body runs on the
	// server, where a relative fetch has no origin to resolve against.
	onMount(() =>
		load().then(() => {
			// The address somebody arrived on, resolved against the list that just
			// loaded — an id that is no longer readable leaves them on the list.
			const found = initialId && agents.find((agent) => agent._id === initialId);
			if (found) void openDetail(found);
		})
	);

	// ---- the form, for create and for edit ---------------------------------
	//
	// One form for both: the fields are identical, and a second nearly
	// identical one is how the two drift apart. `editing` is what switches it.

	let editing = $state<Agent | null>(null);
	let name = $state("");
	let model = $state("");
	let description = $state("");
	let systemPrompt = $state("");
	let attached = $state<string[]>([]);
	let retrievalLimit = $state("6");
	let current = $state<Agent | null>(null);

	async function startChat() {
		if (!current) return;
		busy = true;
		failure = null;
		try {
			const response = await fetch(`${base}/conversation`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ model: current.model, agentId: current._id }),
			});
			if (!response.ok) {
				throw new Error(
					((await response.json()) as { message?: string }).message ??
						"Could not start the chat.",
				);
			}
			const created = (await response.json()) as { conversationId: string };
			// A full page load, not a client-side navigation. This manager lives
			// two lives — an overlay over whatever page is open, and the /agents
			// page whose own close button navigates home — and a client-side
			// `goto` loses in both: under the overlay it is invisible, and after
			// the page's close-navigation it races it and loses. One full load
			// unmounts every case and lands on the chat.
			window.location.assign(`${base}/conversation/${created.conversationId}`);
		} catch (err) {
			failure = err instanceof Error ? err.message : "Could not start the chat.";
		} finally {
			busy = false;
		}
	}

	function toggle(id: string) {
		attached = attached.includes(id) ? attached.filter((entry) => entry !== id) : [...attached, id];
	}

	async function save(event: SubmitEvent) {
		event.preventDefault();
		if (!name.trim() || !model) return;
		busy = true;
		failure = null;
		try {
			const body = {
				description: description.trim(),
				system_prompt: systemPrompt,
				knowledgeBaseIds: attached,
				retrievalLimit: Number(retrievalLimit) || 6,
				model,
				// Conversations address the agent by id, so the name is a label
				// — editable like any other field.
				...(editing ? { name: name.trim() } : {}),
			};
			if (editing) {
				await api(`/agents/${editing._id}`, { method: "PATCH", body: JSON.stringify(body) });
				current = { ...editing, ...body };
				view = "detail";
			} else {
				await api("/agents", {
					method: "POST",
					body: JSON.stringify({ ...body, name: name.trim() }),
				});
				await load();
				const created = agents.find((agent) => agent.name === name.trim());
				if (created) {
					current = created;
					view = "detail";
				} else {
					backToList();
				}
			}
		} catch (err) {
			failure = err instanceof Error ? err.message : "Could not save it.";
		} finally {
			busy = false;
		}
	}

	function openForm(agent: Agent | null) {
		// Which form this is — create or edit — decides whether Save posts or
		// patches. Losing this line is how "Edit" became "create it again and
		// fail on the name".
		editing = agent;
		name = agent?.name ?? "";
		model = agent?.model ?? models[0]?.id ?? "";
		description = agent?.description ?? "";
		systemPrompt = agent?.system_prompt ?? "";
		attached = [...(agent?.knowledgeBaseIds ?? [])];
		retrievalLimit = String(agent?.retrievalLimit ?? 6);
		failure = null;
		notice = null;
		view = "form";
	}

	// ---- one agent ----------------------------------------------------------

	async function openDetail(agent: Agent) {
		current = agent;
		failure = null;
		notice = null;
		view = "detail";
	}

	function backToList() {
		view = "list";
		current = null;
		editing = null;
		failure = null;
		notice = null;
	}

	const attachedNames = $derived(
		(current?.knowledgeBaseIds ?? [])
			.map((id) => stores.find((store) => store.id === id)?.name)
			// A base attached but no longer readable by this person shows as such
			// rather than vanishing: an agent quietly retrieving from fewer bases
			// than its configuration lists is what nobody debugs.
			.map((base) => base ?? "one you can no longer read")
	);

	async function destroy() {
		if (!current) return;
		if (!confirm(`Delete the agent “${current.name}”?`)) return;
		busy = true;
		try {
			await api(`/agents/${current._id}`, { method: "DELETE" });
			await load();
			backToList();
		} catch (err) {
			failure = err instanceof Error ? err.message : "Could not delete it.";
			busy = false;
		}
	}
</script>

<Modal
	width={view === "list" ? s.OVERLAY_WIDE : s.OVERLAY_NARROW}
	{onclose}
	closeButton
	labelledBy="agents-modal-title"
>
	<div class={s.PANEL}>
		<div class={s.HEADER}>
			<h2 id="agents-modal-title" class={s.TITLE}>
				{#if view === "list"}
					Agents
				{:else if view === "form"}
					{editing ? `Edit ${editing.name}` : "New agent"}
				{:else}
					{current?.name ?? "Agent"}
				{/if}
			</h2>
			<p class={s.SUBTITLE}>
				{#if view === "list"}
					A model with standing instructions and knowledge attached. Yours alone; pick one in the
					model list to use it.
				{:else if view === "form"}
					Everything that makes it an agent is on this one screen.
				{:else if current}
					Start a chat with it below — it runs on {current.model} and adds your instructions
					and knowledge to every turn.
				{/if}
			</p>
		</div>

		{#if failure}
			<p class="{s.ERROR} mb-4">{failure}</p>
		{/if}

		{#if view === "list"}
			<div class="{s.STRIP} {agents.length > 0 ? s.STRIP_ACTIVE : s.STRIP_IDLE}">
				<div class="flex items-center gap-3">
					<div class={s.STRIP_TILE} class:grayscale={agents.length === 0}>
						<LucideBot class="size-5 text-blue-600 dark:text-blue-500" />
					</div>
					<div>
						<p class={s.STRIP_HEADLINE}>
							{agents.length}
							{agents.length === 1 ? "agent" : "agents"}
						</p>
						<p class={s.STRIP_DETAIL}>yours</p>
					</div>
				</div>
				<div class="flex gap-2">
					<button onclick={() => openForm(null)} disabled={models.length === 0} class={s.PRIMARY}>
						<IconAddLarge class="size-4" />
						New agent
					</button>
				</div>
			</div>

			<div class={s.STACK}>
				{#if loading}
					<p class={s.SUBTITLE}>Loading…</p>
				{:else if agents.length === 0}
					<div class={s.EMPTY}>
						<LucideBot class={s.EMPTY_ICON} />
						<p class={s.EMPTY_TITLE}>No agents yet</p>
						<p class={s.EMPTY_DETAIL}>
							Give a model standing instructions and some documents, and address it by name
						</p>
						<button onclick={() => openForm(null)} disabled={models.length === 0} class={s.PRIMARY}>
							<IconAddLarge class="size-4" />
							Create Your First Agent
						</button>
					</div>
				{:else}
					<div>
						<h3 class={s.SECTION_TITLE}>Yours ({agents.length})</h3>
						<div class={s.GRID}>
							{#each agents as agent (agent._id)}
								<button
									type="button"
									onclick={() => openDetail(agent)}
									class="{s.card(true)} text-left"
								>
									<div class={s.CARD_BODY}>
										<div class="mb-3 min-w-0">
											<div class="mb-0.5 flex items-center gap-2">
												<LucideBot class="size-4 flex-shrink-0 text-gray-400" />
												<h3 class={s.CARD_TITLE}>{agent.name}</h3>
											</div>
											<p class={s.CARD_SUBTITLE}>{agent.description || agent.model}</p>
										</div>
										<div class="flex flex-wrap items-center gap-2">
											<span class="{s.PILL} {s.PILL_TONES.neutral}">{agent.model}</span>
											{#if agent.knowledgeBaseIds.length > 0}
												<span class="text-xs text-gray-600 dark:text-gray-400">
													{agent.knowledgeBaseIds.length} base{agent.knowledgeBaseIds.length ===
													1
														? ""
														: "s"}
												</span>
											{/if}
										</div>
									</div>
								</button>
							{/each}
						</div>
					</div>
				{/if}

				{#if models.length === 0 && !loading}
					<p class={s.NOTICE}>
						No models are available to you, so there is nothing to build an agent on.
					</p>
				{/if}

				<div class={s.TIPS}>
					<h4 class={s.TIPS_TITLE}>💡 Quick Tips</h4>
					<ul class={s.TIPS_LIST}>
						<li>
							• Start a chat from the agent's page; the conversation runs on the agent's model with
							the wrapper on top.
						</li>
						<li>
							• Its instructions go <em>before</em> yours — it supplies defaults, not overrides.
						</li>
						<li>
							• Retrieval uses <strong>your</strong> access: it sees only the bases you could read
							yourself.
						</li>
						<li>• Editing the agent changes the conversations it wraps; the model stays theirs to
							switch.</li>
					</ul>
				</div>
			</div>
		{:else if view === "form"}
			<form class="flex flex-col gap-4" onsubmit={save}>
				<div class="flex flex-wrap gap-3">
					<div class="min-w-48 flex-1">
						<label for="agent-name" class={s.LABEL}>Name</label>
						<input
							id="agent-name"
							class={s.INPUT}
							placeholder="handbook"
							pattern="[A-Za-z0-9][A-Za-z0-9._\-]*"
							maxlength="128"
							bind:value={name}
							required
							disabled={busy}
						/>
					</div>
					<div class="min-w-48 flex-1">
						<label for="agent-model" class={s.LABEL}>Runs on</label>
						<select
							id="agent-model"
							class={s.INPUT}
							bind:value={model}
							disabled={busy || models.length === 0}
						>
							{#each models as entry (entry.id)}
								<option value={entry.id}>{entry.display_name || entry.id}</option>
							{/each}
						</select>
						<p class={s.HINT}>Only models you can already use.</p>
					</div>
				</div>

				<div>
					<label for="agent-description" class={s.LABEL}>
						What it is for <span class="font-normal text-gray-500">(optional)</span>
					</label>
					<input
						id="agent-description"
						class={s.INPUT}
						maxlength="500"
						bind:value={description}
						disabled={busy}
					/>
				</div>

				<div>
					<label for="agent-prompt" class={s.LABEL}>Instructions</label>
					<textarea
						id="agent-prompt"
						class="{s.INPUT} min-h-28"
						placeholder="You answer only from the passages provided, and you name the source."
						bind:value={systemPrompt}
						disabled={busy}
					></textarea>
					<p class={s.HINT}>
						Sent ahead of every conversation. Somebody's own system message is kept and comes after
						this.
					</p>
				</div>

				<div>
					<span class={s.LABEL}>
						Knowledge bases <span class="font-normal text-gray-500">(optional)</span>
					</span>
					{#if stores.length === 0}
						<p class={s.HINT}>You have none yet. Create one under Knowledge.</p>
					{:else}
						<div class="max-h-40 space-y-1 overflow-y-auto">
							{#each stores as store (store.id)}
								<label class="flex items-start gap-2 text-sm">
									<input
										type="checkbox"
										checked={attached.includes(store.id)}
										onchange={() => toggle(store.id)}
										disabled={busy}
										class="mt-0.5 accent-blue-600"
									/>
									<span>
										{store.name}
										<span class="text-xs text-gray-500">
											· {store.file_counts.completed} indexed{#if !store.owned}, shared with you{/if}
										</span>
									</span>
								</label>
							{/each}
						</div>
					{/if}
					<p class={s.HINT}>
						Retrieval uses your own access: whoever runs the agent sees passages only from bases
						they could already read.
					</p>
				</div>

				<div>
					<label for="agent-limit" class={s.LABEL}>Passages per answer</label>
					<input
						id="agent-limit"
						type="number"
						min="1"
						max="50"
						class="{s.INPUT} w-32"
						bind:value={retrievalLimit}
						disabled={busy}
					/>
				</div>

				<div class="flex justify-end gap-2">
					<button
						type="button"
						onclick={() => (editing ? openDetail(editing) : backToList())}
						disabled={busy}
						class={s.SECONDARY}
					>
						Cancel
					</button>
					<button type="submit" disabled={busy || !name.trim() || !model} class={s.PRIMARY}>
						{busy ? "Saving…" : editing ? "Save" : "Create"}
					</button>
				</div>
			</form>
		{:else if current}
			<div class={s.STACK}>
				<div class="{s.STRIP} {s.STRIP_ACTIVE}">
					<div class="flex items-center gap-3">
						<div class={s.STRIP_TILE}>
							<LucideBot class="size-5 text-blue-600 dark:text-blue-500" />
						</div>
						<div>
							<p class={s.STRIP_HEADLINE}>Runs on {current.model}</p>
							<p class={s.STRIP_DETAIL}>
								{attachedNames.length} knowledge base{attachedNames.length === 1 ? "" : "s"} · up to {current.retrievalLimit}
								passage{current.retrievalLimit === 1 ? "" : "s"}
								per answer
							</p>
						</div>
					</div>
					<div class="flex gap-2">
						<button onclick={backToList} class={s.SECONDARY}>
							<IconArrowLeft class="size-4" />
							All agents
						</button>
						<button onclick={() => openForm(current)} class={s.SECONDARY}>
							<IconSettings class="size-4" />
							Edit
						</button>
						<button onclick={startChat} disabled={busy} class={s.PRIMARY}>
							<LucideBot class="size-4" />
							Start a chat
						</button>
					</div>
				</div>

				<div>
					<h3 class={s.SECTION_TITLE}>Instructions</h3>
					{#if current.system_prompt.trim()}
						<p class="text-sm whitespace-pre-wrap text-gray-700 dark:text-gray-300">
							{current.system_prompt}
						</p>
					{:else}
						<p class={s.SUBTITLE}>None — it behaves as the plain model until you give it some.</p>
					{/if}
				</div>

				<div>
					<h3 class={s.SECTION_TITLE}>Knowledge</h3>
					{#if attachedNames.length === 0}
						<p class={s.SUBTITLE}>None attached, so it retrieves nothing.</p>
					{:else}
						<p class="text-sm text-gray-700 dark:text-gray-300">{attachedNames.join(", ")}</p>
					{/if}
				</div>

				<div class="mt-3 flex justify-end">
					<button onclick={destroy} disabled={busy} class={s.CARD_DESTRUCTIVE}>
						<IconTrash class="size-3" />
						Delete this agent
					</button>
				</div>
			</div>
		{/if}
	</div>
</Modal>
