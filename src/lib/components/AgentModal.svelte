<!--
	One dialog that creates a fully configured agent.

	It replaces create-then-configure, which for an agent was worse than for a
	knowledge base: an agent with no instructions and no knowledge bases is not
	a partially-built thing, it is just the underlying model with a new name.
	Everything that makes it an agent was on the second screen.

	So the model, the instructions, the knowledge bases and the retrieval size
	are all here, and **the create is a single request** — the gateway's
	`POST /v1/agents` takes all of it, which is why this one needs no progress
	counter where the knowledge-base dialog does.

	The same component edits an existing agent: the fields are identical, and a
	second nearly-identical dialog is how the two drift apart. `agent` being
	present is what switches it.
-->
<script lang="ts">
	import { untrack } from "svelte";
	import Modal from "./Modal.svelte";
	import { GatewayError, gwPost, type Agent, type VectorStore } from "$lib/gateway";

	interface ModelCard {
		id: string;
		display_name?: string | null;
		kind?: string;
	}

	interface Props {
		models: ModelCard[];
		stores: VectorStore[];
		/** Present to edit, absent to create. */
		agent?: Agent | null;
		onsaved: (agent: Agent) => void;
		onclose: () => void;
	}

	let { models, stores, agent = null, onsaved, onclose }: Props = $props();

	const editing = $derived(agent !== null);
	// An editor may change an agent shared with them; only the owner may not be
	// blocked from anything here. The gateway decides; this mirrors it so the
	// controls are not live for somebody who will be refused.
	const readOnly = $derived(agent !== null && !agent.owned && agent.role !== "editor");

	// Seeded once, `untrack` said out loud rather than left for the compiler to
	// warn about. The dialog is mounted fresh every time it opens (`{#if showEdit}`)
	// and then owns its own fields, so the initial value *is* what is wanted —
	// a form that re-seeded itself from the prop mid-edit would discard what
	// somebody was typing the moment a background reload landed.
	let name = $state(untrack(() => agent?.name ?? ""));
	let model = $state(untrack(() => agent?.model ?? models[0]?.id ?? ""));
	let description = $state(untrack(() => agent?.description ?? ""));
	let systemPrompt = $state(untrack(() => agent?.system_prompt ?? ""));
	let attached = $state<string[]>(untrack(() => [...(agent?.knowledge_base_ids ?? [])]));
	let retrievalLimit = $state(untrack(() => String(agent?.retrieval_limit ?? 6)));
	let temperature = $state(
		untrack(() =>
			typeof agent?.generation?.temperature === "number"
				? String(agent.generation.temperature)
				: ""
		)
	);

	let busy = $state(false);
	let failure = $state<string | null>(null);

	function toggle(id: string) {
		attached = attached.includes(id)
			? attached.filter((entry) => entry !== id)
			: [...attached, id];
	}

	async function submit(event: SubmitEvent) {
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
				// Blank means "say nothing", not zero: an agent supplies defaults
				// only where the request is silent, and writing 0 would pin every
				// conversation to it.
				generation: temperature.trim() === "" ? {} : { temperature: Number(temperature) },
			};
			let saved: Agent;
			if (editing && agent) {
				// The name is not editable: it *is* the address (`agent:<name>`),
				// so renaming would break every conversation that named it.
				saved = await gwPost<Agent>(`agents/${agent.id}`, { ...body, model });
			} else {
				saved = await gwPost<Agent>("agents", { ...body, name: name.trim(), model });
			}
			onsaved(saved);
			onclose();
		} catch (err) {
			failure = err instanceof GatewayError ? err.message : "Could not save it.";
		} finally {
			busy = false;
		}
	}
</script>

<Modal width="max-w-xl" closeButton {onclose} labelledBy="agent-modal-title">
	<form class="flex max-h-[85vh] flex-col gap-4 overflow-y-auto p-6" onsubmit={submit}>
		<h2 id="agent-modal-title" class="text-lg font-semibold">
			{editing ? `Edit ${agent?.name}` : "New agent"}
		</h2>

		{#if editing && agent}
			<p class="text-xs text-gray-500 dark:text-gray-400">
				Use it by picking <code>{agent.model_name}</code> in the model list.
			</p>
		{/if}

		<div class="flex flex-wrap gap-3">
			<label class="flex flex-1 flex-col gap-1">
				<span class="text-sm font-medium">Name</span>
				<input
					class="rounded-lg border border-gray-300 bg-white p-2 text-sm disabled:opacity-60 dark:border-gray-600 dark:bg-gray-900"
					placeholder="handbook"
					pattern="[A-Za-z0-9][A-Za-z0-9._\-]*"
					maxlength="128"
					bind:value={name}
					required
					disabled={busy || editing}
				/>
				{#if editing}
					<span class="text-xs text-gray-500 dark:text-gray-400">
						Fixed: the name is how the agent is addressed, so renaming would break
						conversations that use it.
					</span>
				{/if}
			</label>

			<label class="flex flex-1 flex-col gap-1">
				<span class="text-sm font-medium">Runs on</span>
				<select
					class="rounded-lg border border-gray-300 bg-white p-2 text-sm disabled:opacity-60 dark:border-gray-600 dark:bg-gray-900"
					bind:value={model}
					disabled={busy || readOnly || models.length === 0}
				>
					{#each models as entry (entry.id)}
						<option value={entry.id}>{entry.display_name || entry.id}</option>
					{/each}
				</select>
				<span class="text-xs text-gray-500 dark:text-gray-400">
					Only models you can already use.
				</span>
			</label>
		</div>

		<label class="flex flex-col gap-1">
			<span class="text-sm font-medium">
				What it is for <span class="text-gray-500">(optional)</span>
			</span>
			<input
				class="rounded-lg border border-gray-300 bg-white p-2 text-sm disabled:opacity-60 dark:border-gray-600 dark:bg-gray-900"
				maxlength="500"
				bind:value={description}
				disabled={busy || readOnly}
			/>
		</label>

		<label class="flex flex-col gap-1">
			<span class="text-sm font-medium">Instructions</span>
			<textarea
				class="min-h-28 rounded-lg border border-gray-300 bg-white p-2 text-sm disabled:opacity-60 dark:border-gray-600 dark:bg-gray-900"
				placeholder="You answer only from the passages provided, and you name the source."
				bind:value={systemPrompt}
				disabled={busy || readOnly}
			></textarea>
			<span class="text-xs text-gray-500 dark:text-gray-400">
				Sent ahead of every conversation. Somebody's own system message is kept and comes
				after this.
			</span>
		</label>

		<div class="flex flex-col gap-1">
			<span class="text-sm font-medium">
				Knowledge bases <span class="text-gray-500">(optional)</span>
			</span>
			{#if stores.length === 0}
				<p class="text-xs text-gray-500 dark:text-gray-400">
					You have none yet. Create one under Knowledge and it will appear here.
				</p>
			{:else}
				<div class="flex max-h-40 flex-col gap-1 overflow-y-auto">
					{#each stores as store (store.id)}
						<label class="flex items-start gap-2 text-sm">
							<input
								type="checkbox"
								checked={attached.includes(store.id)}
								onchange={() => toggle(store.id)}
								disabled={busy || readOnly}
								class="mt-0.5"
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
			<span class="text-xs text-gray-500 dark:text-gray-400">
				Sharing this agent does <strong>not</strong> share these — whoever uses it sees
				passages only from bases they can already read.
			</span>
		</div>

		<div class="flex flex-wrap gap-4">
			<label class="flex flex-col gap-1">
				<span class="text-xs text-gray-500 dark:text-gray-400">Passages per answer</span>
				<input
					type="number"
					min="1"
					max="50"
					class="w-28 rounded-lg border border-gray-300 bg-white p-2 text-sm disabled:opacity-60 dark:border-gray-600 dark:bg-gray-900"
					bind:value={retrievalLimit}
					disabled={busy || readOnly}
				/>
			</label>
			<label class="flex flex-col gap-1">
				<span class="text-xs text-gray-500 dark:text-gray-400">
					Temperature — blank leaves it to the caller
				</span>
				<input
					type="number"
					step="0.1"
					min="0"
					max="2"
					class="w-28 rounded-lg border border-gray-300 bg-white p-2 text-sm disabled:opacity-60 dark:border-gray-600 dark:bg-gray-900"
					bind:value={temperature}
					disabled={busy || readOnly}
				/>
			</label>
		</div>

		{#if failure}
			<p class="text-sm text-red-700 dark:text-red-300">{failure}</p>
		{/if}

		<div class="flex justify-end gap-2">
			<button
				type="button"
				onclick={onclose}
				class="rounded-full border border-gray-300 px-4 py-2 text-sm dark:border-gray-600"
			>
				{readOnly ? "Close" : "Cancel"}
			</button>
			{#if !readOnly}
				<button
					type="submit"
					disabled={busy || !name.trim() || !model}
					class="rounded-full bg-black px-4 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-white dark:text-black"
				>
					{busy ? "Saving…" : editing ? "Save" : "Create"}
				</button>
			{/if}
		</div>
	</form>
</Modal>
