<!--
	The composer's permission control: one shield. Icon-only while the chat is
	on the default (Ask: the assistant asks before opening web pages or using
	connectors); a label and a tint appear only when it is not. A click opens a
	small menu with the modes this chat has (Ask, Allow) and a link to the
	per-tool settings. What a mode means stays with the caller (`onselect`).
-->
<script lang="ts">
	import { DropdownMenu } from "bits-ui";
	import { base } from "$app/paths";
	import { goto } from "$app/navigation";
	import LucideShield from "~icons/lucide/shield";
	import LucideShieldCheck from "~icons/lucide/shield-check";
	import LucideCheck from "~icons/lucide/check";
	import { m } from "$lib/paraglide/messages";

	export type ShieldMode = "ask" | "allow";

	interface Props {
		mode: ShieldMode;
		onselect: (mode: ShieldMode) => void;
		disabled?: boolean;
	}

	let { mode, onselect, disabled = false }: Props = $props();

	const nonDefault = $derived(mode !== "ask");
	const shieldLabel = $derived(m["chat.input.shield_label"]());
	const modeLabel = $derived(
		mode === "allow" ? m["chat.input.shield_allow"]() : m["chat.input.shield_ask"]()
	);
	const itemClass =
		"flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 text-sm select-none focus-visible:outline-hidden data-highlighted:bg-gray-100 dark:data-highlighted:bg-white/10";
</script>

<DropdownMenu.Root>
	<DropdownMenu.Trigger
		{disabled}
		data-testid="permission-shield"
		data-mode={mode}
		aria-label="{shieldLabel}: {modeLabel}"
		title={mode === "allow"
			? m["chat.input.shield_allow_hint"]()
			: m["chat.input.shield_ask_hint"]()}
		class={[
			"flex h-7 flex-none items-center gap-1.5 rounded-full text-xs font-medium transition-colors disabled:opacity-60 max-sm:h-8",
			nonDefault
				? "bg-accent-subtle px-2.5 text-accent max-sm:px-2"
				: "w-7 justify-center text-ink-faint hover:bg-gray-100 hover:text-ink-muted max-sm:w-8 dark:hover:bg-white/10",
		]}
	>
		{#if nonDefault}
			<LucideShieldCheck class="size-3.5" />
			<span data-testid="permission-shield-label">{modeLabel}</span>
		{:else}
			<LucideShield class="size-4" />
		{/if}
	</DropdownMenu.Trigger>
	<DropdownMenu.Portal>
		<DropdownMenu.Content
			class="z-50 w-64 rounded-xl border border-gray-200 bg-white/95 p-1 text-gray-800 shadow-lg backdrop-blur-sm dark:border-gray-700/60 dark:bg-gray-800/95 dark:text-gray-100"
			side="top"
			align="end"
			sideOffset={8}
			collisionPadding={8}
			onCloseAutoFocus={(e) => e.preventDefault()}
		>
			<DropdownMenu.RadioGroup value={mode} onValueChange={(v) => onselect(v as ShieldMode)}>
				<DropdownMenu.RadioItem value="ask" class={itemClass} data-testid="permission-shield-ask">
					{#snippet children({ checked })}
						<span class="min-w-0 flex-1">
							<span class="block">{m["chat.input.shield_ask"]()}</span>
							<span class="block text-xs text-ink-muted">{m["chat.input.shield_ask_hint"]()}</span>
						</span>
						{#if checked}<LucideCheck class="mt-0.5 size-4 shrink-0 text-ink-muted" />{/if}
					{/snippet}
				</DropdownMenu.RadioItem>
				<DropdownMenu.RadioItem
					value="allow"
					class={itemClass}
					data-testid="permission-shield-allow"
				>
					{#snippet children({ checked })}
						<span class="min-w-0 flex-1">
							<span class="block">{m["chat.input.shield_allow"]()}</span>
							<span class="block text-xs text-ink-muted">{m["chat.input.shield_allow_hint"]()}</span
							>
						</span>
						{#if checked}<LucideCheck class="mt-0.5 size-4 shrink-0 text-ink-muted" />{/if}
					{/snippet}
				</DropdownMenu.RadioItem>
			</DropdownMenu.RadioGroup>
			<DropdownMenu.Separator class="my-1 h-px bg-gray-200 dark:bg-gray-700" />
			<DropdownMenu.Item
				class={itemClass}
				data-testid="permission-shield-settings"
				onSelect={() => {
					// noScroll: SvelteKit's own hash scroll would shift the fixed
					// app shell; the settings page scrolls its pane itself.
					void goto(`${base}/settings/application#tool-approvals`, { noScroll: true });
				}}
			>
				{m["chat.input.shield_per_tool"]()}
			</DropdownMenu.Item>
		</DropdownMenu.Content>
	</DropdownMenu.Portal>
</DropdownMenu.Root>
