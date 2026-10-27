<script lang="ts">
	import { m } from "$lib/paraglide/messages";
	import { modelLabel, settingsModelId } from "$lib/utils/customModelEntries";
	import type { Message } from "$lib/types/Message";
	import { onDestroy, untrack } from "svelte";

	import ArtifactPanel from "./ArtifactPanel.svelte";
	import PreviewPane from "./PreviewPane.svelte";
	import TrackioPane from "./TrackioPane.svelte";
	import DeliverablesPanel from "./DeliverablesPanel.svelte";
	import { collectArtifacts, splitArtifactSegments } from "$lib/utils/artifacts";
	import { MessageUpdateType, type MessageArtifactDraftUpdate } from "$lib/types/MessageUpdate";
	import { setArtifactsContext } from "$lib/utils/artifactsContext";
	import { collectTrackioDashboards } from "$lib/utils/trackio";
	import { trackioStatus } from "$lib/stores/trackioStatus.svelte";
	import { collectFileArtifacts, withLiveRunFiles } from "$lib/utils/fileArtifacts";
	import { runFiles } from "$lib/stores/runFiles.svelte";
	import { collectPaneItems } from "$lib/utils/paneItems";
	import { sidePane } from "$lib/stores/sidePane.svelte";

	import IconArrowUp from "~icons/lucide/arrow-up";
	import IconMic from "~icons/lucide/mic";

	import ChatInput from "./ChatInput.svelte";
	import AskQuestion from "./AskQuestion.svelte";
	import { firstQuestionFor } from "$lib/stores/pendingQuestion";
	import { shouldShowPendingPlaceholder } from "$lib/utils/pendingPlaceholder";
	import VoiceRecorder from "./VoiceRecorder.svelte";
	import StopGeneratingBtn from "../StopGeneratingBtn.svelte";
	import type { Model } from "$lib/types/Model";
	import FileDropzone from "./FileDropzone.svelte";
	import RetryBtn from "../RetryBtn.svelte";
	import { base } from "$app/paths";
	import ChatMessageColumn from "./ChatMessageColumn.svelte";
	import ModelEffortPicker from "./ModelEffortPicker.svelte";
	import {
		chatEffort,
		readRecent,
		withRecent,
		RECENT_MODELS_KEY,
	} from "$lib/utils/modelEffortPicker";
	import { browser } from "$app/environment";
	import SystemPromptModal from "../SystemPromptModal.svelte";
	import ChatIntroduction from "./ChatIntroduction.svelte";
	import ComposerFileChips from "./ComposerFileChips.svelte";
	import { FileDrag } from "$lib/utils/fileDrag.svelte";
	import { pastedAttachments } from "$lib/utils/composerFiles";
	import { chatDraftKey } from "$lib/utils/composerDraft";
	import { useSettingsStore } from "$lib/stores/settings";
	import { error } from "$lib/stores/errors";
	import ModelSwitch from "./ModelSwitch.svelte";
	import ModelPicker from "./ModelPicker.svelte";
	import { exportConversation as exportConversationStore } from "$lib/stores/exportConversation";
	import CarbonSidePanelOpen from "~icons/carbon/side-panel-open";
	import {
		downloadMarkdown,
		exportConversationToMarkdown,
		exportFilename,
	} from "$lib/utils/exportConversationMarkdown";
	import FeatureAnnouncementToast from "../FeatureAnnouncementToast.svelte";
	import { getActiveAnnouncement } from "$lib/utils/featureAnnouncements";
	import { usePublicConfig } from "$lib/utils/PublicConfig.svelte";
	import { pendingComposerPayload } from "$lib/stores/pendingComposerPayload";
	import { mimeMatchesAllowlist } from "$lib/utils/mimeMatch";
	import LucideHammer from "~icons/lucide/hammer";
	import { useConversationsStore } from "$lib/stores/conversations.svelte";
	import { MediaQuery } from "svelte/reactivity";

	import { isVirtualKeyboard } from "$lib/utils/isVirtualKeyboard";
	import { requireAuthUser } from "$lib/utils/auth";
	import { tap, error as hapticError } from "$lib/utils/haptics";
	import { page } from "$app/state";
	import { safeInvalidate } from "$lib/utils/safeInvalidate";
	import { UrlDependency } from "$lib/types/UrlDependency";

	// Only this conversation's question; the store outlives a navigation by a tick.
	let questionStore = $derived(firstQuestionFor(page.params.id));
	let askQuestion = $derived($questionStore);
	import {
		isMessageToolCallUpdate,
		isMessageToolErrorUpdate,
		isMessageToolResultUpdate,
	} from "$lib/utils/messageUpdates";
	import type { ToolFront } from "$lib/types/Tool";

	interface Props {
		messages?: Message[];
		messagesAlternatives?: Message["id"][][];
		loading?: boolean;
		pending?: boolean;
		resuming?: boolean;
		currentModel: Model;
		models: Model[];
		preprompt?: string | undefined;
		files?: File[];
		onmessage?: (content: string) => void;
		onstop?: () => void;
		onretry?: (payload: { id: Message["id"]; content?: string }) => void;
		onshowAlternateMsg?: (payload: { id: Message["id"] }) => void;
		draft?: string;
		/**
		 * A fresh send's text, set by the page when the send fails: the
		 * optimistic message sits in the thread with a retry, and the text
		 * comes back here so it can be edited rather than retyped. Bound,
		 * consumed once, then cleared — never left set.
		 */
		sendFailedText?: string | null;
		/** Knowledge bases attached to THIS conversation; bound through to the composer. */
		knowledgeBases?: { id: string; name: string }[];
		/**
		 * Web search for THIS conversation; bound through to the composer.
		 * Per-chat state seeded by the page (conversation, then project, then
		 * app default) — never the settings default directly.
		 */
		webSearch?: boolean;
		/**
		 * Tool-approval policy override for THIS conversation (ADR 0075); bound
		 * through to the composer. `true` means gated calls (web_fetch, MCP
		 * tools) run without asking in this chat, overriding the user's
		 * setting in either direction.
		 */
		autoApproveTools?: boolean;
		/** This conversation's own thinking effort, when it has chosen one. */
		conversationEffort?: "low" | "medium" | "high";
		/** Conversation title, used for the Markdown export heading and filename. */
		conversationTitle?: string;
	}

	let {
		messages = [],
		messagesAlternatives = [],
		loading = false,
		pending = false,
		resuming = false,
		currentModel,
		models,
		preprompt = undefined,
		files = $bindable([]),
		draft = $bindable(""),
		sendFailedText = $bindable<string | null>(null),
		onmessage,
		onstop,
		onretry,
		onshowAlternateMsg,
		knowledgeBases = $bindable([]),
		webSearch = $bindable(false),
		autoApproveTools = $bindable(false),
		conversationEffort,
		conversationTitle = "",
	}: Props = $props();

	let isReadOnly = $derived(!models.some((model) => model.id === currentModel.id));

	// Unsent-text persistence for the composer below: one draft per
	// conversation (`home` before one exists), kept on this device only.
	// Switching conversations swaps the draft rather than carrying it over.
	let draftKey = $derived(chatDraftKey(page.params.id));

	/** The per-conversation model picker. Not the workspace's Models tab,
	    which is the management surface and sets the default. */
	let pickerOpen = $state(false);

	const publicConfig = usePublicConfig();
	let canExport = $derived(
		Boolean(page.params?.id) && page.route.id?.startsWith("/conversation/") && messages.length > 0
	);

	// Per-conversation Markdown export, serialized client-side from the
	// visible branch already in the page (content + reasoning are loaded),
	// then downloaded via a blob-URL anchor. Disabled mid-generation so the
	// file always matches the settled transcript, never a partial stream.
	function exportConversation() {
		const id = page.params.id ?? "";
		const markdown = exportConversationToMarkdown({
			title: conversationTitle,
			conversationId: id,
			messages,
			model: modelLabel(currentModel),
		});
		downloadMarkdown(exportFilename(conversationTitle, id), markdown);
	}

	// Mirrored into the store so MobileNav (mounted in the root layout, outside
	// this component's tree) can render its own export button off the same
	// state, rather than duplicating the canExport derivation.
	$effect(() => {
		exportConversationStore.set({
			canExport: Boolean(canExport),
			loading,
			run: exportConversation,
		});
	});

	// Feature announcement toast: home screen only, gone as soon as a chat starts.
	let featureAnnouncement = $derived(
		getActiveAnnouncement(publicConfig.PUBLIC_FEATURE_ANNOUNCEMENTS)
	);
	let showFeatureAnnouncement = $derived(page.route.id === "/" && !messages.length && !loading);

	// Artifacts: fold <artifact> operations from the visible message path into a
	// versioned registry, shared with the inline cards and the side panel.
	// Only the message currently receiving tokens can have a streaming artifact;
	// unclosed tags anywhere else are interrupted generations, not live ones.
	let artifactRegistry = $derived(
		collectArtifacts(messages, loading ? messages.at(-1)?.id : undefined)
	);

	// Auto-open the panel when a new artifact version starts streaming in
	// (once per version, so closing it mid-stream sticks).
	$effect(() => {
		const streaming = artifactRegistry.streaming;
		if (!streaming || !loading) return;
		sidePane.maybeAutoOpen(streaming.identifier, streaming.version);
	});

	// Live `artifact`-tool drafts (tool mode): the latest draft per tool call
	// from the message currently receiving tokens. Shown in the panel as a
	// streaming block until the executed call's canonical block replaces it. A
	// draft is dropped once the live message already carries a closed block
	// for its identifier — the final arrived and the draft is stale.
	let artifactDrafts = $derived.by(() => {
		if (!loading) return [] as MessageArtifactDraftUpdate[];
		const live = messages.at(-1);
		if (!live) return [] as MessageArtifactDraftUpdate[];
		const byCall = new Map<string, MessageArtifactDraftUpdate>();
		for (const u of live.updates ?? []) {
			if (u.type === MessageUpdateType.ArtifactDraft) byCall.set(u.toolCallId, u);
		}
		if (byCall.size === 0) return [] as MessageArtifactDraftUpdate[];
		const closed = new Set<string>();
		for (const segment of splitArtifactSegments(live.content ?? "")) {
			if (segment.type === "artifact" && segment.op.closed) closed.add(segment.op.identifier);
		}
		return [...byCall.values()].filter((d) => !d.identifier || !closed.has(d.identifier));
	});

	// Auto-open the panel for a draft too, so a streamed-arguments preview is
	// visible before the call completes.
	$effect(() => {
		if (!loading) return;
		for (const draft of artifactDrafts) {
			if (!draft.identifier) continue;
			const known = artifactRegistry.artifacts.get(draft.identifier)?.versions.length ?? 0;
			sidePane.maybeAutoOpen(draft.identifier, known + 1);
		}
	});

	// Trackio dashboards a training run printed into its job logs, read back out
	// of the tool results on the messages. Derived like the artifact registry, so
	// reopening the conversation finds the same dashboards.
	let trackioDashboards = $derived(collectTrackioDashboards(messages));

	// File artifacts: every persisted run output — tool runs, code blocks,
	// artifact cells — folded into versioned entries by filename. Derived from
	// the same messages (the loader serves stored block and cell files on
	// them), plus the records this tab made since it loaded, so a file becomes
	// an artifact as soon as its upload lands. Records the loader already
	// served are skipped, so a file is never a version twice.
	let fileRegistry = $derived(collectFileArtifacts(withLiveRunFiles(messages, runFiles.all)));

	// One ordered list of everything the pane can show, so its next/previous walks
	// artifacts and dashboards together instead of each view navigating only its
	// own kind.
	let paneItems = $derived(
		collectPaneItems(messages, artifactRegistry, trackioDashboards, fileRegistry)
	);

	let pastedLongContent = $state(false);

	// Voice recording state
	let isRecording = $state(false);
	let isTranscribing = $state(false);
	let transcriptionEnabled = $derived(
		!!(page.data as { transcriptionEnabled?: boolean }).transcriptionEnabled
	);
	let isTouchDevice = $derived(browser && navigator.maxTouchPoints > 0);

	const handleSubmit = () => {
		if (requireAuthUser() || loading || !draft) return;
		tap();
		column?.notifySend();
		onmessage?.(draft);
		draft = "";
	};

	// A failed fresh send puts its text back in the box (the page sets
	// sendFailedText in the failure path; retries never set it — their
	// content already lives in the thread). Consumed once: if the person
	// typed something new in the meantime, that newer text wins and the
	// failed one stays retrievable from the thread's retry.
	$effect(() => {
		if (!sendFailedText) return;
		if (!draft) draft = sendFailedText;
		sendFailedText = null;
	});

	const drag = new FileDrag();

	const onPaste = (e: ClipboardEvent) => {
		const pasted = pastedAttachments(e.clipboardData, {
			mimeTypes: activeMimeTypes,
			directPaste: $settings.directPaste,
		});
		if (pasted.preventDefault) e.preventDefault();
		if (pasted.longText) {
			pastedLongContent = true;
			setTimeout(() => {
				pastedLongContent = false;
			}, 1000);
		}
		if (pasted.files.length) files = [...files, ...pasted.files];
	};

	let lastMessage = $derived(browser && (messages.at(-1) as Message));
	let showPendingPlaceholder = $derived(
		shouldShowPendingPlaceholder({ pending, resuming, lastMessage: lastMessage || undefined })
	);
	let streamingAssistantMessage = $derived(
		(() => {
			for (let i = messages.length - 1; i >= 0; i -= 1) {
				const candidate = messages[i];
				if (candidate.from === "assistant") {
					return candidate;
				}
			}
			return undefined;
		})()
	);

	let lastIsError = $derived(
		!loading &&
			(streamingAssistantMessage?.updates?.findIndex(
				(u) => u.type === "status" && u.status === "error"
			) ?? -1) !== -1
	);

	// Preview "ask to fix" buttons (artifact panel footer, fullscreen preview
	// modals) send their message directly instead of prefilling the composer.
	// Bypasses the draft on purpose: a half-typed message must survive the click.
	let canSendFix = $derived(!isReadOnly && !lastIsError);
	function sendFixRequest(text: string): boolean {
		if (requireAuthUser() || loading) return false;
		tap();
		column?.notifySend();
		// Queued attachments belong to the user's next message, not to this
		// machine-composed one. The send handler snapshots the bound `files`
		// synchronously before its first await, so emptying around the call is
		// enough to keep them out of the request — and it skips clearing them
		// post-send when it consumed none (see writeMessage), so the restored
		// queue survives.
		const queuedFiles = files;
		files = [];
		try {
			onmessage?.(text);
		} finally {
			files = queuedFiles;
		}
		return true;
	}

	// Set after every $derived it reads. The server compiler emits a derived
	// read inside a getter as `return`, a pure-call annotation comment, a
	// newline and the call when the derived is declared further down, and the
	// newline after `return` is ASI: the getter returned undefined, so a reload
	// (SSR) of any conversation with run files 500'd in FileArtifactCard.
	// Never spell that annotation out in a comment here: the bundler reads it
	// in ANY comment and deletes the call that follows as side-effect free,
	// which removed this very call from the v0.18.2 build (no artifacts
	// context: plain file cards, unlinked artifacts). A test guards it.
	setArtifactsContext({
		get registry() {
			return artifactRegistry;
		},
		get fileRegistry() {
			return fileRegistry;
		},
		panel: sidePane,
		// Deep consumers (e.g. the code-block preview modal) can't render a
		// meaningful disabled state, so streaming also gates availability here;
		// the panel gets the handler as a prop and disables on `loading` itself.
		get requestFix() {
			return canSendFix && !loading ? sendFixRequest : undefined;
		},
	});

	// Expose currently running tool call name (if any) from the streaming assistant message
	const availableTools: ToolFront[] = $derived.by(
		() => (page.data as { tools?: ToolFront[] } | undefined)?.tools ?? []
	);
	let streamingToolCallName = $derived.by(() => {
		const updates = streamingAssistantMessage?.updates ?? [];
		if (!updates.length) return null;
		const done = new Set<string>();
		for (const u of updates) {
			if (isMessageToolResultUpdate(u) || isMessageToolErrorUpdate(u)) done.add(u.uuid);
		}
		for (let i = updates.length - 1; i >= 0; i -= 1) {
			const u = updates[i];
			if (isMessageToolCallUpdate(u) && !done.has(u.uuid)) {
				return u.call.name;
			}
		}
		return null;
	});
	onDestroy(() => {
		exportConversationStore.reset();
	});

	let column: ChatMessageColumn | undefined = $state();

	// Conversation switch also resets the artifact panel. This used to
	// piggyback on a first-message-id heuristic that misfired when the first
	// message was edited; the route param is the real signal.
	let prevConversationKey = page.params?.id;
	$effect(() => {
		const key = page.params?.id;
		if (key !== prevConversationKey) {
			prevConversationKey = key;
			sidePane.reset();
		}
	});

	// Open the newest dashboard the first time it shows up: the point of the run
	// is watching it train. Once per URL, so the user can close it and read the
	// chat while the run continues.
	//
	// Declared after the conversation-switch effect: a conversation -> conversation
	// navigation can deliver the new messages and the new route param in one flush,
	// and effects run in declaration order. Above the reset, this would open the destination's
	// dashboard and record its key, then reset() would close the pane and clear
	// that key -- and nothing would re-run this, so the dashboard would never open.
	//
	// Gated like the other two auto-opens rather than firing on presence. `loading`
	// is what makes this "a run is happening now": without it, every hard load of
	// any conversation that ever trained something re-opens the pane, because
	// reset() clears the once-per-URL keys on each switch — framing a Space that
	// went to sleep months ago. Desktop-only: on mobile the pane is a fullscreen
	// overlay that would cover the chat.
	$effect(() => {
		const latest = trackioDashboards.at(-1);
		if (!latest || !loading) return;
		// A dashboard named before it exists (create_trackio) is not framable until
		// the run reaches trackio.init; opening it early frames a 404.
		if (latest.spaceId && trackioStatus.status(latest.url) !== "live") return;
		if (!window.matchMedia("(min-width: 768px)").matches) return;
		sidePane.maybeAutoOpenTrackio(latest.url, latest.label);
	});

	const settings = useSettingsStore();
	// Per-model settings are the base's: a custom model inherits every knob.
	let settingsKey = $derived(settingsModelId(currentModel));

	// Respect per‑model multimodal toggle from settings (force enable)
	let modelIsMultimodalOverride = $derived($settings.multimodalOverrides?.[settingsKey]);
	let modelIsMultimodal = $derived((modelIsMultimodalOverride ?? currentModel.multimodal) === true);

	// Always allow common text-like files; add images only when model is multimodal
	import {
		TEXT_MIME_ALLOWLIST,
		IMAGE_MIME_ALLOWLIST_DEFAULT,
		DOCUMENT_MIME_ALLOWLIST,
	} from "$lib/constants/mime";

	let activeMimeTypes = $derived(
		Array.from(
			new Set([
				...TEXT_MIME_ALLOWLIST,
				// Documents whatever the model is: it never sees the bytes, only
				// the text the gateway's extractor read out of them.
				...DOCUMENT_MIME_ALLOWLIST,
				...(modelIsMultimodal
					? (currentModel.multimodalAcceptedMimetypes ?? [...IMAGE_MIME_ALLOWLIST_DEFAULT])
					: []),
			])
		)
	);
	let isFileUploadEnabled = $derived(activeMimeTypes.length > 0);
	let focused = $state(false);

	const convsStore = useConversationsStore();

	// ── The composer's model/effort pill (ModelEffortPicker) ──────────────
	let pickerModels = $derived(
		models
			.filter((m) => !m.unlisted)
			.map((m) => ({
				id: m.id,
				name: m.displayName ?? m.id,
				description: m.description,
				baseName: m.customBase?.displayName,
			}))
	);
	let recentIds = $state<string[]>([]);
	$effect(() => {
		recentIds = readRecent(globalThis.localStorage);
	});
	let modelThinks = $derived(
		$settings.reasoningOverrides?.[settingsKey] ?? currentModel.supportsReasoning ?? false
	);
	let effortLevels = $derived(modelThinks ? ["low", "medium", "high"] : null);
	// The conversation's choice, as the page loaded it and as picked since.
	let pickedEffort = $state<{ value: "low" | "medium" | "high" | null } | null>(null);
	$effect(() => {
		void page.params?.id;
		pickedEffort = null;
	});
	let shownEffort = $derived(
		chatEffort({
			conversation: pickedEffort ? (pickedEffort.value ?? undefined) : conversationEffort,
			userDefault: $settings.reasoningEffortOverrides?.[settingsKey],
		})
	);

	function rememberModel(id: string) {
		recentIds = withRecent(recentIds, id);
		globalThis.localStorage?.setItem(RECENT_MODELS_KEY, JSON.stringify(recentIds));
	}

	async function pickModel(id: string) {
		if (requireAuthUser()) return;
		rememberModel(id);
		const convId = page.params?.id;
		if (!convId) {
			settings.instantSet({ activeModel: id });
			return;
		}
		const response = await fetch(`${base}/conversation/${convId}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ model: id }),
		});
		if (!response.ok) {
			error.set(m["chat.window.switch_failed"]());
			return;
		}
		await Promise.all([safeInvalidate(UrlDependency.Conversation), convsStore.refresh()]);
	}

	/** In a conversation, effort is that conversation's; on a new chat it is
	 * the person's default for this model, which new chats start from. */
	async function pickEffort(level: string | undefined) {
		if (requireAuthUser()) return;
		const value = (level ?? null) as "low" | "medium" | "high" | null;
		const convId = page.params?.id;
		if (!convId) {
			const next = { ...($settings.reasoningEffortOverrides ?? {}) };
			if (value === null) delete next[settingsKey];
			else next[settingsKey] = value;
			settings.instantSet({ reasoningEffortOverrides: next });
			return;
		}
		const response = await fetch(`${base}/conversation/${convId}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ reasoningEffort: value }),
		});
		if (!response.ok) {
			error.set(m["chat.window.effort_failed"]());
			return;
		}
		pickedEffort = { value };
	}
	// Below `sm`, the composer's stop/mic/send controls stay pinned over its
	// bottom-right corner (unchanged from `fix/mobile-composer`); at `sm`
	// and up they render inline instead, right after the toolbar row's pill
	// group, since that pin only ever lined up with the row by coincidence
	// (brief item 2 — see the composer markup below for the long version).
	const narrowViewport = new MediaQuery("(max-width: 639px)");
	// Composer content queued from outside (e.g. an annotated artifact
	// screenshot plus its notes), consumed and cleared on arrival: files use
	// the same accept rules as paste, text appends to the editable draft
	$effect(() => {
		const pending = $pendingComposerPayload;
		if (!pending) return;
		const accepted = (pending.files ?? []).filter((file) =>
			mimeMatchesAllowlist(file.type, activeMimeTypes)
		);
		if (accepted.length) {
			files = [...untrack(() => files), ...accepted];
		}
		if (pending.text) {
			const currentDraft = untrack(() => draft);
			draft = currentDraft.trim() ? `${currentDraft}\n\n${pending.text}` : pending.text;
		}
		pendingComposerPayload.set(undefined);
	});

	async function handleRecordingConfirm(audioBlob: Blob) {
		isRecording = false;
		isTranscribing = true;

		try {
			const response = await fetch(`${base}/api/transcribe`, {
				method: "POST",
				headers: { "Content-Type": audioBlob.type },
				body: audioBlob,
			});

			if (!response.ok) {
				throw new Error(await response.text());
			}

			const { text } = await response.json();
			const trimmedText = text?.trim();
			if (trimmedText) {
				// Append transcribed text to draft
				draft = draft.trim() ? `${draft.trim()} ${trimmedText}` : trimmedText;
			}
		} catch (err) {
			console.error("Could not turn your voice into text:", err);
			$error = m["chat.window.voice_failed"]();
		} finally {
			isTranscribing = false;
		}
	}

	async function handleRecordingSend(audioBlob: Blob) {
		isRecording = false;
		isTranscribing = true;

		try {
			const response = await fetch(`${base}/api/transcribe`, {
				method: "POST",
				headers: { "Content-Type": audioBlob.type },
				body: audioBlob,
			});

			if (!response.ok) {
				throw new Error(await response.text());
			}

			const { text } = await response.json();
			const trimmedText = text?.trim();
			if (trimmedText) {
				// Set draft and send immediately
				draft = draft.trim() ? `${draft.trim()} ${trimmedText}` : trimmedText;
				handleSubmit();
			}
		} catch (err) {
			console.error("Could not turn your voice into text:", err);
			$error = m["chat.window.voice_failed"]();
		} finally {
			isTranscribing = false;
		}
	}

	function handleRecordingError(message: string) {
		console.error("Recording problem:", message);
		isRecording = false;
		$error = message;
	}
</script>

<svelte:window
	ondragenter={drag.enter}
	ondragleave={drag.leave}
	ondragover={(e) => {
		e.preventDefault();
	}}
	ondrop={(e) => {
		e.preventDefault();
		drag.active = false;
	}}
/>

<!-- pointer-events-none: the chat column sits at z-[-1]; this wrapper's
     hit-area would otherwise swallow every click meant for it. Children
     re-enable pointer events themselves. -->
<div class="pointer-events-none relative flex min-h-0 min-w-0">
	<ChatMessageColumn
		{messages}
		{messagesAlternatives}
		{loading}
		{pending}
		readOnly={isReadOnly}
		showPlaceholder={showPendingPlaceholder}
		conversationKey={page.params?.id}
		{onretry}
		{onshowAlternateMsg}
		bind:this={column}
	>
		{#snippet overlay()}
			{#if canExport}
				<!-- Lives in the chat column (not the layout) so it stays visible when
				     the artifact panel is open. The export button used to sit here;
				     it moved into the artifacts pane and this menu button opens it. -->
				<div
					class="pointer-events-auto hidden md:absolute md:top-5 md:right-6 md:z-10 md:flex md:items-center md:gap-2"
				>
					{#if canExport}
						<button
							type="button"
							class="flex size-8 items-center justify-center gap-2 rounded-xl border border-gray-200 bg-white/90 text-sm font-medium text-gray-700 shadow-xs hover:bg-white/60 hover:text-gray-500 dark:border-gray-700 dark:bg-gray-800/80 dark:text-gray-200 dark:hover:bg-gray-700"
							onclick={() => sidePane.toggleLibrary()}
							aria-label={m["app.mobile_nav.open_files"]()}
							title={m["app.mobile_nav.files_title"]()}
						>
							<CarbonSidePanelOpen />
						</button>
					{/if}
				</div>
			{/if}
			{#if featureAnnouncement && showFeatureAnnouncement}
				<FeatureAnnouncementToast announcement={featureAnnouncement} />
			{/if}
		{/snippet}
		{#snippet head()}
			{#if preprompt && preprompt != currentModel.preprompt}
				<SystemPromptModal preprompt={preprompt ?? ""} />
			{/if}
		{/snippet}
		{#snippet introduction()}
			<ChatIntroduction
				{currentModel}
				onmessage={(content) => {
					onmessage?.(content);
				}}
			/>
		{/snippet}
		{#snippet tail()}
			{#if isReadOnly}
				<ModelSwitch {models} {currentModel} />
			{/if}
		{/snippet}
		{#snippet composer()}
			<ComposerFileChips bind:files hidden={loading} />

			<div class="w-full">
				{#if askQuestion}
					<AskQuestion conversationId={askQuestion.conversationId} request={askQuestion.request} />
				{/if}
				<div class="flex w-full gap-2 *:mb-3">
					{#if !loading && lastIsError}
						<RetryBtn
							classNames="ml-auto"
							onClick={() => {
								if (lastMessage && lastMessage.ancestors) {
									onretry?.({
										id: lastMessage.id,
									});
								}
							}}
						/>
					{/if}
				</div>
				<form
					tabindex="-1"
					aria-label={isFileUploadEnabled ? m["chat.window.dropzone"]() : undefined}
					onsubmit={(e) => {
						e.preventDefault();
						handleSubmit();
					}}
					class={{
						"relative flex w-full max-w-4xl flex-1 flex-col rounded-xl border bg-surface shadow-sm focus-within:border-accent/40 dark:border-gray-700 dark:bg-raised": true,
						"opacity-30": isReadOnly,
						"max-sm:mb-4": focused && isVirtualKeyboard(),
					}}
					style:--composer-actions-width={narrowViewport.current
						? transcriptionEnabled && !loading
							? "84px"
							: "44px"
						: "120px"}
				>
					<!-- The pill row's own width cap (ChatInput.svelte) reserves
					     this much for whatever trailingActions renders. Below `sm`
					     that is unchanged (send is pinned outside this row
					     entirely; the mic button when shown adds to the reserve).
					     At `sm` and up, trailingActions now also carries the
					     mic/send controls inline (item 2) — too little room here
					     let the pill row grow wide enough to sit under them. -->
					<div class="flex w-full items-center">
						{#if isRecording || isTranscribing}
							<VoiceRecorder
								{isTranscribing}
								{isTouchDevice}
								oncancel={() => {
									isRecording = false;
								}}
								onconfirm={handleRecordingConfirm}
								onsend={handleRecordingSend}
								onerror={handleRecordingError}
							/>
						{:else if drag.active && isFileUploadEnabled}
							<FileDropzone bind:files bind:onDrag={drag.active} mimeTypes={activeMimeTypes} />
						{:else}
							<div
								class="flex w-full flex-1 rounded-xl border-none bg-transparent"
								class:paste-glow={pastedLongContent}
							>
								{#if lastIsError}
									<ChatInput value={m["chat.window.error_reply"]()} disabled={true} />
								{:else}
									<ChatInput
										placeholder={isReadOnly ? m["chat.window.read_only"]() : m["chat.window.ask"]()}
										{loading}
										bind:value={draft}
										{draftKey}
										bind:files
										bind:knowledgeBases
										bind:webSearch
										bind:autoApproveTools
										mimeTypes={activeMimeTypes}
										onsubmit={handleSubmit}
										{onPaste}
										disabled={isReadOnly || lastIsError}
										{modelIsMultimodal}
										bind:focused
									>
										{#snippet trailingActions()}
											<!-- Desktop only (see `trailingControls`'s own comment):
											     the error-state ChatInput above has no pill row to
											     wrap, so its pinned corner button is never at risk
											     of drifting from it — only this one is. -->
											{#if !narrowViewport.current}
												{@render trailingControls(false)}
											{/if}
										{/snippet}
									</ChatInput>
								{/if}

								{#if narrowViewport.current || lastIsError}
									{@render trailingControls(true)}
								{/if}
							</div>
						{/if}
					</div>
				</form>

				{#snippet trailingControls(pinned: boolean)}
					<!-- Below `sm` (and always in the error state, which has no pill
					     row to wrap and so no drift to risk), these stay pinned over
					     the composer's bottom-right corner, exactly as
					     `fix/mobile-composer` left them. At `sm` and up they render
					     as ordinary flex siblings after the toolbar row's pill group
					     instead: the pin only ever lined up with that row by
					     coincidence, and stranded below it as soon as the pill row
					     wrapped to a second line or grew for any other reason (brief
					     item 2). -->
					{#if loading}
						<StopGeneratingBtn
							onClick={() => {
								hapticError();
								onstop?.();
							}}
							showBorder={true}
							classNames="{pinned
								? 'absolute right-2 bottom-2 size-8'
								: 'size-7'} self-end rounded-full border bg-white text-black shadow-sm transition-none dark:border-transparent dark:bg-gray-600 dark:text-white"
						/>
					{:else}
						{#if transcriptionEnabled}
							<button
								type="button"
								class="{pinned
									? 'absolute right-10 bottom-2 mr-1.5 size-8'
									: 'size-7'} btn self-end rounded-full border bg-white/50 text-gray-500 transition-none hover:bg-gray-50 hover:text-gray-700 dark:border-transparent dark:bg-gray-600/50 dark:text-gray-300 dark:hover:bg-gray-500 dark:hover:text-white"
								disabled={isReadOnly}
								onclick={() => {
									isRecording = true;
								}}
								aria-label={m["chat.window.record"]()}
							>
								<IconMic class="size-4" />
							</button>
						{/if}
						<button
							class="{pinned
								? 'absolute right-2 bottom-2 size-8'
								: 'size-7'} btn self-end rounded-full border bg-white text-black shadow transition-none enabled:hover:bg-white enabled:hover:shadow-inner dark:border-transparent dark:bg-gray-600 dark:text-white dark:hover:enabled:bg-black {!draft ||
							isReadOnly
								? ''
								: 'bg-accent-solid! text-white! focus:ring-offset-2 focus:ring-offset-surface enabled:hover:bg-accent-solid-hover!'}"
							disabled={!draft || isReadOnly}
							type="submit"
							aria-label={m["chat.window.send"]()}
							name="submit"
						>
							<IconArrowUp />
						</button>
					{/if}
				{/snippet}
				<div
					class={{
						"mt-1.5 flex h-5 items-center self-stretch px-0.5 text-xs whitespace-nowrap text-ink-faint max-md:mb-2 max-sm:gap-2": true,
						"max-sm:hidden": focused && isVirtualKeyboard(),
					}}
				>
					{#if models.find((m) => m.id === currentModel.id)}
						{#if loading && streamingToolCallName}
							<span class="inline-flex items-center gap-1 text-xs whitespace-nowrap">
								<LucideHammer class="size-3" />
								{m["chat.window.using_tool"]()}
								<span class="loading-dots font-medium">
									{availableTools.find((t) => t.name === streamingToolCallName)?.displayName ??
										streamingToolCallName}
								</span>
							</span>
						{:else}
							<!-- Opens the picker, not the Models dialog. This control draws a
							     caret and sits under the composer, so it reads as "change what
							     this chat runs on" — which is what it now does. The Models
							     dialog is a management surface: it sets the *default* and edits
							     per-model settings, so reaching it from here meant the only way
							     to move one conversation was to change every future one. -->
							<ModelEffortPicker
								models={pickerModels}
								currentId={currentModel.id}
								{recentIds}
								efforts={effortLevels}
								effort={shownEffort}
								onpickModel={pickModel}
								onpickEffort={pickEffort}
								onmore={() => {
									if (requireAuthUser()) return;
									pickerOpen = true;
								}}
							>
								<span class="shrink-0">{m["chat.window.model"]()}</span>
								{#if currentModel.logoUrl}
									<img
										src={currentModel.logoUrl}
										alt=""
										class="size-3 flex-none rounded-sm border bg-white dark:border-gray-700"
									/>
								{/if}
								<span class="truncate">{modelLabel(currentModel)}</span>
							</ModelEffortPicker>
						{/if}
					{:else}
						<span class="inline-flex items-center line-through dark:border-gray-700">
							{currentModel.id}
						</span>
					{/if}
					{#if !messages.length && !loading}
						<span class="max-sm:hidden"
							>{publicConfig.PUBLIC_CAVEAT || m["chat.window.caveat"]()}</span
						>
					{/if}
				</div>
			</div>
		{/snippet}
	</ChatMessageColumn>

	<ArtifactPanel
		registry={artifactRegistry}
		{fileRegistry}
		items={paneItems}
		{loading}
		drafts={artifactDrafts}
		canScreenshot={!isReadOnly && mimeMatchesAllowlist("image/png", activeMimeTypes)}
		canPersistFiles={!isReadOnly}
		onsend={canSendFix ? sendFixRequest : undefined}
	/>
	<PreviewPane onsend={canSendFix ? sendFixRequest : undefined} />
	<TrackioPane items={paneItems} />
	<DeliverablesPanel items={paneItems} registry={artifactRegistry} {fileRegistry} />
</div>

<!-- Outside the composer's wrapper on purpose: that subtree is
     `pointer-events-none` with its own stacking, and a dialog rendered
     inside it inherits both. Modal portals anyway, but mounting it here
     keeps the reason visible. -->
{#if pickerOpen}
	<ModelPicker {models} {currentModel} onclose={() => (pickerOpen = false)} />
{/if}

<style>
	.paste-glow {
		animation: glow 1s cubic-bezier(0.4, 0, 0.2, 1) forwards;
		will-change: box-shadow;
	}

	@keyframes glow {
		0% {
			box-shadow: 0 0 0 0 rgba(59, 130, 246, 0.8);
		}
		50% {
			box-shadow: 0 0 20px 4px rgba(59, 130, 246, 0.6);
		}
		100% {
			box-shadow: 0 0 0 0 rgba(59, 130, 246, 0);
		}
	}

	.loading-dots::after {
		content: "";
		animation: dots-content 0.9s steps(1, end) infinite;
	}
	@keyframes dots-content {
		0% {
			content: "";
		}
		33% {
			content: ".";
		}
		66% {
			content: "..";
		}
		88% {
			content: "...";
		}
	}
</style>
