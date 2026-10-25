<!--
	The chat's own administration screen for the knowledge pipeline (ADR 0062).

	It lives here rather than in the gateway's console because this is a
	decision about the *product*: which embedding model this deployment uses,
	and what reads its documents. The gateway supplies extraction, embedding and
	a vector store the way it supplies models and quotas; choosing among them
	belongs to whoever runs the application people actually use.

	The configuration and its consequences are on one screen on purpose.
	Changing the embedding model touches **no existing base** — each pins the
	model it was indexed with — so the only way to understand what a change
	means is to see, in the same view, which bases are now on an older model and
	would be re-embedded. That is the "older model" tag, and it is why Reindex
	sits beside it rather than on a page of its own.

	Who may be here is the gateway's decision. This page asks, and renders
	whatever refusal comes back: `user.isAdmin` in this app is derived from a
	HuggingFace organisation claim and has nothing to do with who administers
	*this* deployment.
-->
<script lang="ts">
	import { onMount } from "svelte";
	import { base } from "$app/paths";
	import { m } from "$lib/paraglide/messages";
	import { formatDateTime } from "$lib/i18n/format";
	import Rich from "$lib/i18n/Rich.svelte";

	interface BaseSummary {
		id: string;
		name: string;
		description: string;
		owner_email: string | null;
		group_name: string | null;
		embedding_model: string | null;
		dimensions: number | null;
		document_count: number;
		chunk_count: number;
		failed_count: number;
		stale: boolean;
		share_count: number;
		created_at: string;
	}

	interface ConfigEntry {
		id: string;
		embedding_model: string | null;
		extractor_model: string | null;
		chunk_chars: number | null;
		chunk_overlap: number | null;
		reason: string;
		changed_by: string | null;
		created_at: string;
	}

	interface ExtractorCandidate {
		id: string;
		/** This deployment's own infrastructure — Pystino's `?include=ocr`
		 * `local: true`, hidden from every other listing. */
		local: boolean;
	}

	interface Status {
		enabled: boolean;
		ready: boolean;
		embedding_model: string | null;
		/** What an upload would actually be read with — already resolved:
		 * env, then the screen's own stored choice, then the local extractor,
		 * then the first reader, then null. Never "Automatic": there is no
		 * value left that means "let the deployment decide and show nothing". */
		extractor_model: string | null;
		/** `"env"` means `extractor_model` is fixed by the deployment's own
		 * configuration and the picker is read-only; every other value is
		 * choosable. */
		extractor_source: "env" | "stored" | "local-default" | "first-available" | "none";
		vector_store: string;
		chunk_chars: number;
		chunk_overlap: number;
		max_upload_bytes: number;
		source: string;
		propagation_seconds: number;
		detail: string | null;
		available_embedding_models: string[];
		available_extractor_models: ExtractorCandidate[];
		bases: BaseSummary[];
		stale_base_count: number;
		history: ConfigEntry[];
	}

	let status = $state<Status | null>(null);
	let loadError = $state<string | null>(null);
	let saving = $state(false);
	let saveError = $state<string | null>(null);
	let notice = $state<string | null>(null);
	let reindexing = $state<string | null>(null);

	let embedding = $state("");
	let extractor = $state("");
	let chunkChars = $state("1200");
	let chunkOverlap = $state("150");

	function seed(next: Status) {
		status = next;
		// Pre-selected, not left on an empty "none chosen": the deployment's
		// resolved default (embedding: the first available model; the
		// document reader: `extractor_model`, already resolved the same way
		// `extractDocument.ts` would). Untouched, a save has nothing to send —
		// the diff below compares against this same default, not against a
		// stored value that may be null.
		embedding = next.embedding_model ?? next.available_embedding_models[0] ?? "";
		extractor = next.extractor_model ?? "";
		chunkChars = String(next.chunk_chars);
		chunkOverlap = String(next.chunk_overlap);
	}

	async function load() {
		loadError = null;
		const response = await fetch(`${base}/api/v2/admin/knowledge`);
		if (!response.ok) {
			// The gateway's own words. A 403 here means "you are not an
			// administrator of this deployment", which is a different and more
			// useful statement than "forbidden".
			const body = await response.text();
			loadError = body || m["admin.knowledge.gateway_answered"]({ status: response.status });
			return;
		}
		seed((await response.json()) as Status);
	}

	onMount(load);

	// Compared against what is stored, not what the picker shows: with nothing
	// stored the picker pre-selects the first model, and comparing against that
	// made Save answer "Nothing to change" and store nothing — knowledge then
	// stayed "no embedding model" with one visibly selected.
	const embeddingDefault = $derived(status ? (status.embedding_model ?? "") : "");
	const extractorDefault = $derived(status ? (status.extractor_model ?? "") : "");

	async function save(event: SubmitEvent) {
		event.preventDefault();
		if (!status) return;
		saveError = null;
		notice = null;

		// Only what changed. The gateway reads a null column as "this row does
		// not decide", so sending a whole document would overwrite settings
		// nobody touched — and silently re-chunk every base created afterwards.
		const body: Record<string, unknown> = {};
		if (embedding && embedding !== embeddingDefault) {
			body.embedding_model = embedding;
		}
		if (status.extractor_source !== "env" && extractor !== extractorDefault) {
			body.extractor_model = extractor;
		}
		if (Number(chunkChars) !== status.chunk_chars) body.chunk_chars = Number(chunkChars);
		if (Number(chunkOverlap) !== status.chunk_overlap) {
			body.chunk_overlap = Number(chunkOverlap);
		}

		if (Object.keys(body).length === 0) {
			notice = m["admin.knowledge.nothing_to_change"]();
			return;
		}

		saving = true;
		try {
			const response = await fetch(`${base}/api/v2/admin/knowledge`, {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			});
			if (!response.ok) {
				saveError =
					(await response.text()) ||
					m["admin.knowledge.gateway_answered"]({ status: response.status });
				return;
			}
			const next = (await response.json()) as Status;
			seed(next);
			// The consequence, not the acknowledgement. "Saved" alone would
			// leave somebody unaware they have just stranded four bases on a
			// model nothing new will use.
			notice =
				next.stale_base_count > 0
					? m["admin.knowledge.saved_stale"]({ count: next.stale_base_count })
					: m["admin.knowledge.saved"]();
		} finally {
			saving = false;
		}
	}

	async function reindex(target: BaseSummary) {
		reindexing = target.id;
		saveError = null;
		notice = null;
		try {
			const response = await fetch(`${base}/api/v2/admin/knowledge/reindex`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ base_id: target.id }),
			});
			if (!response.ok) {
				saveError =
					(await response.text()) ||
					m["admin.knowledge.gateway_answered"]({ status: response.status });
				return;
			}
			seed((await response.json()) as Status);
			notice = m["admin.knowledge.reindexing_notice"]({ name: target.name });
		} finally {
			reindexing = null;
		}
	}
</script>

<svelte:head><title>{m["admin.knowledge.page_title"]()}</title></svelte:head>

{#snippet code(text: string)}<code class="text-xs">{text}</code>{/snippet}

<div class="mx-auto flex max-w-4xl flex-col gap-6 p-6">
	<header class="flex flex-col gap-1">
		<h1 class="text-xl font-semibold">{m["admin.knowledge.title"]()}</h1>
		<p class="text-sm text-gray-500 dark:text-gray-400">
			{m["admin.knowledge.description"]()}
		</p>
	</header>

	{#if loadError}
		<div
			class="rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-200"
		>
			{loadError}
		</div>
	{:else if !status}
		<p class="text-sm text-gray-500">{m["admin.common.loading"]()}</p>
	{:else}
		{#if status.detail}
			<div
				class="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100"
			>
				{status.detail}
			</div>
		{/if}

		<form
			class="flex flex-col gap-5 rounded-lg border border-gray-200 p-5 dark:border-gray-700"
			onsubmit={save}
		>
			<div class="flex flex-col gap-1">
				<h2 class="font-medium">{m["admin.knowledge.pipeline.title"]()}</h2>
				<p class="text-xs text-gray-500 dark:text-gray-400">
					{status.source === "console"
						? m["admin.knowledge.pipeline.decided_here"]({
								seconds: Math.round(status.propagation_seconds),
							})
						: m["admin.knowledge.pipeline.decided_env"]({
								seconds: Math.round(status.propagation_seconds),
							})}
				</p>
			</div>

			<label class="flex flex-col gap-1">
				<span class="text-sm font-medium">{m["admin.knowledge.embedding.label"]()}</span>
				<select
					class="rounded-lg border border-gray-300 bg-white p-2 text-sm dark:border-gray-600 dark:bg-gray-900"
					bind:value={embedding}
					disabled={status.available_embedding_models.length === 0}
				>
					{#each status.available_embedding_models as name (name)}
						<option value={name}>{name}</option>
					{/each}
				</select>
				<span class="text-xs text-gray-500 dark:text-gray-400">
					{#if status.available_embedding_models.length === 0}
						{m["admin.knowledge.embedding.none"]()}
					{:else}
						{m["admin.knowledge.embedding.hint"]()}
					{/if}
				</span>
			</label>

			<label class="flex flex-col gap-1">
				<span class="text-sm font-medium">{m["admin.knowledge.extractor.label"]()}</span>
				{#if status.extractor_source === "env"}
					<div
						class="rounded-lg border border-gray-300 bg-gray-50 p-2 text-sm text-gray-700 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300"
					>
						{status.extractor_model} —
						<span class="text-xs">{m["admin.knowledge.extractor.from_env"]()}</span>
					</div>
				{:else}
					<select
						class="rounded-lg border border-gray-300 bg-white p-2 text-sm dark:border-gray-600 dark:bg-gray-900"
						bind:value={extractor}
						disabled={status.available_extractor_models.length === 0}
					>
						{#each status.available_extractor_models as candidate (candidate.id)}
							<option value={candidate.id}>
								{candidate.local
									? m["admin.knowledge.extractor.local_option"]({ id: candidate.id })
									: candidate.id}
							</option>
						{/each}
					</select>
				{/if}
				<span class="text-xs text-gray-500 dark:text-gray-400">
					{#if status.available_extractor_models.length === 0}
						{m["admin.knowledge.extractor.none"]()}
					{:else if status.extractor_source === "env"}
						<Rich
							parts={m["admin.knowledge.extractor.env_hint"].parts({ name: "CHAT_OCR_MODEL" })}
							tags={{ code }}
						/>
					{:else}
						{m["admin.knowledge.extractor.hint"]()}
					{/if}
				</span>
			</label>

			<div class="flex flex-wrap gap-4">
				<label class="flex flex-1 flex-col gap-1">
					<span class="text-sm font-medium">{m["admin.knowledge.chunk.chars"]()}</span>
					<input
						type="number"
						min="80"
						max="20000"
						class="rounded-lg border border-gray-300 bg-white p-2 text-sm dark:border-gray-600 dark:bg-gray-900"
						bind:value={chunkChars}
					/>
				</label>
				<label class="flex flex-1 flex-col gap-1">
					<span class="text-sm font-medium">{m["admin.knowledge.chunk.overlap"]()}</span>
					<input
						type="number"
						min="0"
						max="5000"
						class="rounded-lg border border-gray-300 bg-white p-2 text-sm dark:border-gray-600 dark:bg-gray-900"
						bind:value={chunkOverlap}
					/>
				</label>
			</div>
			<p class="-mt-3 text-xs text-gray-500 dark:text-gray-400">
				{m["admin.knowledge.chunk.hint"]()}
			</p>

			{#if saveError}
				<p class="text-sm text-red-700 dark:text-red-300">{saveError}</p>
			{/if}
			{#if notice}
				<p class="text-sm text-gray-700 dark:text-gray-300">{notice}</p>
			{/if}

			<div class="flex justify-end">
				<button
					type="submit"
					disabled={saving}
					class="rounded-full bg-black px-4 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-white dark:text-black"
				>
					{saving ? m["admin.common.saving"]() : m["admin.common.save"]()}
				</button>
			</div>
		</form>

		<section class="flex flex-col gap-3 rounded-lg border border-gray-200 p-5 dark:border-gray-700">
			<div class="flex flex-col gap-1">
				<h2 class="font-medium">{m["admin.knowledge.bases.title"]()}</h2>
				<p class="text-xs text-gray-500 dark:text-gray-400">
					{#if status.stale_base_count > 0}
						{m["admin.knowledge.bases.stale"]({
							stale: status.stale_base_count,
							total: status.bases.length,
						})}
					{:else}
						{m["admin.knowledge.bases.current"]()}
					{/if}
				</p>
			</div>

			{#if status.bases.length === 0}
				<p class="text-sm text-gray-500">
					{m["admin.knowledge.bases.none"]()}
				</p>
			{:else}
				<div class="overflow-x-auto">
					<table class="w-full text-sm">
						<thead class="text-left text-xs text-gray-500 uppercase dark:text-gray-400">
							<tr>
								<th class="py-2 pr-3">{m["admin.knowledge.bases.col.base"]()}</th>
								<th class="py-2 pr-3">{m["admin.knowledge.bases.col.owner"]()}</th>
								<th class="py-2 pr-3">{m["admin.knowledge.bases.col.embedded_with"]()}</th>
								<th class="py-2 pr-3 text-right">{m["admin.knowledge.bases.col.documents"]()}</th>
								<th class="py-2 pr-3 text-right">{m["admin.knowledge.bases.col.passages"]()}</th>
								<th class="py-2"></th>
							</tr>
						</thead>
						<tbody>
							{#each status.bases as row (row.id)}
								<tr class="border-t border-gray-100 dark:border-gray-800">
									<td class="py-2 pr-3">
										<div>{row.name}</div>
										{#if row.description}
											<div class="text-xs text-gray-500">{row.description}</div>
										{/if}
									</td>
									<td class="py-2 pr-3">
										<div>{row.owner_email ?? m["admin.knowledge.erased"]()}</div>
										{#if row.group_name}
											<div class="text-xs text-gray-500">{row.group_name}</div>
										{/if}
									</td>
									<td class="py-2 pr-3 whitespace-nowrap">
										{row.embedding_model ?? m["admin.knowledge.bases.not_indexed"]()}
										{#if row.stale}
											<span
												class="ml-1 rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-900 dark:bg-amber-900 dark:text-amber-100"
												>{m["admin.knowledge.bases.older_model"]()}</span
											>
										{/if}
									</td>
									<td class="py-2 pr-3 text-right whitespace-nowrap">
										{row.document_count}
										{#if row.failed_count > 0}
											<span
												class="ml-1 rounded bg-red-100 px-1.5 py-0.5 text-xs text-red-900 dark:bg-red-900 dark:text-red-100"
												>{m["admin.knowledge.bases.failed"]({ count: row.failed_count })}</span
											>
										{/if}
									</td>
									<td class="py-2 pr-3 text-right">{row.chunk_count}</td>
									<td class="py-2 text-right">
										<button
											type="button"
											onclick={() => reindex(row)}
											disabled={reindexing !== null || !status.ready}
											class="rounded-full border border-gray-300 px-3 py-1 text-xs disabled:opacity-50 dark:border-gray-600"
										>
											{reindexing === row.id
												? m["admin.knowledge.bases.reindexing"]()
												: m["admin.knowledge.bases.reindex"]()}
										</button>
									</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{/if}
		</section>

		{#if status.history.length > 0}
			<section
				class="flex flex-col gap-3 rounded-lg border border-gray-200 p-5 dark:border-gray-700"
			>
				<div class="flex flex-col gap-1">
					<h2 class="font-medium">{m["admin.knowledge.history.title"]()}</h2>
					<p class="text-xs text-gray-500 dark:text-gray-400">
						{m["admin.knowledge.history.description"]()}
					</p>
				</div>
				<ul class="flex flex-col gap-2 text-sm">
					{#each status.history as entry (entry.id)}
						<li class="border-t border-gray-100 pt-2 dark:border-gray-800">
							<div class="text-xs text-gray-500">
								{formatDateTime(entry.created_at)} · {entry.changed_by ??
									m["admin.knowledge.erased"]()}
							</div>
							<div>
								{entry.embedding_model ?? m["admin.knowledge.history.no_embedding"]()} · {entry.extractor_model ??
									m["admin.knowledge.history.no_reader"]()}
							</div>
							{#if entry.reason}
								<div class="text-xs text-gray-500">{entry.reason}</div>
							{/if}
						</li>
					{/each}
				</ul>
			</section>
		{/if}
	{/if}
</div>
