<!-- The reviewer's log (ADR 0107): what it allowed or sent back, newest first, filterable, paged. -->
<script lang="ts">
	import { onMount } from "svelte";
	import { base } from "$app/paths";
	import { m } from "$lib/paraglide/messages";
	import { PERMISSION_CLASSES } from "$lib/types/machineProtocol";
	import type { ReviewOutcome } from "$lib/types/AgentReview";
	import { className } from "$lib/utils/autoApproval";

	interface Entry {
		time: string;
		machine: string;
		deviceId: string;
		sessionId: string;
		class: (typeof PERMISSION_CLASSES)[number];
		summary: string;
		probability: number | null;
		outcome: ReviewOutcome;
		reason: string;
		applied: boolean;
		modelId: string;
	}

	let entries = $state<Entry[]>([]);
	let next = $state<string | null>(null);
	let machine = $state("");
	let outcome = $state("");
	let cls = $state("");
	let loading = $state(true);
	let failure = $state<string | null>(null);

	async function fetchPage(
		before: string | null
	): Promise<{ entries: Entry[]; next: string | null }> {
		const q = new URLSearchParams();
		if (machine) q.set("machine", machine);
		if (outcome) q.set("outcome", outcome);
		if (cls) q.set("class", cls);
		if (before) q.set("before", before);
		const response = await fetch(`${base}/api/v2/admin/agent-review/log?${q}`);
		if (!response.ok) throw new Error(m["admin.common.error_status"]({ status: response.status }));
		return response.json();
	}

	async function reload() {
		loading = true;
		failure = null;
		try {
			const page = await fetchPage(null);
			entries = page.entries;
			next = page.next;
		} catch (err) {
			failure = err instanceof Error ? err.message : m["admin.common.read_failed"]();
		} finally {
			loading = false;
		}
	}

	async function more() {
		if (!next) return;
		try {
			const page = await fetchPage(next);
			entries = [...entries, ...page.entries];
			next = page.next;
		} catch (err) {
			failure = err instanceof Error ? err.message : m["admin.common.read_failed"]();
		}
	}
	onMount(reload);

	/** The machines seen in what is loaded, so the filter offers real ones. */
	const machines = $derived(
		[...new Map(entries.map((e) => [e.deviceId, e.machine])).entries()].map(([id, name]) => ({
			id,
			name,
		}))
	);
	let known = $state<{ id: string; name: string }[]>([]);
	$effect(() => {
		for (const x of machines) if (!known.some((k) => k.id === x.id)) known = [...known, x];
	});

	const SELECT =
		"rounded-md border border-gray-300 bg-white px-2 py-1 text-sm dark:border-gray-600 dark:bg-gray-800";
	const OUTCOMES: ReviewOutcome[] = ["allowed", "escalated", "error"];
	const outcomeLabel = (o: ReviewOutcome) =>
		({
			allowed: m["admin.auto.log.outcome.allowed"],
			escalated: m["admin.auto.log.outcome.escalated"],
			error: m["admin.auto.log.outcome.error"],
		})[o]();
</script>

<section aria-labelledby="auto-log-title" class="flex flex-col gap-3" data-testid="auto-log">
	<div>
		<h2 id="auto-log-title" class="text-lg font-semibold">{m["admin.auto.log.title"]()}</h2>
		<p class="mt-1 text-sm text-gray-600 dark:text-gray-400">{m["admin.auto.log.intro"]()}</p>
	</div>
	<div class="flex flex-wrap gap-2">
		<select
			bind:value={machine}
			onchange={reload}
			class={SELECT}
			aria-label={m["admin.auto.log.machine"]()}
		>
			<option value="">{m["admin.auto.log.all_machines"]()}</option>
			{#each known as k (k.id)}<option value={k.id}>{k.name}</option>{/each}
		</select>
		<select
			bind:value={outcome}
			onchange={reload}
			class={SELECT}
			aria-label={m["admin.auto.log.outcome"]()}
		>
			<option value="">{m["admin.auto.log.all_outcomes"]()}</option>
			{#each OUTCOMES as o (o)}<option value={o}>{outcomeLabel(o)}</option>{/each}
		</select>
		<select
			bind:value={cls}
			onchange={reload}
			class={SELECT}
			aria-label={m["admin.auto.log.class"]()}
		>
			<option value="">{m["admin.auto.log.all_classes"]()}</option>
			{#each PERMISSION_CLASSES as c (c)}<option value={c}>{className(c)}</option>{/each}
		</select>
	</div>
	{#if failure}<p class="text-sm text-red-600" role="alert">{failure}</p>{/if}
	{#if loading}
		<p class="text-sm text-gray-500">{m["admin.common.loading"]()}</p>
	{:else if entries.length === 0}
		<p class="text-sm text-gray-600 dark:text-gray-400" data-testid="auto-log-empty">
			{m["admin.auto.log.empty"]()}
		</p>
	{:else}
		<div class="overflow-x-auto">
			<table class="w-full min-w-[40rem] text-left text-sm">
				<thead class="text-xs text-gray-500">
					<tr>
						<th class="py-1 pr-3 font-medium">{m["admin.auto.log.col.time"]()}</th>
						<th class="py-1 pr-3 font-medium">{m["admin.auto.log.col.machine"]()}</th>
						<th class="py-1 pr-3 font-medium">{m["admin.auto.log.col.class"]()}</th>
						<th class="py-1 pr-3 font-medium">{m["admin.auto.log.col.what"]()}</th>
						<th class="py-1 pr-3 font-medium">{m["admin.auto.log.col.probability"]()}</th>
						<th class="py-1 pr-3 font-medium">{m["admin.auto.log.col.outcome"]()}</th>
						<th class="py-1 font-medium">{m["admin.auto.log.col.applied"]()}</th>
					</tr>
				</thead>
				<tbody>
					{#each entries as e (e.time + e.sessionId + e.summary)}
						<tr
							class="border-t border-gray-200 align-top dark:border-gray-700"
							data-testid="auto-log-row"
						>
							<td class="py-1.5 pr-3 whitespace-nowrap">{new Date(e.time).toLocaleString()}</td>
							<td class="py-1.5 pr-3">{e.machine}</td>
							<td class="py-1.5 pr-3">{className(e.class)}</td>
							<td class="py-1.5 pr-3 font-mono text-xs break-all" title={e.reason}>{e.summary}</td>
							<td class="py-1.5 pr-3"
								>{e.probability === null ? "—" : `${Math.round(e.probability * 100)}%`}</td
							>
							<td class="py-1.5 pr-3">{outcomeLabel(e.outcome)}</td>
							<td class="py-1.5"
								>{e.applied ? m["admin.auto.log.yes"]() : m["admin.auto.log.no"]()}</td
							>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
		{#if next}
			<button
				type="button"
				onclick={more}
				class="self-start rounded-md border border-gray-300 px-3 py-1.5 text-sm dark:border-gray-600"
				data-testid="auto-log-more">{m["admin.auto.log.more"]()}</button
			>
		{/if}
	{/if}
</section>
