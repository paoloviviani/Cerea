<!--
	Administration -> Agents -> Auto-approval (ADR 0109): the one switch. Each user chooses their own
	decision model, threshold, instructions and rows in Workspace -> Agents; the administrator only
	decides whether Auto may use a reviewer on this deployment at all.
-->
<script lang="ts">
	import { onMount } from "svelte";
	import { base } from "$app/paths";
	import { m } from "$lib/paraglide/messages";

	let loading = $state(true);
	let loadFailure = $state<string | null>(null);
	let killSwitchOn = $state(false);
	let enabled = $state(false);
	let saved = $state(false);

	let busy = $state(false);
	let failure = $state<string | null>(null);
	let note = $state<string | null>(null);

	const dirty = $derived(enabled !== saved);

	async function problem(response: Response): Promise<string> {
		const parsed = (await response.json().catch(() => null)) as { message?: string } | null;
		return parsed?.message ?? m["admin.common.error_status"]({ status: response.status });
	}

	function apply(data: { enabled: boolean; killSwitchOn: boolean }) {
		enabled = data.enabled;
		saved = data.enabled;
		killSwitchOn = data.killSwitchOn;
	}

	async function load() {
		try {
			const response = await fetch(`${base}/api/v2/admin/agent-review`);
			if (!response.ok) throw new Error(await problem(response));
			apply(await response.json());
		} catch (err) {
			loadFailure = err instanceof Error ? err.message : m["admin.common.read_failed"]();
		} finally {
			loading = false;
		}
	}
	onMount(load);

	async function save() {
		busy = true;
		failure = null;
		note = null;
		try {
			const response = await fetch(`${base}/api/v2/admin/agent-review`, {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ enabled }),
			});
			if (!response.ok) throw new Error(await problem(response));
			apply(await response.json());
			note = m["admin.auto.saved"]();
		} catch (err) {
			failure = err instanceof Error ? err.message : m["admin.common.save_failed"]();
		} finally {
			busy = false;
		}
	}

	const BTN =
		"btn rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-600 disabled:opacity-50";
</script>

<div class="flex flex-col gap-8" data-testid="agent-review">
	<section id="auto-approval" aria-labelledby="auto-title" class="flex flex-col gap-4">
		<div>
			<h2 id="auto-title" class="text-lg font-semibold">{m["admin.auto.title"]()}</h2>
			<p class="mt-1 text-sm text-gray-600 dark:text-gray-400">{m["admin.auto.intro"]()}</p>
			<a
				href="{base}/admin/agents/review-log"
				class="mt-1 inline-block text-sm underline"
				data-testid="auto-log-link">{m["admin.auto.log.link"]()}</a
			>
		</div>

		{#if loading}
			<p class="text-sm text-gray-500">{m["admin.common.loading"]()}</p>
		{:else if loadFailure}
			<p class="text-sm text-red-600" role="alert">{loadFailure}</p>
		{:else}
			{#if killSwitchOn}
				<p
					class="rounded-md border border-gray-300 bg-gray-50 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-800"
					data-testid="auto-killswitch"
				>
					{m["admin.auto.killswitch"]()}
				</p>
			{/if}

			<label class="flex items-start gap-2 text-sm">
				<input type="checkbox" bind:checked={enabled} class="mt-0.5" data-testid="auto-enabled" />
				<span>
					<span class="font-medium">{m["admin.auto.enabled"]()}</span>
					<span class="block text-gray-600 dark:text-gray-400"
						>{m["admin.auto.enabled_detail"]()}</span
					>
				</span>
			</label>

			<div class="flex flex-col gap-2">
				<div>
					<button
						type="button"
						class={BTN}
						onclick={save}
						disabled={busy || !dirty}
						data-testid="auto-save"
					>
						{busy ? m["admin.common.saving"]() : m["admin.common.save"]()}
					</button>
				</div>
				{#if failure}<p class="text-sm text-red-600" role="alert">{failure}</p>{/if}
				{#if note}<p class="text-sm text-green-700 dark:text-green-400" role="status">
						{note}
					</p>{/if}
			</div>
		{/if}
	</section>
</div>
