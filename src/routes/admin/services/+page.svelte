<!--
	What this deployment runs, and whether it is working.

	One row per service, a health and one short line. The server sends codes, not
	sentences (`$lib/server/services/types.ts`), so every word here is the
	catalogue's and nothing a probe saw can reach the screen. "Check for
	updates" is the only thing on the page that reaches outside, and only when
	pressed.
-->
<script lang="ts">
	import { onMount } from "svelte";
	import { base } from "$app/paths";
	import { m } from "$lib/paraglide/messages";
	import type { Health, NoteCode, ServiceId, ServicesReport } from "$lib/server/services/types";
	import type { ProductUpdate, UpdateReport } from "$lib/server/services/updates";

	let report = $state<ServicesReport | null>(null);
	let loading = $state(true);
	let failure = $state(false);
	let updates = $state<UpdateReport | null>(null);
	let checking = $state(false);
	let updateFailure = $state(false);

	const names: Record<ServiceId, () => string> = {
		gateway: () => m["admin.services.name.gateway"](),
		extractor: () => m["admin.services.name.extractor"](),
		embedding: () => m["admin.services.name.embedding"](),
		redaction: () => m["admin.services.name.redaction"](),
		documents: () => m["admin.services.name.documents"](),
		office: () => m["admin.services.name.office"](),
		fetch: () => m["admin.services.name.fetch"](),
		search: () => m["admin.services.name.search"](),
		image: () => m["admin.services.name.image"](),
		transcription: () => m["admin.services.name.transcription"](),
		mcp: () => m["admin.services.name.mcp"](),
		blobs: () => m["admin.services.name.blobs"](),
		galopin: () => m["admin.services.name.galopin"](),
		schedules: () => m["admin.services.name.schedules"](),
		mail: () => m["admin.services.name.mail"](),
		browser: () => m["admin.services.name.browser"](),
		local: () => m["admin.services.name.local"](),
		sandbox: () => m["admin.services.name.sandbox"](),
	};

	const notes: Record<NoteCode, (value: string) => string> = {
		not_configured: (v) => m["admin.services.note.not_configured"]({ value: v }),
		probe_failed: (v) => m["admin.services.note.probe_failed"]({ value: v }),
		timed_out: (v) => m["admin.services.note.timed_out"]({ value: v }),
		catalogue_down: (v) => m["admin.services.note.catalogue_down"]({ value: v }),
		gateway_ok: (v) => m["admin.services.note.gateway_ok"]({ value: v }),
		gateway_degraded: (v) => m["admin.services.note.gateway_degraded"]({ value: v }),
		gateway_not_ready: (v) => m["admin.services.note.gateway_not_ready"]({ value: v }),
		gateway_down: (v) => m["admin.services.note.gateway_down"]({ value: v }),
		extractor_ok: (v) => m["admin.services.note.extractor_ok"]({ value: v }),
		extractor_direct: (v) => m["admin.services.note.extractor_direct"]({ value: v }),
		extractor_missing: (v) => m["admin.services.note.extractor_missing"]({ value: v }),
		extractor_none: (v) => m["admin.services.note.extractor_none"]({ value: v }),
		embedding_ok: (v) => m["admin.services.note.embedding_ok"]({ value: v }),
		embedding_missing: (v) => m["admin.services.note.embedding_missing"]({ value: v }),
		embedding_unset: (v) => m["admin.services.note.embedding_unset"]({ value: v }),
		knowledge_off: (v) => m["admin.services.note.knowledge_off"]({ value: v }),
		redaction_pattern: (v) => m["admin.services.note.redaction_pattern"]({ value: v }),
		redaction_ner: (v) => m["admin.services.note.redaction_ner"]({ value: v }),
		redaction_degraded: (v) => m["admin.services.note.redaction_degraded"]({ value: v }),
		redaction_down: (v) => m["admin.services.note.redaction_down"]({ value: v }),
		documents_ok: (v) => m["admin.services.note.documents_ok"]({ value: v }),
		documents_down: (v) => m["admin.services.note.documents_down"]({ value: v }),
		office_ok: (v) => m["admin.services.note.office_ok"]({ value: v }),
		office_degraded: (v) => m["admin.services.note.office_degraded"]({ value: v }),
		office_down: (v) => m["admin.services.note.office_down"]({ value: v }),
		fetch_direct: (v) => m["admin.services.note.fetch_direct"]({ value: v }),
		fetch_browser: (v) => m["admin.services.note.fetch_browser"]({ value: v }),
		fetch_standby: (v) => m["admin.services.note.fetch_standby"]({ value: v }),
		fetch_down: (v) => m["admin.services.note.fetch_down"]({ value: v }),
		search_ok: (v) => m["admin.services.note.search_ok"]({ value: v }),
		search_policy: (v) => m["admin.services.note.search_policy"]({ value: v }),
		search_stale: (v) => m["admin.services.note.search_stale"]({ value: v }),
		search_none: (v) => m["admin.services.note.search_none"]({ value: v }),
		image_ok: (v) => m["admin.services.note.image_ok"]({ value: v }),
		image_none: (v) => m["admin.services.note.image_none"]({ value: v }),
		transcription_ok: (v) => m["admin.services.note.transcription_ok"]({ value: v }),
		transcription_none: (v) => m["admin.services.note.transcription_none"]({ value: v }),
		mcp_ok: (v) => m["admin.services.note.mcp_ok"]({ value: v }),
		mcp_some_failed: (v) => m["admin.services.note.mcp_some_failed"]({ value: v }),
		mcp_all_failed: (v) => m["admin.services.note.mcp_all_failed"]({ value: v }),
		mcp_none: (v) => m["admin.services.note.mcp_none"]({ value: v }),
		mcp_unchecked: (v) => m["admin.services.note.mcp_unchecked"]({ value: v }),
		blobs_gridfs: (v) => m["admin.services.note.blobs_gridfs"]({ value: v }),
		blobs_s3: (v) => m["admin.services.note.blobs_s3"]({ value: v }),
		blobs_down: (v) => m["admin.services.note.blobs_down"]({ value: v }),
		galopin_ok: (v) => m["admin.services.note.galopin_ok"]({ value: v }),
		galopin_partial: (v) => m["admin.services.note.galopin_partial"]({ value: v }),
		galopin_missing: (v) => m["admin.services.note.galopin_missing"]({ value: v }),
		schedules_ok: (v) => m["admin.services.note.schedules_ok"]({ value: v }),
		schedules_stalled: (v) => m["admin.services.note.schedules_stalled"]({ value: v }),
		schedules_off: (v) => m["admin.services.note.schedules_off"]({ value: v }),
		mail_reachable: (v) => m["admin.services.note.mail_reachable"]({ value: v }),
		mail_down: (v) => m["admin.services.note.mail_down"]({ value: v }),
		mail_elsewhere: (v) => m["admin.services.note.mail_elsewhere"]({ value: v }),
		browser_ok: (v) => m["admin.services.note.browser_ok"]({ value: v }),
		browser_model: (v) => m["admin.services.note.browser_model"]({ value: v }),
		browser_needs_connectors: (v) =>
			m["admin.services.note.browser_needs_connectors"]({ value: v }),
		browser_needs_key: (v) => m["admin.services.note.browser_needs_key"]({ value: v }),
		local_ok: (v) => m["admin.services.note.local_ok"]({ value: v }),
		local_none: (v) => m["admin.services.note.local_none"]({ value: v }),
		sandbox_ok: (v) => m["admin.services.note.sandbox_ok"]({ value: v }),
		sandbox_degraded: (v) => m["admin.services.note.sandbox_degraded"]({ value: v }),
		sandbox_down: (v) => m["admin.services.note.sandbox_down"]({ value: v }),
	};

	const healthLabel: Record<Health, () => string> = {
		ok: () => m["admin.services.health.ok"](),
		degraded: () => m["admin.services.health.degraded"](),
		down: () => m["admin.services.health.down"](),
		off: () => m["admin.services.health.off"](),
		unknown: () => m["admin.services.health.unknown"](),
	};

	// Colour and a word, never colour alone.
	const dot: Record<Health, string> = {
		ok: "bg-green-500",
		degraded: "bg-amber-500",
		down: "bg-red-500",
		off: "bg-gray-400",
		unknown: "bg-gray-400 ring-2 ring-gray-300 dark:ring-gray-600",
	};

	async function load(refresh: boolean) {
		loading = true;
		failure = false;
		try {
			const response = await fetch(`${base}/api/v2/admin/services${refresh ? "?refresh=1" : ""}`);
			if (!response.ok) throw new Error(String(response.status));
			report = (await response.json()) as ServicesReport;
		} catch {
			failure = true;
		} finally {
			loading = false;
		}
	}

	async function checkUpdates() {
		checking = true;
		updateFailure = false;
		try {
			const response = await fetch(`${base}/api/v2/admin/services/updates`, { method: "POST" });
			if (!response.ok) throw new Error(String(response.status));
			updates = (await response.json()) as UpdateReport;
		} catch {
			updateFailure = true;
		} finally {
			checking = false;
		}
	}

	function checkedAt(iso: string): string {
		return new Date(iso).toLocaleTimeString();
	}

	function updateLine(product: string, update: ProductUpdate): string {
		const latest = update.latest ?? "";
		const running = update.running ?? "";
		switch (update.state) {
			case "current":
				return m["admin.services.updates.current"]({ product, running });
			case "available":
				return m["admin.services.updates.available"]({ product, latest, running });
			case "offline":
				return m["admin.services.updates.offline"]({ product });
			case "rate_limited":
				return m["admin.services.updates.rate_limited"]({ product });
			default:
				return latest
					? m["admin.services.updates.running_unknown"]({ product, latest })
					: m["admin.services.updates.unknown"]({ product });
		}
	}

	onMount(() => {
		void load(false);
	});
</script>

<div class="flex flex-col gap-6">
	<section
		class="flex flex-col gap-4 rounded-lg border border-gray-200 p-4 sm:p-5 dark:border-gray-700"
	>
		<div class="flex flex-wrap items-start justify-between gap-3">
			<div class="flex min-w-0 flex-col gap-1">
				<h2 class="font-medium">{m["admin.services.title"]()}</h2>
				<p class="text-xs text-gray-500 dark:text-gray-400">{m["admin.services.intro"]()}</p>
			</div>
			<div class="flex items-center gap-3">
				{#if report}
					<span class="text-xs text-gray-500 dark:text-gray-400" data-testid="services-checked">
						{m["admin.services.checked_at"]({ time: checkedAt(report.checkedAt) })}
					</span>
				{/if}
				<button
					type="button"
					class="btn rounded-lg border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:hover:bg-gray-800"
					disabled={loading}
					onclick={() => load(true)}
				>
					{loading ? m["admin.services.refreshing"]() : m["admin.services.refresh"]()}
				</button>
			</div>
		</div>

		{#if failure}
			<p
				role="alert"
				class="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-200"
			>
				{m["admin.services.load_failed"]()}
			</p>
		{/if}

		{#if report}
			<ul
				aria-label={m["admin.services.list_label"]()}
				class="flex flex-col divide-y divide-gray-100 dark:divide-gray-800"
			>
				{#each report.rows as row (row.id)}
					<li
						class="flex flex-col gap-1 py-2.5 sm:flex-row sm:items-baseline sm:gap-4"
						data-testid="service-{row.id}"
						data-health={row.health}
					>
						<div class="flex items-center gap-2 sm:w-64 sm:shrink-0">
							<span class="size-2.5 shrink-0 rounded-full {dot[row.health]}" aria-hidden="true"
							></span>
							<span class="text-sm font-medium">{names[row.id]()}</span>
							<span class="text-xs text-gray-500 dark:text-gray-400"
								>{healthLabel[row.health]()}</span
							>
						</div>
						<p class="min-w-0 text-sm break-words text-gray-600 dark:text-gray-300">
							{notes[row.note](row.param ?? "")}
						</p>
					</li>
				{/each}
			</ul>
		{:else if loading}
			<p class="text-sm text-gray-500">{m["admin.common.loading"]()}</p>
		{/if}
	</section>

	<section
		class="flex flex-col gap-3 rounded-lg border border-gray-200 p-4 sm:p-5 dark:border-gray-700"
	>
		<div class="flex flex-wrap items-start justify-between gap-3">
			<div class="flex min-w-0 flex-col gap-1">
				<h2 class="font-medium">{m["admin.services.updates.title"]()}</h2>
				<p class="text-xs text-gray-500 dark:text-gray-400">
					{m["admin.services.updates.intro"]()}
				</p>
			</div>
			<button
				type="button"
				class="btn rounded-lg border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:hover:bg-gray-800"
				disabled={checking}
				onclick={checkUpdates}
			>
				{checking ? m["admin.services.updates.checking"]() : m["admin.services.updates.check"]()}
			</button>
		</div>

		{#if updateFailure}
			<p role="alert" class="text-sm text-red-700 dark:text-red-400">
				{m["admin.services.updates.failed"]()}
			</p>
		{/if}

		{#if updates}
			<ul class="flex flex-col gap-1.5 text-sm" data-testid="update-results">
				{#each [{ id: "cerea", product: m["admin.services.updates.product.cerea"](), update: updates.cerea }, { id: "pystino", product: m["admin.services.updates.product.pystino"](), update: updates.pystino }] as entry (entry.id)}
					<li data-testid="update-{entry.id}" data-state={entry.update.state}>
						{updateLine(entry.product, entry.update)}
						{#if entry.update.state === "available" && entry.update.url}
							<a
								href={entry.update.url}
								target="_blank"
								rel="noopener noreferrer"
								class="ml-1 text-blue-700 underline dark:text-blue-400"
							>
								{m["admin.services.updates.release"]()}
							</a>
						{/if}
					</li>
				{/each}
			</ul>
		{/if}
	</section>
</div>
