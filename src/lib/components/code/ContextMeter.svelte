<!--
	The context/usage ring, in the composer's own pill row (M3).

	Shows a percentage when the backend has named a context max, otherwise a
	raw token count — never an invented maximum. Grey below 70%, amber from
	70%, red from 90%, matching the thresholds the popover's numbers back up.
	The popover carries the breakdown (input/output/cache), the last
	compaction, and a manual "Compact now" — the same `DropdownMenu` idiom the
	mode/model pills beside it already use.

	Hidden entirely when the backend lacks the `usage` capability (the
	caller's job to decide, via `supported`) or before any usage frame has
	arrived — a meter with nothing to show would just be a blank ring.

	Below the context/compaction content, the popup also carries the
	person's Pystino quotas (queued item,
	`reports/2026-09-24-thin-agent-progress.md`): every section of
	`GET /api/v2/usage`, rendered with the same `UsageBar` the Settings →
	Usage page uses, plus a link to that page. Cerea does not know which
	group this machine bills to (`x-bill-to` is chosen at enroll), so every
	section is shown and none is singled out. Fetched when the popup opens
	and again after each completed turn while it stays open — never on a
	timer — and derived through `contextMeterQuotas.ts` so the "no
	quotas"/"fetch failed"/"sections" split is unit-tested without mounting
	this component.
-->
<script lang="ts">
	import { DropdownMenu } from "bits-ui";
	import IconWarning from "~icons/carbon/warning-filled";
	import { base } from "$app/paths";
	import { CodeApiError, compactAgent } from "$lib/codeApi";
	import { useAPIClient, handleResponse } from "$lib/APIClient";
	import type { AgentCompactionUpdate, AgentUsageUpdate } from "$lib/types/CodeAgent";
	import type { UsageReport, UsageSection } from "$lib/types/UsageReport";
	import UsageBar from "$lib/components/settings/UsageBar.svelte";
	import { deriveQuotaDisplay } from "./contextMeterQuotas";
	import CarbonArrowUpRight from "~icons/carbon/arrow-up-right";

	interface Props {
		deviceId: string;
		agentId: string;
		/** The latest `usage` side-channel frame, or null before the first one
		 * arrives (a fresh session that has not run a turn yet). */
		usage: AgentUsageUpdate["usage"] | null;
		/** The latest `compaction` side-channel frame, or null if none has
		 * happened this session. */
		lastCompaction: AgentCompactionUpdate | null;
		/** Whether the backend advertised the `usage` capability in `hello` —
		 * the meter renders nothing at all when it did not. */
		supported: boolean;
		/** Whether a turn is live — the same value the composer's send button
		 * swap uses. A falling edge while the popup is open re-fetches quotas. */
		running?: boolean;
		/** The daemon's state changed (a compaction landed) — the same signal
		 * the mode/model pills use to ask the parent to re-read the snapshot. */
		onchanged?: () => void;
	}

	let {
		deviceId,
		agentId,
		usage,
		lastCompaction,
		supported,
		running = false,
		onchanged,
	}: Props = $props();

	const apiClient = useAPIClient();

	let quotaSections = $state<UsageSection[] | null>(null);
	let quotaError = $state<string | null>(null);
	let quotaPopupOpen = $state(false);
	let quotaDisplay = $derived(deriveQuotaDisplay(quotaSections, quotaError));

	async function loadQuotas() {
		quotaError = null;
		try {
			const report = (await apiClient.usage.get().then(handleResponse)) as UsageReport | null;
			quotaSections = report?.sections ?? [];
		} catch {
			quotaError = "Could not load quotas.";
		}
	}

	function onPopupOpenChange(open: boolean) {
		quotaPopupOpen = open;
		if (open) void loadQuotas();
	}

	// A completed turn while the popup is open — the falling edge of
	// `running`, the same signal the send button's stop-control swap uses.
	// `previousRunning` starts undefined (never a completed turn yet) rather
	// than snapshotting `running` outside the effect, which Svelte can't tell
	// apart from a stale read.
	let previousRunning: boolean | undefined;
	$effect(() => {
		const wasRunning = previousRunning;
		previousRunning = running;
		if (wasRunning && !running && quotaPopupOpen) {
			void loadQuotas();
		}
	});

	let compacting = $state(false);
	let compactFailure = $state<string | null>(null);
	/** Whether this deployment's `compact` capability is known unavailable —
	 * learned the first time a "Compact now" click 404s, not guessed up
	 * front: `supported` only tells us about `usage`, a separate capability. */
	let compactUnsupported = $state(false);

	let percent = $derived.by(() => {
		if (!usage?.max) return null;
		const used = usage.used ?? 0;
		return Math.max(0, Math.min(100, Math.round((used / usage.max) * 100)));
	});

	type Tone = "grey" | "amber" | "red";
	let tone = $derived.by((): Tone => {
		if (percent === null) return "grey";
		if (percent >= 90) return "red";
		if (percent >= 70) return "amber";
		return "grey";
	});

	const RING_CLASS: Record<Tone, string> = {
		grey: "text-gray-400 dark:text-gray-500",
		amber: "text-amber-500 dark:text-amber-400",
		red: "text-red-500 dark:text-red-400",
	};

	const RADIUS = 7;
	const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
	let dashoffset = $derived(CIRCUMFERENCE * (1 - (percent ?? 0) / 100));

	function formatTokenCount(n: number | undefined): string {
		const value = n ?? 0;
		if (value >= 1000) return `${Math.round(value / 100) / 10}k`;
		return String(value);
	}

	let label = $derived(percent !== null ? `${percent}%` : formatTokenCount(usage?.used));

	let compactionNote = $derived.by(() => {
		if (!lastCompaction) return null;
		if (lastCompaction.auto === false) return "Compacted manually";
		if (lastCompaction.auto === true) return "Compacted automatically";
		return "Compacted";
	});

	async function compactNow() {
		if (compacting) return;
		compacting = true;
		compactFailure = null;
		try {
			await compactAgent(deviceId, agentId);
			onchanged?.();
		} catch (err) {
			if (err instanceof CodeApiError && err.status === 404) {
				compactUnsupported = true;
			} else {
				compactFailure = err instanceof Error ? err.message : "The daemon refused to compact.";
			}
		} finally {
			compacting = false;
		}
	}

	const menuContentClass =
		"z-50 rounded-xl border border-gray-200 bg-white/95 p-1 text-gray-800 shadow-lg backdrop-blur-sm dark:border-gray-700/60 dark:bg-gray-800/95 dark:text-gray-100";
</script>

{#if supported && usage}
	<DropdownMenu.Root onOpenChange={onPopupOpenChange}>
		<DropdownMenu.Trigger
			class="ml-auto flex h-7 flex-none items-center gap-1.5 rounded-full border border-gray-200 bg-white px-2 text-xs font-medium text-gray-600 transition-colors hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700"
			title="Context usage"
		>
			<svg viewBox="0 0 18 18" class="size-3.5 {RING_CLASS[tone]}">
				<circle
					cx="9"
					cy="9"
					r={RADIUS}
					fill="none"
					stroke="currentColor"
					stroke-opacity="0.25"
					stroke-width="2.5"
				/>
				{#if percent !== null}
					<circle
						cx="9"
						cy="9"
						r={RADIUS}
						fill="none"
						stroke="currentColor"
						stroke-width="2.5"
						stroke-linecap="round"
						stroke-dasharray={CIRCUMFERENCE}
						stroke-dashoffset={dashoffset}
						transform="rotate(-90 9 9)"
					/>
				{/if}
			</svg>
			{label}
		</DropdownMenu.Trigger>
		<DropdownMenu.Portal>
			<DropdownMenu.Content
				class="{menuContentClass} w-64"
				side="top"
				align="end"
				sideOffset={8}
				trapFocus={false}
				onCloseAutoFocus={(e) => e.preventDefault()}
				interactOutsideBehavior="defer-otherwise-close"
			>
				<div class="space-y-2 px-3 py-2.5 text-xs">
					<div
						class="flex items-center justify-between font-medium text-gray-800 dark:text-gray-100"
					>
						<span>Context</span>
						<span>{usage.used ?? 0}{usage.max ? ` / ${usage.max}` : ""} tokens</span>
					</div>
					<dl class="grid grid-cols-2 gap-x-3 gap-y-1 text-gray-500 dark:text-gray-400">
						<dt>Input</dt>
						<dd class="text-right">{usage.input ?? 0}</dd>
						<dt>Output</dt>
						<dd class="text-right">{usage.output ?? 0}</dd>
						<dt>Cache read</dt>
						<dd class="text-right">{usage.cacheRead ?? 0}</dd>
						<dt>Reasoning</dt>
						<dd class="text-right">{usage.reasoning ?? 0}</dd>
					</dl>
					{#if compactionNote}
						<div class="text-gray-500 dark:text-gray-400">{compactionNote}</div>
					{/if}
					{#if compactFailure}
						<div class="flex items-center gap-1 text-amber-600 dark:text-amber-400">
							<IconWarning class="size-3 shrink-0" />
							<span class="min-w-0 truncate" title={compactFailure}>{compactFailure}</span>
						</div>
					{/if}
					{#if !compactUnsupported}
						<button
							type="button"
							class="w-full rounded-md border border-gray-200 px-2 py-1 text-center font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:opacity-60 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
							disabled={compacting}
							onclick={() => void compactNow()}
						>
							{compacting ? "Compacting…" : "Compact now"}
						</button>
					{/if}

					{#if quotaDisplay.kind !== "hidden"}
						<div class="mt-1 border-t border-gray-200 pt-2 dark:border-gray-700">
							<div class="mb-1 font-medium text-gray-800 dark:text-gray-100">Quotas</div>
							{#if quotaDisplay.kind === "error"}
								<div class="flex items-center gap-1 text-amber-600 dark:text-amber-400">
									<IconWarning class="size-3 shrink-0" />
									<span>{quotaDisplay.message}</span>
								</div>
							{:else}
								<div class="-mx-3 divide-y divide-gray-200 px-3 dark:divide-gray-700">
									{#each quotaDisplay.sections as section (section.title)}
										<div class="py-1.5">
											<div class="text-[11px] font-medium text-gray-600 dark:text-gray-300">
												{section.title}
											</div>
											{#if section.error}
												<p class="text-[11px] text-amber-600 dark:text-amber-400">
													{section.error}
												</p>
											{:else}
												{#each section.entries as entry (entry.label)}
													<UsageBar {entry} />
												{/each}
											{/if}
										</div>
									{/each}
								</div>
								<a
									href="{base}/settings/usage"
									class="flex items-center gap-1 text-[12px] text-blue-600 hover:underline dark:text-blue-400"
								>
									Settings → Usage
									<CarbonArrowUpRight class="text-xs" />
								</a>
							{/if}
						</div>
					{/if}
				</div>
			</DropdownMenu.Content>
		</DropdownMenu.Portal>
	</DropdownMenu.Root>
{/if}
