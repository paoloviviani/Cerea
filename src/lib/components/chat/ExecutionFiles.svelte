<script lang="ts">
	import CarbonDocumentAttachment from "~icons/carbon/document-attachment";
	import CarbonClose from "~icons/carbon/close";
	import EosIconsLoading from "~icons/eos-icons/loading";
	import LucideTriangleAlert from "~icons/lucide/triangle-alert";
	import { getMountsStore } from "$lib/utils/execution/mounts.svelte";
	import { listKnowledgeFiles, type KnowledgeFileRef } from "$lib/utils/execution/files";

	/**
	 * Mount knowledge documents into the execution runtime at /mnt/data, so
	 * model-written code can analyze what the person already has. The list is
	 * the knowledge bases this user can read, fetched through the app's own
	 * auth-scoped endpoints at open time; the 50 MB cap is enforced on the
	 * fetch itself (see files.ts).
	 */
	const mounts = getMountsStore();

	let open = $state(false);
	let loading = $state(false);
	let error = $state("");
	let files = $state<KnowledgeFileRef[]>([]);
	let loadedOnce = $state(false);
	let busyName = $state<string | null>(null);


	async function toggle() {
		open = !open;
		if (open && !loadedOnce) {
			loadedOnce = true;
			loading = true;
			error = "";
			try {
				files = await listKnowledgeFiles();
			} catch (err) {
				error = err instanceof Error ? err.message : "could not list knowledge files";
			} finally {
				loading = false;
			}
		}
	}

	async function mount(ref: KnowledgeFileRef) {
		if (!mounts || busyName) return;
		busyName = ref.title;
		error = "";
		try {
			await mounts.addKnowledge(ref);
			open = false;
		} catch (err) {
			error = err instanceof Error ? err.message : "could not load the file";
		} finally {
			busyName = null;
		}
	}

	function grouped(files: KnowledgeFileRef[]): Array<[string, KnowledgeFileRef[]]> {
		const groups = new Map<string, KnowledgeFileRef[]>();
		for (const file of files) {
			const list = groups.get(file.storeName) ?? [];
			list.push(file);
			groups.set(file.storeName, list);
		}
		return [...groups.entries()];
	}
</script>

<div class="relative">
	<button
		type="button"
		class="btn rounded-md border border-gray-200/80 bg-white/90 p-1.5 text-xs text-gray-500 backdrop-blur-xs hover:bg-gray-100 hover:text-gray-600 dark:border-gray-700/80 dark:bg-gray-900/90 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-300"
		title="Mount knowledge files into /mnt/data"
		aria-expanded={open}
		onclick={toggle}
	>
		{#if mounts?.busy}
			<EosIconsLoading />
		{:else}
			<CarbonDocumentAttachment />
		{/if}
	</button>

	{#if open}
		<div
			class="absolute top-full right-0 z-20 mt-1 w-72 rounded-lg border border-gray-200 bg-white shadow-lg dark:border-gray-700 dark:bg-gray-800"
		>
			<div
				class="flex items-center justify-between border-b border-gray-100 px-3 py-2 text-xs font-medium text-gray-600 dark:border-gray-700 dark:text-gray-300"
			>
				<span>Knowledge files → /mnt/data</span>
				<button
					type="button"
					class="btn rounded p-0.5 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
					title="Close"
					onclick={() => (open = false)}
				>
					<CarbonClose class="text-xs" />
				</button>
			</div>
			<div class="scrollbar-custom max-h-72 overflow-y-auto p-1.5">
				{#if loading}
					<div class="flex items-center justify-center gap-2 p-4 text-xs text-gray-400">
						<EosIconsLoading />
						Loading knowledge files
					</div>
				{:else if error}
					<div class="flex items-start gap-1.5 p-2 text-xs text-amber-600 dark:text-amber-400">
						<LucideTriangleAlert class="mt-0.5 shrink-0" />
						<span>{error}</span>
					</div>
				{:else if grouped(files).length === 0}
					<div class="p-3 text-xs text-gray-400">No indexed knowledge files yet.</div>
				{:else}
					{#each grouped(files) as [storeName, group] (storeName)}
						<div
							class="px-2 pt-1.5 pb-0.5 text-[10px] font-semibold text-gray-400 uppercase dark:text-gray-500"
						>
							{storeName}
						</div>
						{#each group as file (file.documentId)}
							<button
								type="button"
								class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-gray-700 hover:bg-gray-100 disabled:opacity-50 dark:text-gray-200 dark:hover:bg-gray-700/60"
								disabled={busyName !== null}
								onclick={() => mount(file)}
							>
								<CarbonDocumentAttachment class="shrink-0 text-gray-400" />
								<span class="min-w-0 flex-1 truncate">{file.title}</span>
								{#if busyName === file.title}
									<EosIconsLoading class="shrink-0 text-gray-400" />
								{/if}
							</button>
						{/each}
					{/each}
				{/if}
			</div>
		</div>
	{/if}
</div>
