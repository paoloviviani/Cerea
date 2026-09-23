<!--
	A follow-up, with the agent's own settings attached — in the chat's
	own composer.

	The textarea is ChatInput with the default props: no mime types to offer
	(no upload affordances), no conversation to PATCH (so no web-search or
	knowledge or tool-approval pills either — the pill row hides with an
	empty allowlist), no hub mentions. What renders instead are the two
	pills the agent owns, in the chat composer's own pill idiom and inside
	the prompt box like chat's: the mode (paseo's permission vocabulary —
	plan, build, … — listed live from the daemon, never a hardcoded set
	that would drift from what it enforces) and the model. Both apply live
	to the open agent, not to one send: the licence is the agent's until it
	is switched again, which is paseo's own semantics.

	There is no provider field: the agent already has one, and the daemon's
	send takes none.

	The reply is NOT inserted optimistically: the transcript stream echoes
	the person's message back, and the stream is the source of truth.
	Sending twice against a slow daemon would print twice.
-->
<script lang="ts">
	import { untrack } from "svelte";
	import { DropdownMenu } from "bits-ui";
	import ChatInput from "$lib/components/chat/ChatInput.svelte";
	import IconArrowUp from "~icons/lucide/arrow-up";
	import IconChevronDown from "~icons/carbon/chevron-down";
	import IconCheck from "~icons/carbon/checkmark";
	import IconWarning from "~icons/carbon/warning-filled";
	import { isVirtualKeyboard } from "$lib/utils/isVirtualKeyboard";
	import { listProviderModes, listProviderModels, setAgentMode, setAgentModel } from "$lib/codeApi";
	import type { CodeProviderMode, CodeProviderModel } from "$lib/types/CodeAgent";
	import type { CodeAgentSession } from "$lib/types/CodeAgent";

	interface Props {
		deviceId: string;
		/** The address's agent id — known even when its snapshot read failed. */
		agentId: string;
		/** The open agent's snapshot: the pills' current values are its. Null
		 * when the snapshot read failed, and the pills then carry no claim. */
		agent: CodeAgentSession | null;
		/** Called synchronously with the submit, before the POST — the view
		 * engages the column's follow and raises its pending placeholder. */
		onsend: (text: string) => Promise<void>;
		/** Signals the parent to re-read the agent snapshot. The pill labels
		 * are the snapshot's, so a switch is only claimed once the daemon has
		 * confirmed it in a fresh read — the same discipline as the tree's
		 * "never an optimistic splice". */
		onchanged: () => void;
	}

	let { deviceId, agentId, agent, onsend, onchanged }: Props = $props();

	let draft = $state("");
	let focused = $state(false);
	let busy = $state(false);

	async function submit() {
		const message = draft.trim();
		if (!message || busy) return;
		busy = true;
		try {
			await onsend(message);
			// Cleared only on a landed send: a refused follow-up keeps its text,
			// like every composer here.
			draft = "";
		} finally {
			busy = false;
		}
	}

	// The two option lists, live from the daemon for the agent's provider.
	// Fetched eagerly rather than on first open: the pills resolve their
	// labels through these lists, so a closed menu would still want them.
	// A daemon that cannot answer leaves the failure in the menu — the
	// composer keeps working, because sending a follow-up never needed the
	// lists.
	let modes = $state<CodeProviderMode[] | null>(null);
	let modesFailure = $state<string | null>(null);
	let models = $state<CodeProviderModel[] | null>(null);
	let modelsFailure = $state<string | null>(null);

	// Guards the in-flight fetches against a provider swap (the view remounts
	// per address, so only a same-mount race exists): a stale answer must not
	// paint over the fresh one. No snapshot yet means no provider known — the
	// lists wait for it, and the effect re-runs when it lands.
	let listsToken = 0;
	$effect(() => {
		const provider = agent?.provider;
		if (!provider) return;
		const token = ++listsToken;
		modes = null;
		models = null;
		modesFailure = null;
		modelsFailure = null;
		untrack(async () => {
			try {
				const result = await listProviderModes(deviceId, provider);
				if (token === listsToken) modes = result.modes;
			} catch (err) {
				if (token === listsToken) {
					modesFailure = err instanceof Error ? err.message : "Could not load the modes.";
				}
			}
			try {
				const result = await listProviderModels(deviceId, provider);
				if (token === listsToken) models = result.models;
			} catch (err) {
				if (token === listsToken) {
					modelsFailure = err instanceof Error ? err.message : "Could not load the models.";
				}
			}
		});
	});

	// One switch in flight at a time; a refusal lands here and the pill
	// shows it, since the snapshot it labels from never changed.
	let applying = $state<"mode" | "model" | null>(null);
	let applyFailure = $state<string | null>(null);

	async function applyMode(modeId: string) {
		if (applying || modeId === (agent?.modeId ?? null)) return;
		applying = "mode";
		applyFailure = null;
		try {
			const result = await setAgentMode(deviceId, agentId, modeId);
			if (result.notice) applyFailure = result.notice;
			onchanged();
		} catch (err) {
			applyFailure = err instanceof Error ? err.message : "The daemon refused the mode.";
		} finally {
			applying = null;
		}
	}

	async function applyModel(modelId: string) {
		if (applying || modelId === (agent?.modelId ?? null)) return;
		applying = "model";
		applyFailure = null;
		try {
			await setAgentModel(deviceId, agentId, modelId);
			onchanged();
		} catch (err) {
			applyFailure = err instanceof Error ? err.message : "The daemon refused the model.";
		} finally {
			applying = null;
		}
	}

	let modeLabel = $derived.by(() => {
		if (!agent?.modeId) return "Mode";
		return modes?.find((mode) => mode.id === (agent?.modeId ?? null))?.label ?? agent.modeId;
	});
	let modelLabel = $derived.by(() => {
		if (!agent?.modelId) return "Model";
		return models?.find((model) => model.id === (agent?.modelId ?? null))?.label ?? agent.modelId;
	});

	// The chat composer's own pill classes, always in the blue tone: these
	// are pickers showing what the agent is set to, not toggles of state.
	const pillClass =
		"flex h-7 flex-none items-center gap-1 rounded-full border px-2.5 text-xs font-medium transition-colors border-blue-600/30 bg-blue-50 text-blue-700 dark:border-blue-700/60 dark:bg-blue-900/30 dark:text-blue-300 disabled:opacity-60";
	const menuContentClass =
		"z-50 rounded-xl border border-gray-200 bg-white/95 p-1 text-gray-800 shadow-lg backdrop-blur-sm dark:border-gray-700/60 dark:bg-gray-800/95 dark:text-gray-100";
	const menuItemClass =
		"flex h-9 items-center gap-1.5 rounded-md px-2 text-sm text-gray-700 select-none focus-visible:outline-hidden data-highlighted:bg-gray-100 sm:h-8 dark:text-gray-200 dark:data-highlighted:bg-white/10";
	const menuNoteClass =
		"flex h-9 items-center rounded-md px-2 text-sm text-gray-500 select-none sm:h-8 dark:text-gray-400";
</script>

<form
	tabindex="-1"
	onsubmit={(e) => {
		e.preventDefault();
		void submit();
	}}
	class={{
		"relative flex w-full max-w-4xl flex-1 flex-col rounded-xl border bg-gray-100 dark:border-gray-700 dark:bg-gray-800": true,
		"max-sm:mb-4": focused && isVirtualKeyboard(),
	}}
	style:--composer-actions-width="44px"
>
	<div class="flex w-full items-center">
		<div class="flex w-full flex-1 rounded-xl border-none bg-transparent">
			<ChatInput
				placeholder="Follow up with the agent…"
				bind:value={draft}
				mimeTypes={[]}
				onsubmit={submit}
				bind:focused
			>
				{#snippet children()}
					<!-- The pills live inside the prompt box, in the chat
					     composer's own row idiom — same width cap so neither
					     walks under the send button. -->
					<div
						class="-ml-0.5 flex max-w-[calc(100%-var(--composer-actions-width,44px))] flex-wrap items-center gap-1.5 px-3 pt-1.5 pb-2.5 text-gray-500 dark:text-gray-400"
					>
						<DropdownMenu.Root>
							<DropdownMenu.Trigger
								class={pillClass}
								disabled={applying === "mode"}
								title="How much the agent may do on its own — paseo's modes, as the daemon defines them"
							>
								{modeLabel}
								<IconChevronDown class="size-3 opacity-70" />
							</DropdownMenu.Trigger>
							<DropdownMenu.Portal>
								<DropdownMenu.Content
									class={menuContentClass}
									side="top"
									align="start"
									sideOffset={8}
									trapFocus={false}
									onCloseAutoFocus={(e) => e.preventDefault()}
									interactOutsideBehavior="defer-otherwise-close"
								>
									{#if modes === null && !modesFailure}
										<DropdownMenu.Item class={menuNoteClass} disabled>
											Loading modes…
										</DropdownMenu.Item>
									{:else if modesFailure}
										<DropdownMenu.Item class={menuNoteClass} disabled>
											Could not load modes: {modesFailure}
										</DropdownMenu.Item>
									{:else if !modes?.length}
										<DropdownMenu.Item class={menuNoteClass} disabled>
											The daemon lists no modes.
										</DropdownMenu.Item>
									{:else}
										{#each modes as mode (mode.id)}
											<DropdownMenu.Item
												class={menuItemClass}
												onSelect={() => void applyMode(mode.id)}
											>
												<IconCheck
													class="size-3.5 shrink-0 {mode.id === (agent?.modeId ?? null)
														? 'opacity-100'
														: 'opacity-0'}"
												/>
												<span class="whitespace-nowrap" title={mode.description}>
													{mode.label}
												</span>
											</DropdownMenu.Item>
										{/each}
									{/if}
								</DropdownMenu.Content>
							</DropdownMenu.Portal>
						</DropdownMenu.Root>

						<DropdownMenu.Root>
							<DropdownMenu.Trigger
								class={pillClass}
								disabled={applying === "model"}
								title="The model this agent runs"
							>
								<span class="max-w-48 truncate">{modelLabel}</span>
								<IconChevronDown class="size-3 opacity-70" />
							</DropdownMenu.Trigger>
							<DropdownMenu.Portal>
								<DropdownMenu.Content
									class="{menuContentClass} scrollbar-custom max-h-64 overflow-y-auto"
									side="top"
									align="start"
									sideOffset={8}
									trapFocus={false}
									onCloseAutoFocus={(e) => e.preventDefault()}
									interactOutsideBehavior="defer-otherwise-close"
								>
									{#if models === null && !modelsFailure}
										<DropdownMenu.Item class={menuNoteClass} disabled>
											Loading models…
										</DropdownMenu.Item>
									{:else if modelsFailure}
										<DropdownMenu.Item class={menuNoteClass} disabled>
											Could not load models: {modelsFailure}
										</DropdownMenu.Item>
									{:else if !models?.length}
										<DropdownMenu.Item class={menuNoteClass} disabled>
											The daemon lists no models.
										</DropdownMenu.Item>
									{:else}
										{#each models as model (model.id)}
											<DropdownMenu.Item
												class={menuItemClass}
												onSelect={() => void applyModel(model.id)}
											>
												<IconCheck
													class="size-3.5 shrink-0 {model.id === (agent?.modelId ?? null)
														? 'opacity-100'
														: 'opacity-0'}"
												/>
												<span class="max-w-64 truncate" title={model.description}>
													{model.label}
												</span>
											</DropdownMenu.Item>
										{/each}
									{/if}
								</DropdownMenu.Content>
							</DropdownMenu.Portal>
						</DropdownMenu.Root>

						{#if applyFailure}
							<span
								class="flex min-w-0 items-center gap-1 text-xs text-amber-600 dark:text-amber-400"
							>
								<IconWarning class="size-3 shrink-0" />
								<span class="min-w-0 truncate" title={applyFailure}>{applyFailure}</span>
							</span>
						{/if}
					</div>
				{/snippet}
			</ChatInput>
			<button
				class="absolute right-2 bottom-2 btn size-8 self-end rounded-full border bg-white text-black shadow transition-none enabled:hover:bg-white enabled:hover:shadow-inner sm:size-7 dark:border-transparent dark:bg-gray-600 dark:text-white dark:hover:enabled:bg-black {!draft
					? ''
					: 'bg-black! text-white! dark:bg-white! dark:text-black!'}"
				disabled={!draft.trim() || busy}
				type="submit"
				aria-label="Send message"
				name="submit"
			>
				<IconArrowUp />
			</button>
		</div>
	</div>
</form>
