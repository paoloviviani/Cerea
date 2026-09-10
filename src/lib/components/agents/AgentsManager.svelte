<!--
	Agents, as an overlay in this app's own dialog language.

	Three views in one dialog: the list, the form that creates or edits one, and
	one agent's summary with its sharing. The MCP dialog's shape, for the same
	reason — this is one task, and it should not cost somebody their place in
	the conversation that prompted it.

	Two things about sharing an agent that this has to say out loud, because
	both are deliberate and both surprise people (ADR 0062).

	**Sharing an agent does not share its knowledge bases.** Retrieval re-checks
	the recipient's own access to every attached base on every request, so a
	colleague sees passages only from bases they could already read. That is
	what stops an agent being a way to publish a document without sharing it.

	**An agent may be shared even when its model is not.** The share is allowed;
	the agent simply does not appear in that person's model list, and calling it
	by name answers with the reason. Refusing the share instead would make an
	owner debug somebody else's permissions before they could offer anything.
-->
<script lang="ts">
	import { onMount } from "svelte";
	import Modal from "$lib/components/Modal.svelte";
	import {
		GatewayError,
		gwDelete,
		gwGet,
		gwPost,
		type Agent,
		type BillableGroup,
		type VectorStore,
	} from "$lib/gateway";
	import IconAddLarge from "~icons/carbon/add-large";
	import IconRefresh from "~icons/carbon/renew";
	import IconTrash from "~icons/carbon/trash-can";
	import IconArrowLeft from "~icons/carbon/arrow-left";
	import IconShare from "~icons/carbon/share";
	import IconSettings from "~icons/carbon/settings";
	import LucideBot from "~icons/lucide/bot";
	import * as s from "$lib/components/overlay/styles";

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
	let groups = $state<BillableGroup[]>([]);
	let loading = $state(true);
	let refreshing = $state(false);
	let failure = $state<string | null>(null);
	let notice = $state<string | null>(null);
	let busy = $state(false);

	async function load() {
		failure = null;
		try {
			const [listed, bases, catalogue] = await Promise.all([
				gwGet<{ data: Agent[] }>("agents"),
				gwGet<{ data: VectorStore[] }>("vector_stores"),
				gwGet<{ data: ModelCard[] }>("models"),
			]);
			agents = listed.data;
			stores = bases.data;
			// The models an agent may run on: chat models, and not other agents.
			models = catalogue.data.filter(
				(model) => !model.id.startsWith("agent:") && (model.kind ?? "chat") === "chat"
			);
		} catch (err) {
			failure = err instanceof GatewayError ? err.message : "Could not reach the gateway.";
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
			const found = initialId && agents.find((agent) => agent.id === initialId);
			if (found) void openDetail(found);
		})
	);

	async function refresh() {
		if (refreshing) return;
		refreshing = true;
		try {
			await load();
		} finally {
			refreshing = false;
		}
	}

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
	let temperature = $state("");

	function openForm(agent: Agent | null) {
		editing = agent;
		name = agent?.name ?? "";
		model = agent?.model ?? models[0]?.id ?? "";
		description = agent?.description ?? "";
		systemPrompt = agent?.system_prompt ?? "";
		attached = [...(agent?.knowledge_base_ids ?? [])];
		retrievalLimit = String(agent?.retrieval_limit ?? 6);
		temperature =
			typeof agent?.generation?.temperature === "number"
				? String(agent.generation.temperature)
				: "";
		failure = null;
		notice = null;
		view = "form";
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
			const body: Record<string, unknown> = {
				description: description.trim(),
				system_prompt: systemPrompt,
				knowledge_base_ids: attached,
				retrieval_limit: Number(retrievalLimit) || 6,
				model,
				// Blank means "say nothing", not zero: an agent supplies defaults
				// only where the request is silent, and writing 0 would pin every
				// conversation to it.
				generation: temperature.trim() === "" ? {} : { temperature: Number(temperature) },
			};
			const saved = editing
				? // The name is not editable: it *is* the address (`agent:<name>`),
					// so renaming would break every conversation that named it.
					await gwPost<Agent>(`agents/${editing.id}`, body)
				: await gwPost<Agent>("agents", { ...body, name: name.trim() });
			await load();
			current = saved;
			view = "detail";
		} catch (err) {
			failure = err instanceof GatewayError ? err.message : "Could not save it.";
		} finally {
			busy = false;
		}
	}

	// ---- one agent ----------------------------------------------------------

	let current = $state<Agent | null>(null);
	let shareWith = $state("");
	let shareKind = $state<"user" | "group">("user");

	async function openDetail(agent: Agent) {
		current = agent;
		failure = null;
		notice = null;
		view = "detail";
		if (groups.length === 0) {
			try {
				groups = (await gwGet<{ data: BillableGroup[] }>("billing/groups")).data;
			} catch {
				/* a convenience: the group field falls back to free text */
			}
		}
	}

	function backToList() {
		view = "list";
		current = null;
		editing = null;
		failure = null;
		notice = null;
	}

	const canEdit = $derived(current !== null && (current.owned || current.role === "editor"));

	const attachedNames = $derived(
		(current?.knowledge_base_ids ?? [])
			.map((id) => stores.find((store) => store.id === id)?.name)
			// A base attached but no longer readable by this person shows as such
			// rather than vanishing: an agent quietly retrieving from fewer bases
			// than its configuration lists is what nobody debugs.
			.map((base) => base ?? "one you can no longer read")
	);

	async function share(event: SubmitEvent) {
		event.preventDefault();
		if (!current || !shareWith.trim()) return;
		busy = true;
		failure = null;
		notice = null;
		try {
			await gwPost(`agents/${current.id}/shares`, {
				principal_kind: shareKind,
				...(shareKind === "user"
					? { principal_email: shareWith.trim() }
					: { group_name: shareWith.trim() }),
				role: "viewer",
			});
			shareWith = "";
			notice = "Shared. They see passages only from bases they can already read.";
		} catch (err) {
			failure = err instanceof GatewayError ? err.message : "Could not share it.";
		} finally {
			busy = false;
		}
	}

	async function destroy() {
		if (!current) return;
		if (!confirm(`Delete the agent “${current.name}”?`)) return;
		busy = true;
		try {
			await gwDelete(`agents/${current.id}`);
			await load();
			backToList();
		} catch (err) {
			failure = err instanceof GatewayError ? err.message : "Could not delete it.";
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
					A model with standing instructions and knowledge attached. Pick one in the model list to
					use it.
				{:else if view === "form"}
					Everything that makes it an agent is on this one screen.
				{:else if current}
					Use it by picking <code>{current.model_name}</code> in the model list.
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
						<p class={s.STRIP_DETAIL}>
							{agents.filter((agent) => agent.owned).length} yours
						</p>
					</div>
				</div>
				<div class="flex gap-2">
					<button onclick={refresh} disabled={refreshing} class={s.SECONDARY}>
						<IconRefresh class="size-4 {refreshing ? 'animate-spin' : ''}" />
						{refreshing ? "Refreshing…" : "Refresh"}
					</button>
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
						<h3 class={s.SECTION_TITLE}>Yours and shared with you ({agents.length})</h3>
						<div class={s.GRID}>
							{#each agents as agent (agent.id)}
								<button
									type="button"
									onclick={() => openDetail(agent)}
									class="{s.card(agent.is_active)} text-left"
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
											<span class="{s.PILL} {s.PILL_TONES.busy}">
												<code class="font-mono">{agent.model_name}</code>
											</span>
											{#if agent.knowledge_base_ids.length > 0}
												<span class="text-xs text-gray-600 dark:text-gray-400">
													{agent.knowledge_base_ids.length} base{agent.knowledge_base_ids.length ===
													1
														? ""
														: "s"}
												</span>
											{/if}
											{#if !agent.owned}
												<span class="{s.PILL} {s.PILL_TONES.neutral}">
													shared · {agent.role}
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
						<li>• An agent appears in the model list as <code>agent:name</code>.</li>
						<li>
							• Its instructions go <em>before</em> yours — it supplies defaults, not overrides.
						</li>
						<li>• Sharing an agent does <strong>not</strong> share its knowledge bases.</li>
						<li>• Shared with somebody who cannot use its model, it is hidden from them.</li>
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
							disabled={busy || editing !== null}
						/>
						{#if editing}
							<p class={s.HINT}>
								Fixed: the name is how the agent is addressed, so renaming would break conversations
								that use it.
							</p>
						{/if}
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
						Sharing this agent does <strong>not</strong> share these — whoever uses it sees passages only
						from bases they can already read.
					</p>
				</div>

				<div class="flex flex-wrap gap-3">
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
					<div>
						<label for="agent-temp" class={s.LABEL}>Temperature</label>
						<input
							id="agent-temp"
							type="number"
							step="0.1"
							min="0"
							max="2"
							class="{s.INPUT} w-32"
							bind:value={temperature}
							disabled={busy}
						/>
						<p class={s.HINT}>Blank leaves it to the caller.</p>
					</div>
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
								{attachedNames.length} knowledge base{attachedNames.length === 1 ? "" : "s"} · up to {current.retrieval_limit}
								passage{current.retrieval_limit === 1 ? "" : "s"}
								per answer
								{#if !current.owned}· shared with you as {current.role}{/if}
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
							{canEdit ? "Edit" : "View settings"}
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

				{#if current.owned}
					<div>
						<h3 class={s.SECTION_TITLE}>Share it</h3>
						<form class="flex flex-wrap items-end gap-2" onsubmit={share}>
							<div>
								<label for="agent-share-kind" class={s.LABEL}>With</label>
								<select id="agent-share-kind" class={s.INPUT} bind:value={shareKind}>
									<option value="user">A person</option>
									<option value="group">A group</option>
								</select>
							</div>
							<div class="min-w-48 flex-1">
								<label for="agent-share-who" class={s.LABEL}>
									{shareKind === "user" ? "Their email address" : "Group name"}
								</label>
								{#if shareKind === "group" && groups.length > 0}
									<select id="agent-share-who" class={s.INPUT} bind:value={shareWith}>
										<option value="">— choose —</option>
										{#each groups as group (group.id)}
											<option value={group.name}>{group.name}</option>
										{/each}
									</select>
								{:else}
									<input
										id="agent-share-who"
										class={s.INPUT}
										placeholder={shareKind === "user" ? "colleague@example.org" : "research"}
										bind:value={shareWith}
									/>
								{/if}
							</div>
							<button type="submit" disabled={busy || !shareWith.trim()} class={s.PRIMARY}>
								<IconShare class="size-4" />
								Share
							</button>
						</form>
						{#if notice}
							<p class="{s.NOTICE} mt-2">{notice}</p>
						{/if}
						<p class={s.HINT}>
							Sharing this does <strong>not</strong> share its knowledge bases. And if they cannot
							use <code>{current.model}</code>, it will not appear in their model list and calling
							it by name tells them why — the share is still allowed.
						</p>
						<div class="mt-3 flex justify-end">
							<button onclick={destroy} disabled={busy} class={s.CARD_DESTRUCTIVE}>
								<IconTrash class="size-3" />
								Delete this agent
							</button>
						</div>
					</div>
				{/if}
			</div>
		{/if}
	</div>
</Modal>
