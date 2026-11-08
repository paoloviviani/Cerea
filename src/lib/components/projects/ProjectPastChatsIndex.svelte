<!--
	The state of a project's past-chats index, in the settings "Past chats"
	section: indexed, indexing, failed (with the friendly reason) or not
	indexed, and, for the owner, Reindex and (after a failure) Retry. Both act
	on the same knowledge base the Knowledge screen's Reindex does.

	Loads in `onMount`, like the other project sections, for the SSR reason.
-->
<script lang="ts">
	import { onMount } from "svelte";
	import { base } from "$app/paths";
	import { m } from "$lib/paraglide/messages";
	import * as s from "$lib/components/overlay/styles";
	import EmbeddingModelPicker from "$lib/components/knowledge/EmbeddingModelPicker.svelte";
	import type { PastChatsIndex } from "$lib/types/Project";

	interface Props {
		projectId: string;
		/** The project has been shared: members may lack the index's model. */
		shared?: boolean;
	}

	let { projectId, shared = false }: Props = $props();

	let index = $state<(PastChatsIndex & { canManage: boolean }) | null>(null);
	let working = $state(false);
	let failure = $state<string | null>(null);

	const root = $derived(`${base}/api/v2/projects/${projectId}/past-chats`);

	async function call(path: string, method: string, body?: unknown) {
		failure = null;
		const response = await fetch(`${root}${path}`, {
			method,
			...(body === undefined
				? {}
				: { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
		});
		if (!response.ok) {
			const parsed = (await response.json().catch(() => null)) as { message?: string } | null;
			throw new Error(parsed?.message ?? m["projects.past_index.failed_status"]());
		}
		index = (await response.json()).data;
	}

	onMount(async () => {
		try {
			await call("", "GET");
		} catch (err) {
			failure = err instanceof Error ? err.message : m["projects.past_index.load_failed"]();
		}
	});

	async function run(path: string, body?: unknown) {
		if (working) return;
		working = true;
		try {
			await call(path, "POST", body);
		} catch (err) {
			failure = err instanceof Error ? err.message : m["projects.past_index.failed_status"]();
		} finally {
			working = false;
		}
	}

	// A reindex runs behind the request: follow it until nothing is indexing.
	$effect(() => {
		if (index?.state !== "indexing" || working) return;
		const timer = setInterval(() => {
			void call("", "GET").catch(() => undefined);
		}, 3000);
		return () => clearInterval(timer);
	});

	const label = $derived.by(() => {
		if (working) return m["projects.past_index.indexing"]();
		switch (index?.state) {
			case "indexed":
				return m["projects.past_index.indexed"]({ count: index.indexed });
			case "indexing":
				return m["projects.past_index.indexing"]();
			case "failed":
				return m["projects.past_index.failed"]({ count: index.failed });
			default:
				return m["projects.past_index.none"]();
		}
	});
</script>

{#if index || failure}
	<div class="space-y-2" data-testid="past-chats-index">
		{#if index}
			<div class="flex flex-wrap items-center gap-2 text-sm">
				<span class="font-medium text-ink">{m["projects.past_index.title"]()}</span>
				<span
					data-testid="past-chats-state"
					class="{s.PILL} {index.state === 'failed'
						? s.PILL_TONES.bad
						: index.state === 'indexed'
							? s.PILL_TONES.neutral
							: s.PILL_TONES.busy}">{label}</span
				>
				{#if index.canManage}
					{#if index.state === "failed"}
						<button
							type="button"
							class={s.SECONDARY}
							disabled={working}
							onclick={() => run("/retry")}
						>
							{m["projects.past_index.retry"]()}
						</button>
					{/if}
					<button
						type="button"
						class={s.SECONDARY}
						disabled={working || index.state === "none"}
						onclick={() => run("")}
					>
						{m["projects.past_index.reindex"]()}
					</button>
				{/if}
			</div>
			{#if index.embeddingModel}
				<EmbeddingModelPicker
					id="past-chats-embedder"
					models={index.models}
					defaultModel={index.defaultModel}
					value={index.embeddingChosen ? index.embeddingModel : ""}
					current={index.embeddingModel}
					readonly={!index.canManage}
					disabled={working}
					confirmCount={index.indexed + index.indexing + index.failed}
					onconfirm={(choice) => run("", { embedding_model: choice })}
				/>
			{/if}
			{#if shared && index.embeddingChosen}
				<p class={s.HINT}>{m["projects.past_index.shared_model_note"]()}</p>
			{/if}
			{#if index.state === "failed" && index.error}
				<p class={s.HINT}>{index.error}</p>
			{/if}
		{/if}
		{#if failure}
			<p class={s.ERROR} role="alert">{failure}</p>
		{/if}
	</div>
{/if}
