<!--
	One dialog that creates a fully configured project, and edits one.

	The same shape as `AgentModal`, and for the same reason: everything that
	makes a project a project — its standing instructions, its knowledge bases,
	whether its own past chats are retrievable — was on the second screen when
	create and configure were separate, so a new project was a folder with a
	name until somebody went looking for the settings.

	One create request, so no progress counter: the knowledge bases are named
	by id and belong to the gateway already.
-->
<script lang="ts">
	import { untrack } from "svelte";
	import Modal from "./Modal.svelte";
	import { GatewayError, type VectorStore } from "$lib/gateway";
	import type { ProjectView } from "$lib/types/Project";
	import { base } from "$app/paths";

	interface Props {
		stores: VectorStore[];
		/** Present to edit, absent to create. */
		project?: ProjectView | null;
		onsaved: (project: ProjectView) => void;
		onclose: () => void;
	}

	let { stores, project = null, onsaved, onclose }: Props = $props();

	const editing = $derived(project !== null);
	const readOnly = $derived(project !== null && !project.owned);

	// Seeded once on purpose — the dialog is mounted fresh each time it opens
	// and then owns its fields. A form that re-seeded itself from the prop
	// would discard what somebody was typing the moment a reload landed.
	let name = $state(untrack(() => project?.name ?? ""));
	let description = $state(untrack(() => project?.description ?? ""));
	let instructions = $state(untrack(() => project?.instructions ?? ""));
	let attached = $state<string[]>(untrack(() => [...(project?.knowledgeBaseIds ?? [])]));
	let indexPastChats = $state(untrack(() => project?.indexPastChats ?? false));
	let retrievalLimit = $state(untrack(() => String(project?.retrievalLimit ?? 6)));

	let busy = $state(false);
	let failure = $state<string | null>(null);

	function toggle(id: string) {
		attached = attached.includes(id) ? attached.filter((entry) => entry !== id) : [...attached, id];
	}

	async function submit(event: SubmitEvent) {
		event.preventDefault();
		if (!name.trim()) return;
		busy = true;
		failure = null;
		try {
			const body = {
				name: name.trim(),
				description: description.trim(),
				instructions,
				knowledgeBaseIds: attached,
				indexPastChats,
				retrievalLimit: Number(retrievalLimit) || 6,
			};
			const response = await fetch(
				editing && project ? `${base}/api/v2/projects/${project.id}` : `${base}/api/v2/projects`,
				{
					method: editing ? "PATCH" : "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(body),
				}
			);
			if (!response.ok) {
				const parsed = (await response.json().catch(() => null)) as { message?: string } | null;
				throw new Error(parsed?.message ?? `Could not save it (${response.status}).`);
			}
			onsaved((await response.json()) as ProjectView);
			onclose();
		} catch (err) {
			failure =
				err instanceof GatewayError || err instanceof Error ? err.message : "Could not save it.";
		} finally {
			busy = false;
		}
	}
</script>

<Modal width="max-w-xl" closeButton {onclose} labelledBy="project-modal-title">
	<form class="flex max-h-[85vh] flex-col gap-4 overflow-y-auto p-6" onsubmit={submit}>
		<h2 id="project-modal-title" class="text-lg font-semibold">
			{editing ? `Edit ${project?.name}` : "New project"}
		</h2>

		<label class="flex flex-col gap-1">
			<span class="text-sm font-medium">Name</span>
			<input
				class="rounded-lg border border-gray-300 bg-white p-2 text-sm disabled:opacity-60 dark:border-gray-600 dark:bg-gray-900"
				placeholder="Grant application"
				maxlength="128"
				bind:value={name}
				required
				disabled={busy || readOnly}
			/>
		</label>

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
			<span class="text-sm font-medium">Standing instructions</span>
			<textarea
				class="min-h-28 rounded-lg border border-gray-300 bg-white p-2 text-sm disabled:opacity-60 dark:border-gray-600 dark:bg-gray-900"
				placeholder="We are writing a Horizon Europe proposal. Answer in British English and cite the call text where it applies."
				bind:value={instructions}
				disabled={busy || readOnly}
			></textarea>
			<span class="text-xs text-gray-500 dark:text-gray-400">
				Added to the system prompt of every conversation in this project. Text only — a project with
				tools and a fixed model is what an agent is.
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
				Sharing this project does <strong>not</strong> share these — whoever uses it sees passages only
				from bases they can already read.
			</span>
		</div>

		<label class="flex items-start gap-2 text-sm">
			<input
				type="checkbox"
				bind:checked={indexPastChats}
				disabled={busy || readOnly}
				class="mt-0.5"
			/>
			<span>
				Search this project's own past conversations
				<span class="block text-xs text-gray-500 dark:text-gray-400">
					Finished exchanges are written to a knowledge base of their own — it appears under
					Knowledge, and you can empty or delete it like any other. Off by default, because it
					copies what was said into a searchable store.
				</span>
			</span>
		</label>

		<label class="flex w-40 flex-col gap-1">
			<span class="text-xs text-gray-500 dark:text-gray-400">Passages per answer</span>
			<input
				type="number"
				min="1"
				max="20"
				class="rounded-lg border border-gray-300 bg-white p-2 text-sm disabled:opacity-60 dark:border-gray-600 dark:bg-gray-900"
				bind:value={retrievalLimit}
				disabled={busy || readOnly}
			/>
		</label>

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
					disabled={busy || !name.trim()}
					class="rounded-full bg-black px-4 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-white dark:text-black"
				>
					{busy ? "Saving…" : editing ? "Save" : "Create"}
				</button>
			{/if}
		</div>
	</form>
</Modal>
