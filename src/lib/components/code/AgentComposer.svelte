<!--
	A follow-up, with the agent's own settings attached — in the chat's
	own composer.

	The textarea is ChatInput with the default props: no mime types to offer
	(no upload affordances), no conversation to PATCH (so no web-search or
	knowledge or tool-approval pills either — the pill row hides with an
	empty allowlist), no hub mentions. What renders instead are the pills
	the agent owns, in the chat composer's own pill idiom and inside the
	prompt box like chat's: the mode (paseo's permission vocabulary —
	plan, build, … — listed live from the daemon, never a hardcoded set
	that would drift from what it enforces) and the model. Both apply live
	to the open agent, not to one send: the licence is the agent's until it
	is switched again, which is paseo's own semantics. Beside them sit the
	provider's feature toggles the agent itself reports (opencode's
	auto-accept), drawn like chat's own toggle pills — blue when on, gray
	when off — and claimed only from the agent's snapshot.

	While a turn is live the send button's spot carries the stop control,
	chat's own swap (`ChatWindow` renders `StopGeneratingBtn` in the same
	place) — and it stays while a permission card is up, because stopping
	a prompt nobody wants to answer is the point of it.

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
	import StopGeneratingBtn from "$lib/components/StopGeneratingBtn.svelte";
	import IconArrowUp from "~icons/lucide/arrow-up";
	import IconChevronDown from "~icons/carbon/chevron-down";
	import IconCheck from "~icons/carbon/checkmark";
	import IconWarning from "~icons/carbon/warning-filled";
	import LucideShieldCheck from "~icons/lucide/shield-check";
	import { isVirtualKeyboard } from "$lib/utils/isVirtualKeyboard";
	import {
		listProviderFeatures,
		listProviderModes,
		listProviderModels,
		setAgentFeature,
		setAgentMode,
		setAgentModel,
	} from "$lib/codeApi";
	import type { CodeProviderFeature } from "$lib/codeApi";
	import type { CodeProviderMode, CodeProviderModel } from "$lib/types/CodeAgent";
	import type { CodeAgentSession } from "$lib/types/CodeAgent";

	interface Props {
		deviceId: string;
		/** The address's agent id — known even when its snapshot read failed. */
		agentId: string;
		/** The open agent's snapshot: the pills' current values are its. Null
		 * when the snapshot read failed, and the pills then carry no claim. */
		agent: CodeAgentSession | null;
		/** The provider features the agent ITSELF reports — the auto-accept
		 * toggle's live value. Empty when the snapshot read failed: a toggle
		 * with no daemon word behind it does not render as on or off. */
		features?: CodeProviderFeature[];
		/** The agent's working directory, which the feature list query needs
		 * (the daemon resolves features per working directory). */
		cwd?: string | null;
		/** Whether a turn is live on the transcript — the send button's spot
		 * carries the stop control while it is, permission prompts included. */
		running?: boolean;
		/** Called synchronously with the submit, before the POST — the view
		 * engages the column's follow and raises its pending placeholder. */
		onsend: (text: string) => Promise<void>;
		/** Stops the live turn. The transcript records the ending; this only
		 * carries the request to the daemon. */
		onstop?: () => void;
		/** Signals the parent to re-read the agent snapshot. The pill labels
		 * are the snapshot's, so a switch is only claimed once the daemon has
		 * confirmed it in a fresh read — the same discipline as the tree's
		 * "never an optimistic splice". */
		onchanged: () => void;
	}

	let {
		deviceId,
		agentId,
		agent,
		features = [],
		cwd = null,
		running = false,
		onsend,
		onstop,
		onchanged,
	}: Props = $props();

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
	/** What toggles the provider offers at all — the descriptor list, not
	 * the values. The live values come from the agent's snapshot
	 * (`features`), so this only ever decides that a toggle exists and
	 * what it is called. */
	let featureCatalog = $state<CodeProviderFeature[] | null>(null);

	// Guards the in-flight fetches against a provider swap (the view remounts
	// per address, so only a same-mount race exists): a stale answer must not
	// paint over the fresh one. No snapshot yet means no provider known — the
	// lists wait for it, and the effect re-runs when it lands. Modes and
	// models need nothing but the provider; the feature list additionally
	// waits for a working directory, which the daemon resolves features
	// per — so the two reads are separate effects, and a snapshot without a
	// cwd (or a features endpoint that fails) never holds the pills
	// hostage. Both stay untracked so a mode/model switch's snapshot
	// refresh does not tear the list down mid-read (opencode's feature set
	// does not vary by mode, and the draft's modeId/model are best-effort
	// echoes of the agent's config).
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

	let featuresToken = 0;
	$effect(() => {
		const provider = agent?.provider;
		if (!provider || !cwd) return;
		const token = ++featuresToken;
		featureCatalog = null;
		const draft = untrack(() => ({
			cwd,
			...(agent?.modeId ? { modeId: agent.modeId } : {}),
			...(agent?.modelId ? { model: agent.modelId } : {}),
		}));
		untrack(async () => {
			// The feature list fails quietly: a toggle has no menu to carry
			// the failure into, and the pills keep working — the same
			// reading as the lists above, minus the surface.
			try {
				const result = await listProviderFeatures(deviceId, provider, draft);
				if (token === featuresToken) featureCatalog = result.features;
			} catch {
				if (token === featuresToken) featureCatalog = [];
			}
		});
	});

	// The toggles the composer renders: the snapshot's features (value
	// claimed) first, then anything the provider lists that the snapshot
	// is silent on — rendered disabled, because existence is known but a
	// state is not claimable, and a toggle that cannot show a claimed
	// value must not take a click.
	let featurePills = $derived.by(() => {
		const reported = new Map(features.map((feature) => [feature.id, feature]));
		const pills: Array<CodeProviderFeature & { reported: boolean }> = [
			...features.map((feature) => ({ ...feature, reported: true })),
		];
		for (const feature of featureCatalog ?? []) {
			if (reported.has(feature.id)) continue;
			pills.push({ ...feature, reported: false });
		}
		return pills;
	});

	// One switch in flight at a time; a refusal lands here and the pill
	// shows it, since the snapshot it labels from never changed. The
	// feature toggles join the vocabulary: their key is the feature id.
	let applying = $state<string | null>(null);
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

	/** Flip a provider feature (the auto-accept toggle). Nothing is claimed
	 * here: the POST is the request, and the pill reads its value from the
	 * agent snapshot, which `onchanged` re-reads — so the label claims the
	 * new value only when the refreshed snapshot agrees, and a refusal
	 * leaves it exactly as the daemon last reported. */
	async function applyFeature(feature: { id: string; value: boolean }) {
		if (applying) return;
		applying = feature.id;
		applyFailure = null;
		try {
			await setAgentFeature(deviceId, agentId, feature.id, !feature.value);
			onchanged();
		} catch (err) {
			applyFailure = err instanceof Error ? err.message : "The daemon refused the feature.";
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

						<!-- The provider's feature toggles, drawn like chat's own
						     toggle pills (web search, tool approval): blue when on,
						     gray when off, `aria-pressed` carrying the state. The
						     value is the agent snapshot's word; a toggle the
						     snapshot is silent on renders disabled. -->
						{#each featurePills as feature (feature.id)}
							<button
								type="button"
								class="flex h-7 flex-none items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium transition-colors {feature.value
									? 'border-blue-600/30 bg-blue-50 text-blue-700 dark:border-blue-700/60 dark:bg-blue-900/30 dark:text-blue-300'
									: 'border-gray-200 bg-white text-gray-600 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700'} disabled:opacity-60"
								aria-pressed={feature.value}
								disabled={applying === feature.id || !feature.reported}
								title={feature.reported
									? (feature.description ??
										(feature.value ? "On. Click to turn off." : "Off. Click to turn on."))
									: "Waiting for the daemon's word on this agent"}
								onclick={() => void applyFeature(feature)}
							>
								<LucideShieldCheck class="size-3.5" />
								{feature.label}
							</button>
						{/each}

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
			{#if running}
				<!-- The stop control, exactly where chat's sits: ChatWindow
				     swaps the send button for StopGeneratingBtn in this same
				     spot while a turn is live. It stays while a permission
				     card is up — stopping a prompt nobody wants to answer is
				     the point of it — and the turn's end comes from the
				     transcript's stream, not from this click. -->
				<StopGeneratingBtn
					onClick={onstop}
					showBorder={true}
					classNames="absolute bottom-2 right-2 size-8 sm:size-7 self-end rounded-full border bg-white text-black shadow-sm transition-none dark:border-transparent dark:bg-gray-600 dark:text-white"
				/>
			{:else}
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
			{/if}
		</div>
	</div>
</form>
