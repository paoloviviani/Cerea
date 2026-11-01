<script lang="ts">
	/**
	 * The one confirmation for deleting a project, used by the project page and
	 * the sidebar. The default deletes everything the project holds, its chats
	 * and its past-chats knowledge base included; the checkbox keeps the chats.
	 * The caller does the request (`ondelete` gets `keepChats` and throws on
	 * failure, which this shows inline) so each keeps its own fetch.
	 */
	import { m } from "$lib/paraglide/messages";
	import Modal from "$lib/components/Modal.svelte";
	import type { ProjectView } from "$lib/types/Project";

	interface Props {
		project: Pick<ProjectView, "name" | "hasMemory" | "conversationCount" | "shares">;
		onclose?: () => void;
		ondelete: (keepChats: boolean) => Promise<void>;
	}

	let { project, onclose, ondelete }: Props = $props();

	let keepChats = $state(false);
	let busy = $state(false);
	let failure = $state("");

	// A shared project's count includes other members' chats, which are not
	// deleted: say no number rather than a wrong one.
	const count = $derived(project.shares.length === 0 ? project.conversationCount : undefined);
	const shared = $derived(project.shares.length > 0);

	function close() {
		if (!busy) onclose?.();
	}

	async function confirmDelete() {
		busy = true;
		failure = "";
		try {
			await ondelete(keepChats);
			onclose?.();
		} catch (err) {
			failure = err instanceof Error && err.message ? err.message : "";
			busy = false;
		}
	}
</script>

<Modal onclose={close} width="w-[90dvh] md:w-[480px]" labelledBy="delete-project-title">
	<div class="flex w-full flex-col gap-4 p-6">
		<div class="flex items-start justify-between gap-3">
			<h2 id="delete-project-title" class="text-xl font-semibold text-gray-800 dark:text-gray-200">
				{m["projects.delete.title"]({ name: project.name })}
			</h2>
			<button
				type="button"
				class="group outline-hidden"
				onclick={close}
				aria-label={m["projects.delete.close"]()}
			>
				<svg
					xmlns="http://www.w3.org/2000/svg"
					viewBox="0 0 32 32"
					class="size-5 text-gray-700 group-hover:text-gray-500 dark:text-gray-300 dark:group-hover:text-gray-400"
					><path
						d="M24 9.41 22.59 8 16 14.59 9.41 8 8 9.41 14.59 16 8 22.59 9.41 24 16 17.41 22.59 24 24 22.59 17.41 16 24 9.41z"
						fill="currentColor"
					/></svg
				>
			</button>
		</div>

		<div class="text-sm text-gray-600 dark:text-gray-400">
			<p class="mb-1 font-medium">{m["projects.delete.deleted_intro"]()}</p>
			<ul class="list-disc pl-5" data-testid="delete-project-deleted">
				{#if keepChats}
					<li>{m["projects.delete.chats_kept"]()}</li>
				{:else if count !== undefined}
					<li>{m["projects.delete.chats_count"]({ count })}</li>
				{:else}
					<li>{m["projects.delete.chats"]()}</li>
				{/if}
				<li>{m["projects.delete.notes"]()}</li>
				<li>{m["projects.delete.files"]()}</li>
				{#if project.hasMemory}
					<li>{m["projects.delete.memory"]()}</li>
				{/if}
			</ul>
			<p class="mt-3 mb-1 font-medium">{m["projects.delete.kept_intro"]()}</p>
			<ul class="list-disc pl-5">
				<li>{m["projects.delete.kept_bases"]()}</li>
				{#if shared}
					<li>{m["projects.delete.kept_members"]()}</li>
				{/if}
			</ul>
		</div>

		<label class="flex items-center gap-2 text-sm text-gray-800 dark:text-gray-200">
			<input type="checkbox" bind:checked={keepChats} disabled={busy} />
			{m["projects.delete.keep_chats"]()}
		</label>

		{#if failure}
			<p role="alert" class="text-sm text-red-600 dark:text-red-400">{failure}</p>
		{/if}

		<div class="flex items-center justify-end gap-2">
			<button
				type="button"
				disabled={busy}
				class="inline-flex items-center rounded-xl border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-900 shadow-sm outline-hidden hover:bg-gray-50 disabled:opacity-60 dark:border-gray-700 dark:bg-gray-700 dark:text-gray-100 dark:hover:bg-gray-600"
				onclick={close}
			>
				{m["projects.delete.cancel"]()}
			</button>
			<button
				type="button"
				disabled={busy}
				class="inline-flex items-center rounded-xl border border-red-600 bg-red-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-red-700 focus:ring-2 focus:ring-red-400 focus:ring-offset-2 focus:outline-hidden disabled:opacity-60 dark:border-red-500 dark:bg-red-500 dark:hover:bg-red-600"
				onclick={confirmDelete}
			>
				{busy ? m["projects.delete.busy"]() : m["projects.delete.confirm"]()}
			</button>
		</div>
	</div>
</Modal>
