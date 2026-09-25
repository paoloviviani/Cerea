<script lang="ts">
	import { onDestroy, onMount, tick } from "svelte";
	import { MediaQuery } from "svelte/reactivity";

	import { afterNavigate, goto } from "$app/navigation";

	import { DropdownMenu } from "bits-ui";
	import IconPlus from "~icons/lucide/plus";
	import CarbonImage from "~icons/carbon/image";
	import CarbonDocument from "~icons/carbon/document";
	import CarbonUpload from "~icons/carbon/upload";
	import CarbonLink from "~icons/carbon/link";
	import CarbonChevronRight from "~icons/carbon/chevron-right";
	import CarbonClose from "~icons/carbon/close";
	import LucideLibrary from "~icons/lucide/library";
	import UrlFetchModal from "./UrlFetchModal.svelte";
	import CarbonEarth from "~icons/carbon/earth";
	import LucideShieldCheck from "~icons/lucide/shield-check";
	import { TEXT_MIME_ALLOWLIST, IMAGE_MIME_ALLOWLIST_DEFAULT } from "$lib/constants/mime";
	import IconMCP from "$lib/components/icons/IconMCP.svelte";
	import HfHubMentionAutocomplete from "./HfHubMentionAutocomplete.svelte";
	import MlInternPill from "./MlInternPill.svelte";

	import { isVirtualKeyboard } from "$lib/utils/isVirtualKeyboard";
	import { requireAuthUser } from "$lib/utils/auth";
	import {
		selectedServerIds,
		allMcpServers,
		toggleServer,
		disableAllServers,
	} from "$lib/stores/mcpServers";
	import {
		connectors,
		connectorsFailed,
		connectorsLoaded,
		enabledConnectors,
		refreshConnectors,
		selectedConnectorIds,
		toggleConnector,
		totalEnabledMcpCount,
		disableAllConnectors,
	} from "$lib/stores/mcpConnectors";
	import { getMcpServerFaviconUrl } from "$lib/utils/favicon";
	import { type HfHubResource } from "$lib/utils/hfHubSearch";
	import { HubMentionState } from "$lib/utils/hubMention.svelte";
	import { getCaretCoordinates } from "$lib/utils/caretCoordinates";
	import { usePublicConfig } from "$lib/utils/PublicConfig.svelte";
	import { page } from "$app/state";
	import { base } from "$app/paths";
	import { gwGet, GatewayError, type VectorStore } from "$lib/gateway";
	import { error as errorToast } from "$lib/stores/errors";

	interface Props {
		files?: File[];
		mimeTypes?: string[];
		value?: string;
		placeholder?: string;
		loading?: boolean;
		disabled?: boolean;
		// tools removed
		modelIsMultimodal?: boolean;
		// Whether the currently selected model supports tool calling (incl. overrides)
		modelSupportsTools?: boolean;
		// Offers the ML Intern mode switch beside the MCP pill (empty conversations only)
		showMlPill?: boolean;
		// Knowledge bases attached to THIS conversation, as {id, name} pairs.
		// Bindable: the toggle updates it optimistically, and on the home page —
		// where no conversation exists to PATCH — the list rides into the
		// create-conversation body instead.
		knowledgeBases?: { id: string; name: string }[];
		// Web search for THIS conversation. Bindable per-chat state: the toggle
		// flips it and PATCHes the conversation when one exists; on the home
		// page the value rides into the create-conversation body instead.
		// Settings hold *defaults*, a chat holds *per-chat state* — this never
		// writes to `Settings.webSearchEnabled`.
		webSearch?: boolean;
		/** Chat's own tools in the attach row (MCP servers, knowledge bases,
		 * web search, tool approval). Off for a composer that only wants the
		 * file picker, such as an agent's: those tools do nothing there. */
		chatTools?: boolean;
		// Tool-approval policy override for THIS conversation (ADR 0075).
		// Bindable per-chat state: the toggle flips it and PATCHes the
		// conversation when one exists. `true` means gated calls (web_fetch,
		// MCP tools) run without asking in this chat — the composer's way of
		// overriding the user's setting in either direction; on the home page
		// there is no conversation to override yet, so the toggle there is a
		// no-op until one exists.
		autoApproveTools?: boolean;
		children?: import("svelte").Snippet;
		/** Pinned at the end of the toolbar row, after the pill group that
		 * scrolls horizontally on mobile — never scrolls away with it (the
		 * agent composer's context ring uses this). */
		trailingActions?: import("svelte").Snippet;
		onPaste?: (e: ClipboardEvent) => void;
		focused?: boolean;
		onsubmit?: () => void;
	}

	let {
		files = $bindable([]),
		mimeTypes = [],
		value = $bindable(""),
		placeholder = "",
		loading = false,
		disabled = false,

		modelIsMultimodal = false,
		modelSupportsTools = true,
		showMlPill = false,
		knowledgeBases = $bindable([]),
		webSearch = $bindable(false),
		chatTools = true,
		autoApproveTools = $bindable(false),
		children,
		trailingActions,
		onPaste,
		focused = $bindable(false),
		onsubmit,
	}: Props = $props();

	async function toggleWebSearch() {
		const previous = webSearch;
		const next = !webSearch;
		webSearch = next;

		// No conversation yet: the create request carries the value, so the
		// chat is initialized before the first turn is ever generated.
		if (!page.params.id) return;

		try {
			const response = await fetch(`${base}/conversation/${page.params.id}`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ webSearch: next }),
			});
			if (!response.ok) {
				let message = "Failed to update web search";
				try {
					message = ((await response.json()) as { message?: string }).message ?? message;
				} catch {
					// not JSON
				}
				throw new Error(message);
			}
		} catch (err) {
			// Roll back the optimistic toggle so the pill never claims a state
			// the server refused.
			webSearch = previous;
			errorToast.set(err instanceof Error ? err.message : "Failed to update web search");
		}
	}

	// The tool-approval gate (ADR 0075) resolves chat override, then the
	// user's setting, then `manual`. Inside a conversation the flip is
	// PATCHed onto it; on the home page there is nothing to PATCH yet, so
	// it only flips the local state the create request reads.
	async function toggleAutoApproveTools() {
		const previous = autoApproveTools;
		const next = !autoApproveTools;
		autoApproveTools = next;
		if (!page.params.id) return;

		try {
			const response = await fetch(`${base}/conversation/${page.params.id}`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ toolApprovalOverride: next ? "always-allow" : "manual" }),
			});
			if (!response.ok) {
				let message = "Failed to update tool approval";
				try {
					message = ((await response.json()) as { message?: string }).message ?? message;
				} catch {
					// not JSON
				}
				throw new Error(message);
			}
		} catch (err) {
			// Home page has no PATCH to fail (returned above); this rollback
			// is for the conversation-page PATCH only.
			autoApproveTools = previous;
			errorToast.set(err instanceof Error ? err.message : "Failed to update tool approval");
		}
	}

	const onFileChange = async (e: Event) => {
		if (!e.target) return;
		const target = e.target as HTMLInputElement;
		const selected = Array.from(target.files ?? []);
		if (selected.length === 0) return;
		files = [...files, ...selected];
		await tick();
		void focusTextarea();
	};

	let textareaElement: HTMLTextAreaElement | undefined = $state();
	let isCompositionOn = $state(false);
	let blurTimeout: ReturnType<typeof setTimeout> | null = $state(null);
	let hubBlurTimeout: ReturnType<typeof setTimeout> | null = null;

	// Hub mentions reach out to huggingface.co, so they are a HuggingChat
	// feature: a self-hosted deployment must not send a prefix of whatever the
	// user typed to a third party, and an air-gapped one cannot anyway.
	const publicConfig = usePublicConfig();
	const hub = new HubMentionState({ enabled: publicConfig.isHuggingChat });
	const isHubMentionOpen = $derived(hub.open);

	/** Panel anchor: the `@` of the mention being edited, in composer space. */
	let hubAnchor = $state({ left: 0, bottom: 0 });
	/** Panel width, kept in step with the `w-72` on the listbox. */
	const HUB_PANEL_WIDTH = 288;
	function updateHubAnchor() {
		const mention = hub.mention;
		if (!textareaElement || !mention) return;
		const caret = getCaretCoordinates(textareaElement, mention.start);
		const parent =
			textareaElement.offsetParent instanceof HTMLElement ? textareaElement.offsetParent : null;
		// Clamped so a mention typed near the right edge of a wide composer does
		// not push the panel off it.
		const maxLeft = Math.max(0, (parent?.clientWidth ?? 0) - HUB_PANEL_WIDTH);
		hubAnchor = {
			left: Math.min(Math.max(0, textareaElement.offsetLeft + caret.left), maxLeft),
			// Measured from the composer's bottom edge so the panel sits just above
			// the line the mention is on, clearing its glyphs.
			bottom: parent ? parent.clientHeight - (textareaElement.offsetTop + caret.top) + 4 : 0,
		};
	}

	let fileInputEl: HTMLInputElement | undefined = $state();
	let isUrlModalOpen = $state(false);
	let isDropdownOpen = $state(false);

	// Below Tailwind's md breakpoint the toolbar row scrolls horizontally and a
	// side-opening submenu (root ~180px plus a flyout up to ~280px) cannot fit
	// beside its parent: floating-ui's shift only corrects the placement's main
	// axis, so for `side="right"` nothing pulls horizontal overflow back and
	// `flip`'s bestFit just keeps the least-clipped side. Stacking the flyouts
	// below their trigger there instead lets shift (horizontal) and flip
	// (vertical) cover both axes; wide screens keep the side cascade as today.
	const narrowViewport = new MediaQuery("(max-width: 767px)");

	// Knowledge bases attachable to THIS conversation. The picker lists what
	// the person can reach (`GET /api/v2/gateway/vector_stores` is already
	// filtered to the caller's own access server-side), fetched when the
	// submenu opens so a base created moments ago is offered immediately.
	let knowledgeStores = $state<VectorStore[] | null>(null);
	let knowledgeStoresLoading = $state(false);
	let knowledgeStoresFailed = $state(false);

	const signedIn = $derived(Boolean(page.data.user));

	async function loadKnowledgeStores() {
		if (knowledgeStoresLoading) return;
		knowledgeStoresLoading = true;
		knowledgeStoresFailed = false;
		try {
			knowledgeStores = (await gwGet<{ data: VectorStore[] }>("vector_stores")).data;
		} catch (err) {
			if (err instanceof GatewayError) {
				// The bases list failing to load must not break the menu: it is the
				// same judgement the project dialog makes ("not fatal"), and the
				// submenu says so rather than pretending there is nothing.
				knowledgeStoresFailed = true;
			} else {
				throw err;
			}
		} finally {
			knowledgeStoresLoading = false;
		}
	}

	function isBaseAttached(id: string): boolean {
		return knowledgeBases.some((base) => base.id === id);
	}

	async function toggleKnowledgeBase(store: VectorStore, checked: boolean) {
		const previous = knowledgeBases;
		const next = checked
			? [...knowledgeBases, { id: store.id, name: store.name }]
			: knowledgeBases.filter((base) => base.id !== store.id);
		knowledgeBases = next;

		// No conversation yet: the create request carries the ids, so the base
		// is attached before the first turn is ever generated.
		if (!page.params.id) return;

		try {
			const response = await fetch(`${base}/conversation/${page.params.id}`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ knowledgeBaseIds: next.map((base) => base.id) }),
			});
			if (!response.ok) {
				let message = "Failed to update knowledge bases";
				try {
					message = ((await response.json()) as { message?: string }).message ?? message;
				} catch {
					// not JSON
				}
				throw new Error(message);
			}
		} catch (err) {
			// Roll back the optimistic toggle so the checkmark never claims an
			// attachment the server refused; the turn's retrieval would silently
			// miss the base otherwise.
			knowledgeBases = previous;
			errorToast.set(err instanceof Error ? err.message : "Failed to update knowledge bases");
		}
	}

	function openPickerWithAccept(accept: string) {
		if (!fileInputEl) return;
		const allAccept = mimeTypes.join(",");
		fileInputEl.setAttribute("accept", accept);
		fileInputEl.click();
		queueMicrotask(() => fileInputEl?.setAttribute("accept", allAccept));
	}

	function openFilePickerText() {
		const textAccept =
			mimeTypes.filter((m) => !(m === "image/*" || m.startsWith("image/"))).join(",") ||
			TEXT_MIME_ALLOWLIST.join(",");
		openPickerWithAccept(textAccept);
	}

	function openFilePickerImage() {
		const imageAccept =
			mimeTypes.filter((m) => m === "image/*" || m.startsWith("image/")).join(",") ||
			IMAGE_MIME_ALLOWLIST_DEFAULT.join(",");
		openPickerWithAccept(imageAccept);
	}

	const waitForAnimationFrame = () =>
		typeof requestAnimationFrame === "function"
			? new Promise<void>((resolve) => {
					requestAnimationFrame(() => resolve());
				})
			: Promise.resolve();

	async function focusTextarea() {
		if (page.data.shared && page.data.loginEnabled && !page.data.user) return;
		if (!textareaElement || textareaElement.disabled || isVirtualKeyboard()) return;
		if (typeof document !== "undefined" && document.activeElement === textareaElement) return;

		await tick();

		if (typeof requestAnimationFrame === "function") {
			await waitForAnimationFrame();
			await waitForAnimationFrame();
		}

		if (!textareaElement || textareaElement.disabled || isVirtualKeyboard()) return;

		try {
			textareaElement.focus({ preventScroll: true });
		} catch {
			textareaElement.focus();
		}

		// Retry only when focus failed due to #app being inert (modal closing transition)
		if (
			typeof document !== "undefined" &&
			document.activeElement !== textareaElement &&
			document.getElementById("app")?.hasAttribute("inert")
		) {
			setTimeout(() => {
				if (!textareaElement || textareaElement.disabled || isVirtualKeyboard()) return;
				if (document.activeElement === textareaElement) return;
				try {
					textareaElement.focus({ preventScroll: true });
				} catch {
					textareaElement.focus();
				}
			}, 350);
		}
	}

	function handleFetchedFiles(newFiles: File[]) {
		if (!newFiles?.length) return;
		files = [...files, ...newFiles];
		queueMicrotask(async () => {
			await tick();
			void focusTextarea();
		});
	}

	onMount(() => {
		void focusTextarea();
	});

	onDestroy(() => {
		if (hubBlurTimeout) clearTimeout(hubBlurTimeout);
		hub.destroy();
	});

	afterNavigate(() => {
		void focusTextarea();
	});

	function adjustTextareaHeight() {
		if (!textareaElement) {
			return;
		}

		textareaElement.style.height = "auto";
		textareaElement.style.height = `${textareaElement.scrollHeight}px`;

		if (textareaElement.selectionStart === textareaElement.value.length) {
			textareaElement.scrollTop = textareaElement.scrollHeight;
		}
	}

	$effect(() => {
		if (!textareaElement) return;
		void value;
		adjustTextareaHeight();
	});

	function syncHubMentionFromTextarea() {
		if (!textareaElement) return;
		hub.update(textareaElement.value, textareaElement.selectionStart);
		updateHubAnchor();
	}

	function handleInput(event: Event) {
		const target = event.currentTarget as HTMLTextAreaElement;
		if (disabled) return;
		hub.update(target.value, target.selectionStart);
		updateHubAnchor();
	}

	// The textarea reports its own edits; a programmatic write (ChatWindow
	// clearing the draft on submit) reports nothing, so the panel has to notice
	// the mention it was tracking is gone.
	$effect(() => {
		hub.syncValue(value);
	});

	async function selectHubResult(result: HfHubResource) {
		const replacement = hub.accept(value, result);
		if (!replacement) return;
		value = replacement.value;

		await tick();
		textareaElement?.focus();
		textareaElement?.setSelectionRange(replacement.caret, replacement.caret);
		adjustTextareaHeight();
	}

	function handleKeydown(event: KeyboardEvent) {
		if (isHubMentionOpen && !isCompositionOn) {
			if (event.key === "ArrowDown" && hub.results.length > 0) {
				event.preventDefault();
				hub.move(1);
				return;
			}
			if (event.key === "ArrowUp" && hub.results.length > 0) {
				event.preventDefault();
				hub.move(-1);
				return;
			}
			// Tab accepts the first result outright; Enter only accepts once the
			// user has arrowed into the list. Otherwise `ping @john` would be
			// rewritten and the send swallowed by whatever the Hub matched, and on
			// a phone Enter is the newline key with no Escape to back out with.
			if (event.key === "Tab" && !event.shiftKey && hub.results.length > 0) {
				event.preventDefault();
				void selectHubResult(hub.activeResult ?? hub.results[0]);
				return;
			}
			if (event.key === "Enter" && !event.shiftKey && hub.activeResult) {
				event.preventDefault();
				void selectHubResult(hub.activeResult);
				return;
			}
			if (event.key === "Escape") {
				event.preventDefault();
				hub.dismiss();
				return;
			}
		}

		if (
			event.key === "Enter" &&
			!event.shiftKey &&
			!isCompositionOn &&
			!isVirtualKeyboard() &&
			value.trim() !== ""
		) {
			event.preventDefault();
			tick();
			onsubmit?.();
		}
	}

	function handleFocus() {
		if (requireAuthUser()) {
			return;
		}
		if (blurTimeout) {
			clearTimeout(blurTimeout);
			blurTimeout = null;
		}
		if (hubBlurTimeout) {
			clearTimeout(hubBlurTimeout);
			hubBlurTimeout = null;
		}
		focused = true;
		// Deliberately does NOT open the panel: focusing a restored draft that
		// happens to end in an @token would fire a request and hijack Enter
		// before the user has typed anything.
	}

	function handleBlur() {
		if (hubBlurTimeout) clearTimeout(hubBlurTimeout);
		hubBlurTimeout = setTimeout(() => {
			hubBlurTimeout = null;
			hub.reset();
		}, 100);

		if (!isVirtualKeyboard()) {
			focused = false;
			return;
		}

		if (blurTimeout) {
			clearTimeout(blurTimeout);
		}

		blurTimeout = setTimeout(() => {
			blurTimeout = null;
			focused = false;
		});
	}

	// Show file upload when any mime is allowed (text always; images if multimodal)
	let showFileUpload = $derived(mimeTypes.length > 0);
	let showNoTools = $derived(!showFileUpload);
	// Servers and connectors together, because the badge is about what this
	// message carries and a favicon is a favicon either way. `id` stays unique
	// across the two: one is a uuid or `base-…`, the other a Mongo id.
	let selectedServers = $derived([
		...$allMcpServers.filter((server) => $selectedServerIds.has(server.id)),
		...$enabledConnectors,
	]);
</script>

<!-- min-w-0: a flex item's default min-width is its content's natural
     (unwrapped) size, which this composer's toolbar row — several pills
     wide — happily supplies. Without this, that natural width wins over
     whatever the actual composer box has available and propagates up
     through every ancestor flex container in the chain, each one
     growing to fit rather than the toolbar row's own pills wrapping to
     fit — invisible normally (nothing else on the page constrains this
     composer that tightly), but the file explorer panel does, and it
     stopped the toolbar row from wrapping at all rather than the
     pill-by-pill degradation the design intends (brief item 2). -->
<div class="flex min-h-full min-w-0 flex-1 flex-col" onpaste={onPaste}>
	<!-- autocomplete=off is not autofill: it opts the composer out of the
	     browser's session form-state restore, which otherwise re-pastes an
	     already-sent prompt into the box on reload mid-generation (the value
	     typed on / travels into this page's history entry across the SPA
	     navigation, and the restore bypasses the Svelte binding). -->
	<div class="relative">
		{#if isHubMentionOpen}
			<HfHubMentionAutocomplete
				results={hub.results}
				status={hub.status ?? "loading"}
				activeIndex={hub.activeIndex}
				caretAnchor={hubAnchor}
				onselect={(result) => void selectHubResult(result)}
				onactivechange={(index) => hub.setActiveIndex(index)}
			/>
		{/if}

		<textarea
			rows="1"
			tabindex="0"
			inputmode="text"
			autocomplete="off"
			role="combobox"
			aria-autocomplete="list"
			aria-expanded={isHubMentionOpen}
			aria-controls={isHubMentionOpen ? "hf-hub-mention-listbox" : undefined}
			aria-activedescendant={isHubMentionOpen && hub.activeIndex >= 0
				? `hf-hub-mention-option-${hub.activeIndex}`
				: undefined}
			class="scrollbar-custom max-h-[4lh] w-full resize-none overflow-x-hidden overflow-y-auto border-0 bg-transparent px-2.5 py-2.5 outline-hidden focus:ring-0 focus-visible:ring-0 sm:px-3 md:max-h-[8lh]"
			class:text-gray-400={disabled}
			bind:value
			bind:this={textareaElement}
			oninput={handleInput}
			onkeydown={handleKeydown}
			onkeyup={(event) => {
				// Vertical arrows are only intercepted once results exist; while the
				// search is in flight they move the caret like any other key, so the
				// tracked mention has to follow them too.
				if (
					["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)
				) {
					syncHubMentionFromTextarea();
				}
			}}
			onclick={syncHubMentionFromTextarea}
			onselect={syncHubMentionFromTextarea}
			oncompositionstart={() => (isCompositionOn = true)}
			oncompositionend={() => {
				isCompositionOn = false;
				syncHubMentionFromTextarea();
			}}
			{placeholder}
			{disabled}
			onfocus={handleFocus}
			onblur={handleBlur}
			onbeforeinput={requireAuthUser}
		></textarea>
	</div>

	{#if !showNoTools || showMlPill || children || trailingActions}
		<!-- relative, w-full + min-w-0: the trailing actions (below) anchor
		     to this, not the inner row's own (intentionally narrower) box,
		     and not the composer form either — see that block's own
		     comment for why the form was wrong. w-full + min-w-0 are load
		     bearing: without them this wrapper has no sizing information
		     of its own and a flex item defaults to its *content's* natural
		     width (every pill unwrapped) rather than shrinking to whatever
		     its own parent actually has available — which the inner row's
		     max-w-[calc(100%-…)] then computed *against*, both numbers
		     drifting further from the real available width the narrower
		     this whole composer got (the file explorer panel open beside
		     it can make it very narrow indeed). -->
		<div class="relative flex w-full min-w-0 items-start">
			<div
				class={[
					// Stops short of the trailing action buttons (reserved
					// below); ChatWindow/AgentComposer report their width.
					// items-start, not items-center: the pill group wraps to a
					// second row on a narrower desktop when it does not fit — a
					// machine-veto banner does the same with its own forced
					// line break (`basis-full`). Centering this row against
					// that now-taller sibling would float `+` down to the
					// wrapped block's vertical middle instead of level with
					// its first line, which is where it belongs (brief item 2:
					// "the + stays at the start of the first [row]").
					"-ml-0.5 flex max-w-[calc(100%-var(--composer-actions-width,40px))] items-start gap-1.5 px-3 pt-1.5 pb-2.5 text-gray-500 dark:text-gray-400",
				]}
			>
				{#if showFileUpload}
					<div class="flex shrink-0 items-center">
						<input
							bind:this={fileInputEl}
							disabled={loading}
							class="absolute hidden size-0"
							aria-label="Upload file"
							type="file"
							multiple
							onchange={onFileChange}
							onclick={(e) => {
								if (requireAuthUser()) {
									e.preventDefault();
								}
							}}
							accept={mimeTypes.join(",")}
						/>

						<DropdownMenu.Root
							bind:open={isDropdownOpen}
							onOpenChange={(open) => {
								if (open && requireAuthUser()) {
									isDropdownOpen = false;
									return;
								}
								isDropdownOpen = open;
							}}
						>
							<DropdownMenu.Trigger
								class="btn size-8 rounded-full border bg-white text-black shadow-sm transition-none enabled:hover:bg-white enabled:hover:shadow-inner sm:size-7 dark:border-transparent dark:bg-gray-600/50 dark:text-white dark:hover:enabled:bg-gray-600"
								disabled={loading}
								aria-label="Add attachment"
							>
								<IconPlus class="text-base sm:text-sm" />
							</DropdownMenu.Trigger>
							<DropdownMenu.Portal>
								<DropdownMenu.Content
									class="z-50 rounded-xl border border-gray-200 bg-white/95 p-1 text-gray-800 shadow-lg backdrop-blur-sm dark:border-gray-700/60 dark:bg-gray-800/95 dark:text-gray-100"
									side="top"
									sideOffset={8}
									align="start"
									trapFocus={false}
									onCloseAutoFocus={(e) => e.preventDefault()}
									interactOutsideBehavior="defer-otherwise-close"
								>
									{#if modelIsMultimodal}
										<DropdownMenu.Item
											class="flex h-9 items-center gap-1 rounded-md px-2 text-sm text-gray-700 select-none focus-visible:outline-hidden data-highlighted:bg-gray-100 sm:h-8 dark:text-gray-200 dark:data-highlighted:bg-white/10"
											onSelect={() => openFilePickerImage()}
										>
											<CarbonImage class="size-4 opacity-90 dark:opacity-80" />
											Add image(s)
										</DropdownMenu.Item>
									{/if}

									<DropdownMenu.Sub>
										<DropdownMenu.SubTrigger
											class="flex h-9 items-center gap-1 rounded-md px-2 text-sm text-gray-700 select-none focus-visible:outline-hidden data-highlighted:bg-gray-100 data-[state=open]:bg-gray-100 sm:h-8 dark:text-gray-200 dark:data-highlighted:bg-white/10 dark:data-[state=open]:bg-white/10"
										>
											<div class="flex items-center gap-1">
												<CarbonDocument class="size-4 opacity-90 dark:opacity-80" />
												Add text file
											</div>
											<div class="ml-auto flex items-center">
												<CarbonChevronRight class="size-4 opacity-70 dark:opacity-80" />
											</div>
										</DropdownMenu.SubTrigger>
										<DropdownMenu.SubContent
											class="z-50 rounded-xl border border-gray-200 bg-white/95 p-1 text-gray-800 shadow-lg backdrop-blur-sm dark:border-gray-700/60 dark:bg-gray-800/95 dark:text-gray-100"
											side={narrowViewport.current ? "bottom" : "right"}
											align={narrowViewport.current ? "start" : "center"}
											sideOffset={10}
											collisionPadding={8}
											sticky="always"
											trapFocus={false}
											onCloseAutoFocus={(e) => e.preventDefault()}
											interactOutsideBehavior="defer-otherwise-close"
										>
											<DropdownMenu.Item
												class="flex h-9 items-center gap-1 rounded-md px-2 text-sm text-gray-700 select-none focus-visible:outline-hidden data-highlighted:bg-gray-100 sm:h-8 dark:text-gray-200 dark:data-highlighted:bg-white/10"
												onSelect={() => openFilePickerText()}
											>
												<CarbonUpload class="size-4 opacity-90 dark:opacity-80" />
												Upload from device
											</DropdownMenu.Item>
											<DropdownMenu.Item
												class="flex h-9 items-center gap-1 rounded-md px-2 text-sm text-gray-700 select-none focus-visible:outline-hidden data-highlighted:bg-gray-100 sm:h-8 dark:text-gray-200 dark:data-highlighted:bg-white/10"
												onSelect={() => (isUrlModalOpen = true)}
											>
												<CarbonLink class="size-4 opacity-90 dark:opacity-80" />
												Fetch from URL
											</DropdownMenu.Item>
										</DropdownMenu.SubContent>
									</DropdownMenu.Sub>

									{#if chatTools}
										<!-- MCP Servers submenu: legacy env-configured base servers
							     plus the person's connectors (ADR 0064) in one flyout.
							     Connectors refresh when the submenu opens so one added
							     moments ago is offered immediately. Signed-out visitors
							     get a 401 ("none") and see only the base rows. -->
										<DropdownMenu.Sub
											onOpenChange={(open) => {
												if (open) void refreshConnectors();
											}}
										>
											<DropdownMenu.SubTrigger
												class="flex h-9 items-center gap-1 rounded-md px-2 text-sm text-gray-700 select-none focus-visible:outline-hidden data-highlighted:bg-gray-100 data-[state=open]:bg-gray-100 sm:h-8 dark:text-gray-200 dark:data-highlighted:bg-white/10 dark:data-[state=open]:bg-white/10"
											>
												<div class="flex items-center gap-1">
													<IconMCP classNames="size-4 opacity-90 dark:opacity-80" />
													MCP Servers
												</div>
												<div class="ml-auto flex items-center">
													<CarbonChevronRight class="size-4 opacity-70 dark:opacity-80" />
												</div>
											</DropdownMenu.SubTrigger>
											<DropdownMenu.SubContent
												class="z-50 rounded-xl border border-gray-200 bg-white/95 p-1 text-gray-800 shadow-lg backdrop-blur-sm dark:border-gray-700/60 dark:bg-gray-800/95 dark:text-gray-100"
												side={narrowViewport.current ? "bottom" : "right"}
												align={narrowViewport.current ? "start" : "center"}
												sideOffset={10}
												collisionPadding={8}
												sticky="always"
												trapFocus={false}
												onCloseAutoFocus={(e) => e.preventDefault()}
												interactOutsideBehavior="defer-otherwise-close"
											>
												{#each $allMcpServers as server (server.id)}
													<DropdownMenu.CheckboxItem
														checked={$selectedServerIds.has(server.id)}
														onCheckedChange={() => toggleServer(server.id)}
														closeOnSelect={false}
														class="flex h-9 items-center gap-2 rounded-md px-2 text-sm leading-none text-gray-800 select-none focus-visible:outline-hidden data-highlighted:bg-gray-100 dark:text-gray-100 dark:data-highlighted:bg-white/10"
													>
														{#snippet children({ checked })}
															<img
																src={getMcpServerFaviconUrl(server.url)}
																alt=""
																class="size-4 flex-shrink-0 rounded-sm"
															/>
															<span class="max-w-52 truncate py-1">{server.name}</span>
															<div class="ml-auto flex items-center">
																<!-- Toggle visual -->
																<span
																	class={[
																		"relative mt-px flex h-4 w-7 items-center self-center rounded-full transition-colors",
																		checked ? "bg-blue-600/80" : "bg-gray-300 dark:bg-gray-700",
																	]}
																>
																	<span
																		class={[
																			"block size-3 translate-x-0.5 rounded-full bg-white shadow-sm transition-transform",
																			checked ? "translate-x-[14px]" : "translate-x-0.5",
																		]}
																	></span>
																</span>
															</div>
														{/snippet}
													</DropdownMenu.CheckboxItem>
												{/each}

												{#if $allMcpServers.length > 0 && signedIn && (!$connectorsLoaded || $connectorsFailed || $connectors.length > 0)}
													<DropdownMenu.Separator
														class="my-1 h-px bg-gray-200 dark:bg-gray-700/60"
													/>
												{/if}

												{#if signedIn}
													{#if !$connectorsLoaded}
														<DropdownMenu.Item
															class="flex h-9 items-center gap-1 rounded-md px-2 text-sm text-gray-500 select-none sm:h-8 dark:text-gray-400"
															disabled
														>
															Loading connectors…
														</DropdownMenu.Item>
													{:else if $connectorsFailed}
														<DropdownMenu.Item
															class="flex h-9 items-center gap-1 rounded-md px-2 text-sm text-gray-500 select-none sm:h-8 dark:text-gray-400"
															disabled
														>
															Could not load connectors
														</DropdownMenu.Item>
													{:else if $connectors.length === 0}
														<!-- Only when there is nothing else to toggle: a
											     deployment with base servers needs no lecture. -->
														{#if $allMcpServers.length === 0}
															<DropdownMenu.Item
																class="flex h-9 items-center rounded-md px-2 py-1 text-sm text-gray-500 select-none sm:h-8 dark:text-gray-400"
																disabled
															>
																No connectors yet. Add one from Manage MCP Servers.
															</DropdownMenu.Item>
														{/if}
													{:else}
														{#each $connectors as connector (connector.id)}
															{#if connector.connected}
																<DropdownMenu.CheckboxItem
																	checked={$selectedConnectorIds.has(connector.id)}
																	onCheckedChange={() => toggleConnector(connector.id)}
																	closeOnSelect={false}
																	class="flex h-9 items-center gap-2 rounded-md px-2 text-sm leading-none text-gray-800 select-none focus-visible:outline-hidden data-highlighted:bg-gray-100 dark:text-gray-100 dark:data-highlighted:bg-white/10"
																>
																	{#snippet children({ checked })}
																		<img
																			src={getMcpServerFaviconUrl(connector.url)}
																			alt=""
																			class="size-4 flex-shrink-0 rounded-sm"
																		/>
																		<span class="max-w-52 truncate py-1">{connector.name}</span>
																		<div class="ml-auto flex items-center">
																			<!-- Toggle visual -->
																			<span
																				class={[
																					"relative mt-px flex h-4 w-7 items-center self-center rounded-full transition-colors",
																					checked
																						? "bg-blue-600/80"
																						: "bg-gray-300 dark:bg-gray-700",
																				]}
																			>
																				<span
																					class={[
																						"block size-3 translate-x-0.5 rounded-full bg-white shadow-sm transition-transform",
																						checked ? "translate-x-[14px]" : "translate-x-0.5",
																					]}
																				></span>
																			</span>
																		</div>
																	{/snippet}
																</DropdownMenu.CheckboxItem>
															{:else}
																<!-- Not connected (OAuth sign-in pending): it
													     contributes no tools, so there is nothing to
													     toggle. Tapping opens the manager, where the
													     sign-in lives, instead of selecting a no-op. -->
																<DropdownMenu.Item
																	class="flex h-9 items-center gap-2 rounded-md px-2 text-sm leading-none text-gray-800 select-none focus-visible:outline-hidden data-highlighted:bg-gray-100 dark:text-gray-100 dark:data-highlighted:bg-white/10"
																	title="Sign in from Manage MCP Servers"
																	onSelect={() => void goto(`${base}/workspace?tab=mcp`)}
																>
																	<img
																		src={getMcpServerFaviconUrl(connector.url)}
																		alt=""
																		class="size-4 flex-shrink-0 rounded-sm"
																	/>
																	<span class="max-w-32 truncate py-1">{connector.name}</span>
																	<span
																		class="truncate py-1 text-xs text-gray-500 dark:text-gray-400"
																	>
																		Not signed in
																	</span>
																	<div class="ml-auto flex items-center">
																		<!-- Toggle visual, visibly off -->
																		<span
																			class="relative mt-px flex h-4 w-7 items-center self-center rounded-full bg-gray-300 transition-colors dark:bg-gray-700"
																		>
																			<span
																				class="block size-3 translate-x-0.5 rounded-full bg-white shadow-sm transition-transform"
																			></span>
																		</span>
																	</div>
																</DropdownMenu.Item>
															{/if}
														{/each}
													{/if}
												{/if}

												{#if $allMcpServers.length > 0 || (signedIn && $connectorsLoaded && !$connectorsFailed && $connectors.length > 0)}
													<DropdownMenu.Separator
														class="my-1 h-px bg-gray-200 dark:bg-gray-700/60"
													/>
												{/if}
												<DropdownMenu.Item
													class="flex h-9 items-center gap-1 rounded-md px-2 text-sm text-gray-700 select-none focus-visible:outline-hidden data-highlighted:bg-gray-100 sm:h-8 dark:text-gray-200 dark:data-highlighted:bg-white/10"
													onSelect={() => void goto(`${base}/workspace?tab=mcp`)}
												>
													Manage MCP Servers
												</DropdownMenu.Item>
											</DropdownMenu.SubContent>
										</DropdownMenu.Sub>
									{/if}

									<!-- Knowledge bases submenu: attach to THIS conversation, in
							     addition to any bases its project carries. Signed-in only,
							     since retrieval runs as the reader — and hidden entirely
							     when the deployment switch says the pipeline is off. -->
									{#if chatTools && signedIn && page.data.knowledgeEnabled !== false}
										<DropdownMenu.Sub
											onOpenChange={(open) => {
												if (open) void loadKnowledgeStores();
											}}
										>
											<DropdownMenu.SubTrigger
												class="flex h-9 items-center gap-1 rounded-md px-2 text-sm text-gray-700 select-none focus-visible:outline-hidden data-highlighted:bg-gray-100 data-[state=open]:bg-gray-100 sm:h-8 dark:text-gray-200 dark:data-highlighted:bg-white/10 dark:data-[state=open]:bg-white/10"
											>
												<div class="flex items-center gap-1">
													<LucideLibrary class="size-4 opacity-90 dark:opacity-80" />
													Knowledge bases
													{#if knowledgeBases.length > 0}
														<span
															class="rounded-md bg-blue-600/10 px-1.5 text-xs text-blue-600 dark:bg-blue-600/20 dark:text-blue-400"
														>
															{knowledgeBases.length}
														</span>
													{/if}
												</div>
												<div class="ml-auto flex items-center">
													<CarbonChevronRight class="size-4 opacity-70 dark:opacity-80" />
												</div>
											</DropdownMenu.SubTrigger>
											<DropdownMenu.SubContent
												class="z-50 scrollbar-custom max-h-64 overflow-y-auto rounded-xl border border-gray-200 bg-white/95 p-1 text-gray-800 shadow-lg backdrop-blur-sm dark:border-gray-700/60 dark:bg-gray-800/95 dark:text-gray-100"
												side={narrowViewport.current ? "bottom" : "right"}
												align={narrowViewport.current ? "start" : "center"}
												sideOffset={10}
												collisionPadding={8}
												sticky="always"
												trapFocus={false}
												onCloseAutoFocus={(e) => e.preventDefault()}
												interactOutsideBehavior="defer-otherwise-close"
											>
												{#if knowledgeStoresLoading}
													<DropdownMenu.Item
														class="flex h-9 items-center gap-1 rounded-md px-2 text-sm text-gray-500 select-none sm:h-8 dark:text-gray-400"
														disabled
													>
														Loading knowledge bases…
													</DropdownMenu.Item>
												{:else if knowledgeStoresFailed}
													<DropdownMenu.Item
														class="flex h-9 items-center gap-1 rounded-md px-2 text-sm text-gray-500 select-none sm:h-8 dark:text-gray-400"
														disabled
													>
														Could not load knowledge bases
													</DropdownMenu.Item>
												{:else if !knowledgeStores || knowledgeStores.length === 0}
													<DropdownMenu.Item
														class="flex h-9 items-center rounded-md px-2 py-1 text-sm text-gray-500 select-none sm:h-8 dark:text-gray-400"
														disabled
													>
														No knowledge bases yet. Create one from the Knowledge screen.
													</DropdownMenu.Item>
												{:else}
													{#each knowledgeStores as store (store.id)}
														<DropdownMenu.CheckboxItem
															checked={isBaseAttached(store.id)}
															onCheckedChange={(checked) => toggleKnowledgeBase(store, checked)}
															closeOnSelect={false}
															class="flex h-9 items-center gap-2 rounded-md px-2 text-sm leading-none text-gray-800 select-none focus-visible:outline-hidden data-highlighted:bg-gray-100 dark:text-gray-100 dark:data-highlighted:bg-white/10"
														>
															{#snippet children({ checked })}
																<LucideLibrary class="size-4 shrink-0 opacity-90 dark:opacity-80" />
																<span class="max-w-52 truncate py-1" title={store.description}>
																	{store.name}
																</span>
																<div class="ml-auto flex items-center">
																	<!-- Toggle visual -->
																	<span
																		class={[
																			"relative mt-px flex h-4 w-7 items-center self-center rounded-full transition-colors",
																			checked ? "bg-blue-600/80" : "bg-gray-300 dark:bg-gray-700",
																		]}
																	>
																		<span
																			class={[
																				"block size-3 translate-x-0.5 rounded-full bg-white shadow-sm transition-transform",
																				checked ? "translate-x-[14px]" : "translate-x-0.5",
																			]}
																		></span>
																	</span>
																</div>
															{/snippet}
														</DropdownMenu.CheckboxItem>
													{/each}
												{/if}
											</DropdownMenu.SubContent>
										</DropdownMenu.Sub>
									{/if}
								</DropdownMenu.Content>
							</DropdownMenu.Portal>
						</DropdownMenu.Root>

						{#if chatTools && $totalEnabledMcpCount > 0}
							<div
								class="ml-1.5 inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full bg-blue-600/10 pr-1 pl-2 text-xs font-semibold text-blue-700 sm:h-7 dark:bg-blue-600/20 dark:text-blue-400"
								class:grayscale={!modelSupportsTools}
								class:opacity-60={!modelSupportsTools}
								class:cursor-help={!modelSupportsTools}
								title={modelSupportsTools
									? "MCP servers enabled"
									: "Current model doesn’t support tools"}
							>
								<!-- The manager is a workspace tab now, not an overlay
							     mounted here — every opener navigates to it. -->
								<button
									class="inline-flex cursor-pointer items-center gap-1 bg-transparent p-0 leading-none whitespace-nowrap text-current select-none focus:outline-hidden"
									type="button"
									title="Manage MCP Servers"
									onclick={() => void goto(`${base}/workspace?tab=mcp`)}
									class:line-through={!modelSupportsTools}
								>
									{#if selectedServers.length}
										<span class="flex items-center -space-x-1">
											{#each selectedServers.slice(0, 3) as server (server.id)}
												<img
													src={getMcpServerFaviconUrl(server.url)}
													alt=""
													class="size-4 shrink-0 rounded-sm bg-white p-px shadow-xs ring-1 ring-black/5 dark:bg-gray-900 dark:ring-white/10"
												/>
											{/each}
											{#if selectedServers.length > 3}
												<span
													class="ml-1 text-[10px] font-semibold text-blue-800 dark:text-blue-200"
												>
													+{selectedServers.length - 3}
												</span>
											{/if}
										</span>
									{/if}
									MCP ({$totalEnabledMcpCount})
								</button>
								<button
									class="grid size-5 place-items-center rounded-full bg-blue-600/15 text-blue-700 transition-colors hover:bg-blue-600/25 dark:bg-blue-600/25 dark:text-blue-300 dark:hover:bg-blue-600/35"
									aria-label="Disable all MCP servers"
									onclick={() => {
										disableAllServers();
										disableAllConnectors();
									}}
									type="button"
								>
									<CarbonClose class="size-3.5" />
								</button>
							</div>
						{/if}
					</div>
				{/if}

				<div
					class="scrollbar-custom flex min-w-0 flex-1 flex-wrap items-center gap-1.5 max-sm:flex-nowrap max-sm:overflow-x-auto max-sm:mask-r-from-85%"
				>
					{@render children?.()}

					{#if chatTools}
						<!-- Web search through the gateway's own backends (ADR 0058's plan,
			     phase 2). The toggle is the user's consent to spend; the tool
			     itself only exists when the console has granted a search tier,
			     so a toggle with nothing behind it costs nothing and changes
			     nothing. -->
						<button
							type="button"
							class="flex h-7 flex-none items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium transition-colors {webSearch
								? 'border-blue-600/30 bg-blue-50 text-blue-700 dark:border-blue-700/60 dark:bg-blue-900/30 dark:text-blue-300'
								: 'border-gray-200 bg-white text-gray-600 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700'}"
							aria-pressed={webSearch}
							title="Search the web through this deployment's search backends (this chat only)"
							onclick={toggleWebSearch}
						>
							<CarbonEarth class="size-3.5" />
							Web search
						</button>

						<!-- Chat-local override of the tool-approval policy (ADR 0075).
				     Inside a conversation this PATCHes the override; on the home
				     page there is no conversation yet, so it only flips the local
				     state that rides into the create request. -->
						<button
							type="button"
							class="flex h-7 flex-none items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium transition-colors {autoApproveTools
								? 'border-blue-600/30 bg-blue-50 text-blue-700 dark:border-blue-700/60 dark:bg-blue-900/30 dark:text-blue-300'
								: 'border-gray-200 bg-white text-gray-600 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700'}"
							aria-pressed={autoApproveTools}
							title={autoApproveTools
								? "web_fetch and MCP tools run without asking in this chat. Click to ask again."
								: "web_fetch and MCP tools ask before running. Click to allow them without asking, in this chat only."}
							onclick={toggleAutoApproveTools}
						>
							<LucideShieldCheck class="size-3.5" />
							{autoApproveTools ? "Tools auto-approved" : "Tools ask first"}
						</button>
					{/if}

					{#if showMlPill}
						<MlInternPill />
					{/if}
				</div>

				{#if trailingActions}
					<!-- Positioned against the outer, unconstrained wrapper
					     (above), not the composer form: pinning it to the
					     form's own bottom-right corner (the pre-item-2
					     approach) meant it only ever lined up with `+`/the
					     pill row's first line by coincidence of the form's
					     total height — a taller pill block (wrapped, or a
					     machine-veto banner underneath) changed that height
					     and left it stranded. Anchored here instead, and out
					     of the pill row's own flex flow, it always sits level
					     with the row's first line, in the max-w gap that row
					     reserves for it. -->
					<div class="flex flex-none items-center gap-1.5 sm:absolute sm:top-1.5 sm:right-3">
						{@render trailingActions()}
					</div>
				{/if}
			</div>
		</div>
	{/if}

	<UrlFetchModal
		bind:open={isUrlModalOpen}
		acceptMimeTypes={mimeTypes}
		onfiles={handleFetchedFiles}
	/>
</div>

<style>
	/* In the base layer so utility classes (font-mono, text-xs, prose) keep
	   winning over these element selectors, as they did before Tailwind v4 */
	@layer base {
		:global(pre),
		:global(textarea) {
			font-family: inherit;
			box-sizing: border-box;
			line-height: 1.5;
			font-size: 16px;
		}
	}
</style>
