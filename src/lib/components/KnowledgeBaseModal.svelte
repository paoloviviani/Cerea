<!--
	One dialog that creates a knowledge base *and* fills it.

	It replaces a two-step flow — create the entity, land on a detail page, then
	add documents — which was cumbersome for the obvious reason: nobody wants an
	empty knowledge base. What somebody has is a name and a pile of files, and
	this asks for exactly that.

	**No title is asked for a document.** An uploaded file is titled by its
	filename, which is what a reader recognises and what the gateway already
	defaults to. A pasted note gets its first line. Asking for a title per
	document was busywork on the way to the thing somebody actually wanted.

	**The create is one button but several requests**, and that shows rather
	than hides: the base is made first because a file cannot be attached to a
	base that does not exist, then each file is uploaded and attached. So the
	progress line counts, and a failure part-way names what did not make it —
	the base exists by then, and pretending otherwise would lose the files that
	did land.
-->
<script lang="ts">
	import Modal from "./Modal.svelte";
	import FileDrop from "./FileDrop.svelte";
	import { GatewayError, gwPost, gwUpload, type VectorStore } from "$lib/gateway";

	interface Props {
		maxUploadBytes?: number;
		/** Called with the created base, so the list can show it immediately. */
		oncreated: (store: VectorStore) => void;
		onclose: () => void;
	}

	let { maxUploadBytes, oncreated, onclose }: Props = $props();

	let name = $state("");
	let description = $state("");
	let files = $state<File[]>([]);
	let note = $state("");
	let busy = $state(false);
	let progress = $state<string | null>(null);
	let failure = $state<string | null>(null);
	/** Files that failed, so a partial success says which. */
	let rejected = $state<string[]>([]);

	async function submit(event: SubmitEvent) {
		event.preventDefault();
		if (!name.trim()) return;
		busy = true;
		failure = null;
		rejected = [];

		let store: VectorStore;
		try {
			progress = "Creating…";
			store = await gwPost<VectorStore>("vector_stores", {
				name: name.trim(),
				description: description.trim(),
			});
		} catch (err) {
			failure = err instanceof GatewayError ? err.message : "Could not create it.";
			busy = false;
			progress = null;
			return;
		}

		// Past this point the base exists. Every later failure is reported
		// *against* it rather than treated as a failed creation, because
		// discarding a base that already holds four of five files would be
		// worse than saying which one did not arrive.
		let done = 0;
		for (const file of files) {
			progress = `Uploading ${++done} of ${files.length}: ${file.name}`;
			try {
				const stored = await gwUpload<{ id: string }>("files", file);
				// No title: the gateway falls back to the filename, which is the
				// name somebody will recognise in a citation.
				await gwPost(`vector_stores/${store.id}/files`, { file_id: stored.id });
			} catch (err) {
				rejected = [
					...rejected,
					`${file.name} — ${err instanceof GatewayError ? err.message : "upload failed"}`,
				];
			}
		}

		if (note.trim()) {
			progress = "Adding the note…";
			try {
				await gwPost(`vector_stores/${store.id}/text`, {
					text: note.trim(),
					// The first line, trimmed to something that fits a list. A
					// note with no title is still a note somebody has to find
					// again later.
					title: note.trim().split("\n")[0].slice(0, 80),
				});
			} catch (err) {
				rejected = [
					...rejected,
					`the note — ${err instanceof GatewayError ? err.message : "could not be added"}`,
				];
			}
		}

		busy = false;
		progress = null;
		oncreated(store);
		if (rejected.length === 0) {
			onclose();
		} else {
			// Kept open on a partial failure: closing would take the only place
			// the list of what failed is shown.
			failure = "The base was created, but some things did not make it in.";
		}
	}
</script>

<Modal width="max-w-xl" closeButton {onclose} labelledBy="kb-modal-title">
	<form class="flex max-h-[85vh] flex-col gap-4 overflow-y-auto p-6" onsubmit={submit}>
		<h2 id="kb-modal-title" class="text-lg font-semibold">New knowledge base</h2>

		<label class="flex flex-col gap-1">
			<span class="text-sm font-medium">Name</span>
			<input
				class="rounded-lg border border-gray-300 bg-white p-2 text-sm dark:border-gray-600 dark:bg-gray-900"
				placeholder="Team handbook"
				maxlength="128"
				bind:value={name}
				required
				disabled={busy}
			/>
		</label>

		<label class="flex flex-col gap-1">
			<span class="text-sm font-medium">What is in it <span class="text-gray-500">(optional)</span></span>
			<input
				class="rounded-lg border border-gray-300 bg-white p-2 text-sm dark:border-gray-600 dark:bg-gray-900"
				maxlength="500"
				bind:value={description}
				disabled={busy}
			/>
		</label>

		<div class="flex flex-col gap-1">
			<span class="text-sm font-medium">Documents <span class="text-gray-500">(optional)</span></span>
			<FileDrop bind:files maxBytes={maxUploadBytes} disabled={busy} />
			<span class="text-xs text-gray-500 dark:text-gray-400">
				Each file keeps its own filename as its title. A scan needs an OCR model, which an
				administrator configures.
			</span>
		</div>

		<label class="flex flex-col gap-1">
			<span class="text-sm font-medium">Or paste a note <span class="text-gray-500">(optional)</span></span>
			<textarea
				class="min-h-20 rounded-lg border border-gray-300 bg-white p-2 text-sm dark:border-gray-600 dark:bg-gray-900"
				bind:value={note}
				disabled={busy}
			></textarea>
			<span class="text-xs text-gray-500 dark:text-gray-400">
				Titled by its first line. You can add more once it exists.
			</span>
		</label>

		{#if progress}
			<p class="text-xs text-gray-600 dark:text-gray-300">{progress}</p>
		{/if}
		{#if failure}
			<p class="text-sm text-red-700 dark:text-red-300">{failure}</p>
		{/if}
		{#if rejected.length > 0}
			<ul class="flex flex-col gap-0.5 text-xs text-red-700 dark:text-red-300">
				{#each rejected as line (line)}
					<li>{line}</li>
				{/each}
			</ul>
		{/if}

		<div class="flex justify-end gap-2">
			<button
				type="button"
				onclick={onclose}
				class="rounded-full border border-gray-300 px-4 py-2 text-sm dark:border-gray-600"
			>
				{rejected.length > 0 ? "Close" : "Cancel"}
			</button>
			{#if rejected.length === 0}
				<button
					type="submit"
					disabled={busy || !name.trim()}
					class="rounded-full bg-black px-4 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-white dark:text-black"
				>
					{busy
						? "Working…"
						: files.length > 0
							? `Create and add ${files.length} file${files.length === 1 ? "" : "s"}`
							: "Create"}
				</button>
			{/if}
		</div>
	</form>
</Modal>
