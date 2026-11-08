<!--
	The info dot under an assistant answer, and the overlay it opens: which
	model answered, what it cost in tokens and time, and what the gateway's
	redaction hid. A popover on desktop, a sheet on a phone. The dot is grey,
	yellow when values were hidden, red when the request was refused; the state
	is always named in words too (aria-label, title, and a word in the overlay).
	Everything comes from `message.stats`; a gap shows as "—".
-->
<script lang="ts">
	import { m } from "$lib/paraglide/messages";
	import CarbonInformation from "~icons/carbon/information";
	import CarbonInformationFilled from "~icons/carbon/information-filled";
	import CarbonClose from "~icons/carbon/close";
	import { page } from "$app/state";
	import type { Message } from "$lib/types/Message";
	import { REDACTIONS_CONSOLE_PATH } from "$lib/utils/redactionConsole";
	import {
		dotLabel,
		dotState,
		dotStateWord,
		formatCount,
		formatDuration,
		formatSpeed,
		modeLabel,
		redactionSummary,
		sourceLabel,
		typeName,
	} from "$lib/utils/turnDetails";

	interface Props {
		message: Pick<Message, "stats" | "createdAt" | "id">;
	}
	let { message }: Props = $props();

	let open = $state(false);
	let root: HTMLDivElement | undefined = $state();

	const stats = $derived(message.stats);
	const dot = $derived(dotState(stats));
	const redaction = $derived(stats?.redaction);
	const hasConsole = $derived((page.data as { consoleEnabled?: boolean }).consoleEnabled === true);
	const when = $derived.by(() => {
		const at = stats?.at ?? (message.createdAt ? new Date(message.createdAt).getTime() : undefined);
		return at === undefined ? "—" : new Date(at).toLocaleString();
	});
	const blank = (v: string | undefined) => (v && v !== "" ? v : "—");

	$effect(() => {
		if (!open) return;
		const onPointer = (event: PointerEvent) => {
			if (root && !root.contains(event.target as Node)) open = false;
		};
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") open = false;
		};
		document.addEventListener("pointerdown", onPointer);
		document.addEventListener("keydown", onKey);
		return () => {
			document.removeEventListener("pointerdown", onPointer);
			document.removeEventListener("keydown", onKey);
		};
	});
</script>

<div bind:this={root} class="relative">
	<button
		type="button"
		class="btn rounded-xs p-1 text-xs text-ink-faint hover:text-ink-muted focus:ring-0"
		data-testid="turn-info-dot"
		data-state={dot}
		aria-label={dotLabel(dot)}
		aria-haspopup="dialog"
		aria-expanded={open}
		title={dotLabel(dot)}
		onclick={() => (open = !open)}
	>
		<span
			data-testid="turn-info-glyph"
			class="flex size-4 items-center justify-center rounded-full
				{dot === 'applied'
				? 'bg-yellow text-neutral-900'
				: dot === 'blocked'
					? 'bg-red text-white dark:text-neutral-900'
					: ''}"
			aria-hidden="true"
		>
			{#if dot === "neutral"}
				<CarbonInformation class="size-3.5" />
			{:else}
				<CarbonInformationFilled class="size-3.5" />
			{/if}
		</span>
	</button>

	{#if open}
		<!-- A phone gets a sheet over a dimmed page; a desktop gets a popover above the dot. -->
		<div
			class="fixed inset-0 z-40 bg-black/30 md:hidden"
			aria-hidden="true"
			onclick={() => (open = false)}
		></div>
		<div
			role="dialog"
			aria-label={m["chat.turn_details.title"]()}
			data-testid="turn-info-panel"
			class="border-border fixed inset-x-0 bottom-0 z-50 max-h-[80dvh] overflow-y-auto rounded-t-2xl border bg-surface p-4 text-left text-sm text-ink shadow-xl
				md:absolute md:inset-x-auto md:right-0 md:bottom-full md:mb-2 md:max-h-[70dvh] md:w-80 md:rounded-xl"
		>
			<div class="mb-3 flex items-center justify-between gap-2">
				<h2 class="text-sm font-semibold">{m["chat.turn_details.title"]()}</h2>
				<button
					type="button"
					class="-m-1 btn rounded-xs p-1 text-ink-faint hover:text-ink-muted md:hidden"
					aria-label={m["chat.turn_details.close"]()}
					onclick={() => (open = false)}
				>
					<CarbonClose />
				</button>
				{#if dotStateWord(dot)}
					<span
						data-testid="turn-info-state"
						class="rounded-full px-2 py-0.5 text-xs font-medium {dot === 'blocked'
							? 'bg-red text-white dark:text-neutral-900'
							: 'bg-yellow text-neutral-900'}">{dotStateWord(dot)}</span
					>
				{/if}
			</div>

			<dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[13px]">
				<dt class="text-ink-muted">{m["chat.turn_details.model"]()}</dt>
				<dd class="text-right" data-testid="turn-info-model">{blank(stats?.model)}</dd>
				<dt class="text-ink-muted">{m["chat.turn_details.input"]()}</dt>
				<dd class="text-right">{formatCount(stats?.inputTokens)}</dd>
				<dt class="text-ink-muted">{m["chat.turn_details.output"]()}</dt>
				<dd class="text-right">{formatCount(stats?.outputTokens)}</dd>
				{#if stats?.reasoningTokens !== undefined}
					<dt class="text-ink-muted">{m["chat.turn_details.reasoning"]()}</dt>
					<dd class="text-right">{formatCount(stats.reasoningTokens)}</dd>
				{/if}
				<dt class="text-ink-muted">{m["chat.turn_details.first_token"]()}</dt>
				<dd class="text-right">{formatDuration(stats?.firstTokenMs)}</dd>
				<dt class="text-ink-muted">{m["chat.turn_details.speed"]()}</dt>
				<dd class="text-right">{formatSpeed(stats?.tokensPerSecond)}</dd>
				<dt class="text-ink-muted">{m["chat.turn_details.cost"]()}</dt>
				<dd class="text-right">{blank(stats?.cost)}</dd>
				<dt class="text-ink-muted">{m["chat.turn_details.time"]()}</dt>
				<dd class="text-right">{when}</dd>
			</dl>

			{#if redaction}
				<div class="border-border mt-3 border-t pt-3" data-testid="turn-info-redaction">
					<h3 class="mb-1.5 text-xs font-semibold tracking-wide text-ink-muted uppercase">
						{m["chat.turn_details.redaction.title"]()}
					</h3>
					{#if redaction.blocked}
						<p class="mb-1.5 text-[13px] font-medium">
							{m["chat.turn_details.redaction.refused"]()}
						</p>
					{/if}
					{#if redaction.applied && redaction.entities.length > 0}
						<p class="text-[13px]" data-testid="turn-info-summary">{redactionSummary(redaction)}</p>
						<ul class="mt-2 space-y-1 text-[13px] text-ink-muted">
							{#each redaction.entities as entity, i (i)}
								<li>
									{entity.count}
									{typeName(entity.type, entity.count)}{#if modeLabel(entity.mode)}
										· {modeLabel(entity.mode)}{/if}{#each entity.sources as source, j (j)}
										· {sourceLabel(source)}{/each}
								</li>
							{/each}
						</ul>
					{:else if !redaction.applied}
						<p class="text-[13px]">{m["chat.turn_details.redaction.none"]()}</p>
					{/if}
					{#if redaction.values && redaction.values.length > 0}
						<h4 class="mt-3 mb-1 text-xs font-semibold text-ink-muted">
							{m["chat.turn_details.redaction.values_title"]()}
						</h4>
						<ul class="space-y-0.5 text-[13px]" data-testid="turn-info-values">
							{#each redaction.values as value, i (i)}
								<li class="break-words">
									{m["chat.turn_details.redaction.value_row"]({
										original: value.original,
										kind: typeName(value.type),
									})}
								</li>
							{/each}
						</ul>
					{/if}
					{#if hasConsole}
						<a
							href={REDACTIONS_CONSOLE_PATH}
							target="_blank"
							rel="noopener noreferrer"
							data-testid="turn-info-console-link"
							class="mt-3 inline-block text-[13px] text-accent hover:underline"
							>{m["chat.turn_details.redaction.see_all"]()}</a
						>
					{/if}
				</div>
			{/if}
		</div>
	{/if}
</div>
