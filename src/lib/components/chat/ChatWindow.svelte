<script lang="ts">
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

	import IconOmni from "$lib/components/icons/IconOmni.svelte";
	import IconCheap from "$lib/components/icons/IconCheap.svelte";
	import IconFast from "$lib/components/icons/IconFast.svelte";
	import { PROVIDERS_HUB_ORGS } from "@huggingface/inference";
	import CarbonDirectionRight from "~icons/carbon/direction-right-01";
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
	import ResumeBtn from "../ResumeBtn.svelte";
	import {
		buildResumeMessage,
		canResumeAfterFailure,
		failureDetailOf,
	} from "$lib/utils/resumeAfterFailure";
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
	import ShareConversationModal from "../ShareConversationModal.svelte";
	import ChatIntroduction from "./ChatIntroduction.svelte";
	import ComposerFileChips from "./ComposerFileChips.svelte";
	import { FileDrag } from "$lib/utils/fileDrag.svelte";
	import { pastedAttachments } from "$lib/utils/composerFiles";
	import { chatDraftKey } from "$lib/utils/composerDraft";
	import { useSettingsStore } from "$lib/stores/settings";
	import { error } from "$lib/stores/errors";
	import ModelSwitch from "./ModelSwitch.svelte";
	import ModelPicker from "./ModelPicker.svelte";
	import { routerExamples } from "$lib/constants/routerExamples";
	import { mcpExamples } from "$lib/constants/mcpExamples";
	import type { RouterFollowUp, RouterExample } from "$lib/constants/routerExamples";
	import { allBaseServersEnabled, mcpServersLoaded } from "$lib/stores/mcpServers";
	import { shareModal } from "$lib/stores/shareModal";
	import { exportConversation as exportConversationStore } from "$lib/stores/exportConversation";
	import IconShare from "$lib/components/icons/IconShare.svelte";
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
	import LucideSparkles from "~icons/lucide/sparkles";
	import MlAssistantStrip from "./MlAssistantStrip.svelte";
	import { ML_ASSISTANT_MODE } from "$lib/utils/mlAssistantFlag";
	import { mlAssistant } from "$lib/stores/mlAssistant.svelte";
	import MlInternSpotlight from "./MlInternSpotlight.svelte";
	import { useConversationsStore } from "$lib/stores/conversations.svelte";
	import { MediaQuery } from "svelte/reactivity";
	import { planStepsToMlSteps } from "$lib/utils/planProgress";
	import type { PlanState } from "$lib/types/Plan";
	import type { MlBudget } from "$lib/types/Conversation";
	import { reservedMicroUsd, usdToMicroUsd } from "$lib/utils/mlBudget";
	import { handleResponse, useAPIClient } from "$lib/APIClient";
	import {
		ML_ASSISTANT_EFFORT,
		ML_ASSISTANT_PLACEHOLDER,
		mlAssistantExamples,
	} from "$lib/constants/mlAssistant";

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
		shared?: boolean;
		currentModel: Model;
		models: Model[];
		preprompt?: string | undefined;
		files?: File[];
		onmessage?: (content: string) => void;
		onstop?: () => void;
		onretry?: (payload: { id: Message["id"]; content?: string }) => void;
		onshowAlternateMsg?: (payload: { id: Message["id"] }) => void;
		draft?: string;
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
		shared = false,
		currentModel,
		models,
		preprompt = undefined,
		files = $bindable([]),
		draft = $bindable(""),
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
	let canShare = $derived(
		publicConfig.isHuggingChat &&
			Boolean(page.params?.id) &&
			page.route.id?.startsWith("/conversation/")
	);
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
			model: currentModel.displayName,
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

	let shareModalOpen = $state(false);
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
		// Latches the mode onto the conversation, so the strip stays and swaps its
		// tool note for the plan progress row. No-op when the mode is off.
		mlAssistant.startTask();
		onmessage?.(draft);
		draft = "";
	};

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
	let streamingRouterMetadata = $derived(streamingAssistantMessage?.routerMetadata ?? null);
	let streamingRouterModelName = $derived(
		streamingRouterMetadata?.model
			? (streamingRouterMetadata.model.split("/").pop() ?? streamingRouterMetadata.model)
			: ""
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
	let showRouterDetails = $state(false);
	let routerDetailsTimeout: ReturnType<typeof setTimeout> | undefined;

	$effect(() => {
		if (!currentModel.isRouter || !loading) {
			showRouterDetails = false;
			if (routerDetailsTimeout) {
				clearTimeout(routerDetailsTimeout);
				routerDetailsTimeout = undefined;
			}
			return;
		}

		if (routerDetailsTimeout) {
			clearTimeout(routerDetailsTimeout);
		}

		showRouterDetails = false;
		routerDetailsTimeout = setTimeout(() => {
			showRouterDetails = true;
		}, 500);
	});

	const unsubscribeShareModal = shareModal.subscribe((value) => {
		shareModalOpen = value;
	});

	onDestroy(() => {
		unsubscribeShareModal();
		shareModal.close();
		exportConversationStore.reset();
		if (routerDetailsTimeout) {
			clearTimeout(routerDetailsTimeout);
		}
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
	// Declared after the conversation-switch effect for the same reason the shared
	// artifact open below is: a conversation -> conversation navigation can deliver
	// the new messages and the new route param in one flush, and effects run in
	// declaration order. Above the reset, this would open the destination's
	// dashboard and record its key, then reset() would close the pane and clear
	// that key -- and nothing would re-run this, so the dashboard would never open.
	//
	// Gated like the other two auto-opens rather than firing on presence. `loading`
	// is what makes this "a run is happening now": without it, every hard load of
	// any conversation that ever trained something re-opens the pane, because
	// reset() clears the once-per-URL keys on each switch — framing a Space that
	// went to sleep months ago. Desktop-only for the reason the shared-artifact
	// open below is: on mobile the pane is a fullscreen overlay, and a shared
	// conversation carries its tool results verbatim, so every viewer on a phone
	// would arrive with the chat covered.
	$effect(() => {
		const latest = trackioDashboards.at(-1);
		if (!latest || !loading) return;
		// A dashboard named before it exists (create_trackio) is not framable until
		// the run reaches trackio.init; opening it early frames a 404.
		if (latest.spaceId && trackioStatus.status(latest.url) !== "live") return;
		if (!window.matchMedia("(min-width: 768px)").matches) return;
		sidePane.maybeAutoOpenTrackio(latest.url, latest.label);
	});

	// Shared conversations containing artifacts usually exist to show one off:
	// open the most recent artifact on load. Desktop only, since on mobile the
	// panel is a fullscreen overlay that would hide the conversation entirely.
	// Declared after the conversation-switch effect so its reset() can never
	// close the panel after this opens it within the same flush.
	let autoOpenedSharedArtifact = false;
	$effect(() => {
		if (autoOpenedSharedArtifact || !shared) return;
		const latest = [...artifactRegistry.artifacts.values()].at(-1);
		if (!latest) return;
		autoOpenedSharedArtifact = true;
		if (!window.matchMedia("(min-width: 768px)").matches) return;
		sidePane.openArtifact(latest.identifier, null);
	});

	const settings = useSettingsStore();
	let hideRouterExamples = $derived($settings.hidePromptExamples?.[currentModel.id] ?? false);

	// Respect per‑model multimodal toggle from settings (force enable)
	let modelIsMultimodalOverride = $derived($settings.multimodalOverrides?.[currentModel.id]);
	let modelIsMultimodal = $derived((modelIsMultimodalOverride ?? currentModel.multimodal) === true);

	// Determine tool support for the current model (server-provided capability with user override)
	let modelSupportsTools = $derived(
		($settings.toolsOverrides?.[currentModel.id] ??
			(currentModel as unknown as { supportsTools?: boolean }).supportsTools) === true
	);

	// Get provider override for the current model (HuggingChat only)
	let providerOverride = $derived($settings.providerOverrides?.[currentModel.id]);
	let hasProviderOverride = $derived(
		providerOverride && providerOverride !== "auto" && !currentModel.isRouter
	);

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

	// --- ML Assistant mode (build flag, see $lib/utils/mlAssistantFlag) --------

	let mlModeOn = $derived(ML_ASSISTANT_MODE && mlAssistant.enabled);
	let mlTaskRunning = $derived(ML_ASSISTANT_MODE && mlAssistant.taskStarted);
	// Resume beats Retry for a failed agentic turn: retry re-runs the whole turn
	// (duplicating jobs and repos already created), resume continues past the
	// preserved transcript. ML mode only — elsewhere turns rarely carry work
	// worth saving — and only when the turn did something (see the util).
	let canResumeTurn = $derived(
		mlModeOn && !loading && lastIsError && !!lastMessage && canResumeAfterFailure(lastMessage)
	);
	function sendResumeMessage() {
		if (!lastMessage) return;
		sendFixRequest(buildResumeMessage(failureDetailOf(lastMessage)));
	}
	// The strip is a task status bar only: it slides in on the send that starts an
	// ML task and stays for the rest of the conversation. Before that the mode
	// lives in the composer pill, and a chat started without the mode never shows
	// either surface.
	let mlStripVisible = $derived(ML_ASSISTANT_MODE && mlTaskRunning);

	// The pill is the mode's pre-task switch. Empty conversations only — the mode
	// cannot be joined once a chat has started without it.
	// With no set configured the send would fail; no switch is better than a
	// dead end.
	let mlModelSet = $derived(
		ML_ASSISTANT_MODE
			? ((page.data as { mlAssistantModels?: string[] }).mlAssistantModels ?? [])
			: []
	);
	let mlPillVisible = $derived(
		ML_ASSISTANT_MODE &&
			!shared &&
			!isReadOnly &&
			!mlTaskRunning &&
			messages.length === 0 &&
			mlModelSet.length > 0
	);

	// ML Intern launch card under the home-screen logo (HuggingChat only). Temporary,
	// so its dismissal lives in localStorage rather than in a settings field. Off on
	// short viewports, and while the recorder replaces the composer: the pill (and
	// with it the first-run onboarding its CTA relies on) is unmounted then.
	const convsStore = useConversationsStore();

	// ── The composer's model/effort pill (ModelEffortPicker) ──────────────
	let pickerModels = $derived(
		models
			.filter((m) => !m.unlisted)
			.map((m) => ({ id: m.id, name: m.displayName ?? m.id, description: m.description }))
	);
	let recentIds = $state<string[]>([]);
	$effect(() => {
		recentIds = readRecent(globalThis.localStorage);
	});
	let modelThinks = $derived(
		$settings.reasoningOverrides?.[currentModel.id] ?? currentModel.supportsReasoning ?? false
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
			preset: mlModeOn ? ML_ASSISTANT_EFFORT : undefined,
			conversation: pickedEffort ? (pickedEffort.value ?? undefined) : conversationEffort,
			userDefault: $settings.reasoningEffortOverrides?.[currentModel.id],
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
			error.set("Could not switch model");
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
			if (value === null) delete next[currentModel.id];
			else next[currentModel.id] = value;
			settings.instantSet({ reasoningEffortOverrides: next });
			return;
		}
		const response = await fetch(`${base}/conversation/${convId}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ reasoningEffort: value }),
		});
		if (!response.ok) {
			error.set("Could not change the effort");
			return;
		}
		pickedEffort = { value };
	}
	const shortViewport = new MediaQuery("(max-height: 560px)");
	// Below `sm`, the composer's stop/mic/send controls stay pinned over its
	// bottom-right corner (unchanged from `fix/mobile-composer`); at `sm`
	// and up they render inline instead, right after the toolbar row's pill
	// group, since that pin only ever lined up with the row by coincidence
	// (brief item 2 — see the composer markup below for the long version).
	const narrowViewport = new MediaQuery("(max-width: 639px)");
	const ML_SPOTLIGHT_KEY = "mlInternSpotlightDismissed";
	// Hidden until the browser has been asked, so SSR and hydration agree.
	let mlSpotlightDismissed = $state(true);
	$effect(() => {
		mlSpotlightDismissed = localStorage.getItem(ML_SPOTLIGHT_KEY) === "1";
	});
	let mlSpotlightVisible = $derived(
		publicConfig.isHuggingChat &&
			mlPillVisible &&
			page.route.id === "/" &&
			!mlAssistant.enabled &&
			!mlSpotlightDismissed &&
			!shortViewport.current &&
			!isRecording &&
			!isTranscribing &&
			!convsStore.list.some((conv) => conv.mlAssistant)
	);

	function dismissMlSpotlight() {
		mlSpotlightDismissed = true;
		localStorage.setItem(ML_SPOTLIGHT_KEY, "1");
	}

	/** The card's CTA: switches the mode on, as the pill would, and retires the card. */
	function tryMlIntern() {
		if (requireAuthUser()) return;
		mlAssistant.toggle(true);
		dismissMlSpotlight();
	}
	// A mode conversation whose model left the set can only move within the set.
	let switchableModels = $derived(
		mlTaskRunning ? models.filter((m) => mlModelSet.includes(m.id)) : models
	);

	$effect(() => {
		if (!ML_ASSISTANT_MODE) return;
		const conversationId = page.params?.id;
		const {
			mlAssistant: startedInMlMode,
			plan,
			mlBudget,
		} = page.data as {
			mlAssistant?: boolean;
			plan?: PlanState;
			mlBudget?: MlBudget;
		};
		untrack(() => {
			const reset = mlAssistant.syncConversation(conversationId, Boolean(startedInMlMode));
			// A reopened mode conversation renders mid-plan from the stored snapshot;
			// a reset without one keeps the strip on its tool note.
			if (reset && startedInMlMode && plan?.steps.length) {
				mlAssistant.setPlan(planStepsToMlSteps(plan.steps));
			}
			// Loaded state seeds the ledger; the stream's Budget updates take over
			// from there. The empty-ledger condition covers adoption — the create
			// flow lands here with reset=false — while still refusing to let a
			// stale invalidation roll back what the stream already reported. A mode
			// conversation without a stored budget renders as $0.00: the gate treats
			// it that way, and the readout must say what the gate will do.
			if (startedInMlMode && (reset || mlAssistant.budget === undefined)) {
				mlAssistant.setBudget({
					totalMicroUsd: mlBudget?.totalMicroUsd ?? 0,
					spentMicroUsd: mlBudget?.spentMicroUsd ?? 0,
					reservedMicroUsd: mlBudget ? reservedMicroUsd(mlBudget) : 0,
				});
			}
		});
	});

	const budgetClient = useAPIClient();

	/**
	 * Commits a new budget total. Optimistic: the strip shows the new total at
	 * once and rolls back if the server said no.
	 */
	function changeMlBudget(totalUsd: number) {
		const conversationId = page.params?.id;
		const previous = mlAssistant.budget;
		if (!conversationId || !previous) return;
		mlAssistant.setBudget({ ...previous, totalMicroUsd: usdToMicroUsd(totalUsd) });
		budgetClient
			.conversations({ id: conversationId })
			.patch({ mlBudgetTotalUsd: totalUsd })
			.then(handleResponse)
			.catch(() => {
				mlAssistant.setBudget(previous);
			});
	}

	let activeRouterExamplePrompt = $state<string | null>(null);
	// ML Assistant mode brings its own chip set; otherwise use MCP examples when all
	// base servers are enabled, and router examples when they are not.
	let activeExamples = $derived<RouterExample[]>(
		mlModeOn ? mlAssistantExamples : $allBaseServersEnabled ? mcpExamples : routerExamples
	);
	let routerFollowUps = $derived<RouterFollowUp[]>(
		activeRouterExamplePrompt
			? (activeExamples.find((ex) => ex.prompt === activeRouterExamplePrompt)?.followUps ?? [])
			: []
	);
	let routerUserMessages = $derived(messages.filter((msg) => msg.from === "user"));
	let shouldShowRouterFollowUps = $derived(
		!draft.length &&
			activeRouterExamplePrompt &&
			routerFollowUps.length > 0 &&
			routerUserMessages.length === 1 &&
			(currentModel.isRouter || (modelSupportsTools && $allBaseServersEnabled)) &&
			!hideRouterExamples &&
			!loading
	);

	$effect(() => {
		if (
			!(currentModel.isRouter || (modelSupportsTools && $allBaseServersEnabled)) ||
			!messages.length
		) {
			activeRouterExamplePrompt = null;
			return;
		}

		const firstUserMessage = messages.find((msg) => msg.from === "user");
		if (!firstUserMessage) {
			activeRouterExamplePrompt = null;
			return;
		}

		const match = activeExamples.find((ex) => ex.prompt.trim() === firstUserMessage.content.trim());
		activeRouterExamplePrompt = match ? match.prompt : null;
	});

	// Composer content queued from outside (e.g. an annotated artifact
	// screenshot plus its notes), consumed and cleared on arrival: files use
	// the same accept rules as paste, text appends to the editable draft
	$effect(() => {
		const pending = $pendingComposerPayload;
		if (!pending || shared) return;
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

	function triggerPrompt(prompt: string) {
		if (requireAuthUser() || loading) return;
		draft = prompt;
		handleSubmit();
	}

	async function startExample(example: RouterExample) {
		if (requireAuthUser()) return;

		// ML Intern chips seed the composer instead of dispatching. Their prompts
		// are complete, but they name one specific paper, model or dataset, and a
		// task at this price is one the user should read before it starts.
		if (mlModeOn) {
			draft = example.prompt;
			return;
		}

		activeRouterExamplePrompt = example.prompt;

		if (browser && example.attachments?.length) {
			const loadedFiles: File[] = [];
			for (const attachment of example.attachments) {
				try {
					const response = await fetch(`${base}/${attachment.src}`);
					if (!response.ok) continue;

					const blob = await response.blob();
					const name = attachment.src.split("/").pop() ?? "attachment";
					loadedFiles.push(
						new File([blob], name, { type: blob.type || "application/octet-stream" })
					);
				} catch (err) {
					console.error("Error loading attachment:", err);
				}
			}
			files = loadedFiles;
		}

		triggerPrompt(example.prompt);
	}

	function startFollowUp(followUp: RouterFollowUp) {
		triggerPrompt(followUp.prompt);
	}

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
			console.error("Transcription error:", err);
			$error = "Transcription failed. Please try again.";
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
			console.error("Transcription error:", err);
			$error = "Transcription failed. Please try again.";
		} finally {
			isTranscribing = false;
		}
	}

	function handleRecordingError(message: string) {
		console.error("Recording error:", message);
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
		isAuthor={!shared}
		readOnly={isReadOnly}
		showPlaceholder={showPendingPlaceholder}
		conversationKey={page.params?.id}
		{onretry}
		{onshowAlternateMsg}
		bind:this={column}
	>
		{#snippet overlay()}
			{#if shareModalOpen}
				<ShareConversationModal open={shareModalOpen} onclose={() => shareModal.close()} />
			{/if}
			{#if canExport || canShare}
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
							aria-label="Open artifacts panel"
							title="Artifacts and chat export"
						>
							<CarbonSidePanelOpen />
						</button>
					{/if}
					{#if canShare}
						<button
							type="button"
							class="flex size-8 items-center justify-center gap-2 rounded-xl border border-gray-200 bg-white/90 text-sm font-medium text-gray-700 shadow-xs hover:bg-white/60 hover:text-gray-500 dark:border-gray-700 dark:bg-gray-800/80 dark:text-gray-200 dark:hover:bg-gray-700
								{loading ? 'cursor-not-allowed opacity-40' : ''}"
							onclick={() => shareModal.open()}
							aria-label="Share conversation"
							disabled={loading}
						>
							<IconShare />
						</button>
					{/if}
				</div>
			{/if}
			{#if featureAnnouncement && showFeatureAnnouncement && !mlSpotlightVisible}
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
			>
				{#if mlSpotlightVisible}
					<MlInternSpotlight ontry={tryMlIntern} ondismiss={dismissMlSpotlight} />
				{/if}
			</ChatIntroduction>
		{/snippet}
		{#snippet tail()}
			{#if isReadOnly}
				<ModelSwitch models={switchableModels} {currentModel} />
			{/if}
		{/snippet}
		{#snippet composer()}
			{#if !draft.length && !messages.length && !files.length && !loading && (mlModeOn || currentModel.isRouter || (modelSupportsTools && $allBaseServersEnabled)) && activeExamples.length && !hideRouterExamples && !lastIsError && $mcpServersLoaded}
				<div
					class="mb-3 no-scrollbar flex w-full justify-start gap-2 overflow-x-auto whitespace-nowrap text-gray-400 select-none dark:text-gray-500"
				>
					{#each activeExamples as ex}
						<button
							class={[
								"flex items-center gap-1 rounded-lg px-2 py-0.5 text-center text-sm backdrop-blur-sm",
								mlModeOn
									? "bg-[#fff1e4] text-[#c2410c] dark:bg-[#3a2410] dark:text-[#fdba74]"
									: "bg-gray-100/90 hover:text-gray-500 dark:bg-gray-700/50 dark:hover:text-gray-400",
							]}
							onclick={() => startExample(ex)}
						>
							{ex.title}
							{#if ex.artifact}
								<LucideSparkles class="size-3 flex-none text-blue-600 dark:text-blue-400" />
							{/if}
						</button>
					{/each}
				</div>
			{/if}
			{#if shouldShowRouterFollowUps && !lastIsError}
				<div
					class="mb-3 no-scrollbar flex w-full justify-start gap-2 overflow-x-auto whitespace-nowrap text-gray-400 select-none dark:text-gray-500"
				>
					<!-- <span class=" text-gray-500 dark:text-gray-400">Follow ups</span> -->
					{#each routerFollowUps as followUp}
						<button
							class="flex items-center gap-1 rounded-lg bg-gray-100/90 px-2 py-0.5 text-center text-sm backdrop-blur-sm hover:text-gray-500 dark:bg-gray-700/50 dark:hover:text-gray-400"
							onclick={() => startFollowUp(followUp)}
						>
							<CarbonDirectionRight class="scale-y-[-1] text-xs" />
							{followUp.title}</button
						>
					{/each}
				</div>
			{/if}
			<ComposerFileChips bind:files hidden={loading} />

			<div class="w-full">
				{#if askQuestion}
					<AskQuestion conversationId={askQuestion.conversationId} request={askQuestion.request} />
				{/if}
				<div class="flex w-full gap-2 *:mb-3">
					{#if !loading && lastIsError}
						{#if canResumeTurn}
							<ResumeBtn classNames="ml-auto" onClick={sendResumeMessage} />
						{/if}
						<RetryBtn
							classNames={canResumeTurn ? "" : "ml-auto"}
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
					aria-label={isFileUploadEnabled ? "file dropzone" : undefined}
					onsubmit={(e) => {
						e.preventDefault();
						handleSubmit();
					}}
					class={{
						"relative flex w-full max-w-4xl flex-1 flex-col rounded-xl border bg-gray-100 dark:bg-gray-800": true,
						"transition-[border-color] duration-[350ms] ease-[ease]": ML_ASSISTANT_MODE,
						"border-[#e2ddd6] dark:border-[#2c2c2c]": mlModeOn && (mlStripVisible || mlPillVisible),
						"dark:border-gray-700": !(mlModeOn && (mlStripVisible || mlPillVisible)),
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
					{#if ML_ASSISTANT_MODE}
						<MlAssistantStrip
							visible={mlStripVisible}
							steps={mlAssistant.steps}
							statusLabel={mlAssistant.statusLabel}
							complete={mlAssistant.complete}
							budget={mlAssistant.budget}
							onbudgetchange={page.params?.id ? changeMlBudget : undefined}
							dashboard={trackioDashboards.at(-1)}
						/>
					{/if}
					<!-- The composer box is a column so the ML Assistant strip can stack on
					     top; this row is the composer proper and keeps its own layout. -->
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
									<ChatInput
										value="Sorry, something went wrong. Please try again."
										disabled={true}
									/>
								{:else}
									<ChatInput
										placeholder={isReadOnly
											? "This conversation is read-only."
											: mlModeOn
												? ML_ASSISTANT_PLACEHOLDER
												: "Ask anything"}
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
										{modelSupportsTools}
										showMlPill={mlPillVisible}
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
								aria-label="Start voice recording"
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
								: 'bg-black! text-white! dark:bg-white! dark:text-black!'}"
							disabled={!draft || isReadOnly}
							type="submit"
							aria-label="Send message"
							name="submit"
						>
							<IconArrowUp />
						</button>
					{/if}
				{/snippet}
				<div
					class={{
						"mt-1.5 flex h-5 items-center self-stretch px-0.5 text-xs whitespace-nowrap text-gray-400/90 max-md:mb-2 max-sm:gap-2": true,
						"max-sm:hidden": focused && isVirtualKeyboard(),
					}}
				>
					{#if models.find((m) => m.id === currentModel.id)}
						{#if loading && streamingToolCallName}
							<span class="inline-flex items-center gap-1 text-xs whitespace-nowrap">
								<LucideHammer class="size-3" />
								Calling tool
								<span class="loading-dots font-medium">
									{availableTools.find((t) => t.name === streamingToolCallName)?.displayName ??
										streamingToolCallName}
								</span>
							</span>
						{:else if !currentModel.isRouter || !loading}
							<!-- Opens the picker, not the Models dialog. This control draws a
							     caret and sits under the composer, so it reads as "change what
							     this chat runs on" — which is what it now does. The Models
							     dialog is a management surface: it sets the *default* and edits
							     per-model prompts, so reaching it from here meant the only way
							     to move one conversation was to change every future one. -->
							<ModelEffortPicker
								models={pickerModels}
								currentId={currentModel.id}
								{recentIds}
								efforts={effortLevels}
								effort={shownEffort}
								effortPinned={mlModeOn}
								onpickModel={pickModel}
								onpickEffort={pickEffort}
								onmore={() => {
									if (requireAuthUser()) return;
									pickerOpen = true;
								}}
							>
								{#if currentModel.isRouter}
									<IconOmni />
									<span class="truncate">{currentModel.displayName}</span>
								{:else}
									<span class="shrink-0">Model:</span>
									{#if currentModel.logoUrl}
										<img
											src={currentModel.logoUrl}
											alt=""
											class="size-3 flex-none rounded-sm border bg-white dark:border-gray-700"
										/>
									{/if}
									<span class="truncate">{currentModel.displayName}</span>
									{#if hasProviderOverride}
										{@const hubOrg =
											PROVIDERS_HUB_ORGS[providerOverride as keyof typeof PROVIDERS_HUB_ORGS]}
										<span
											class="inline-flex shrink-0 items-center rounded-sm p-0.5 {providerOverride ===
											'fastest'
												? 'bg-green-100 text-green-600 dark:bg-green-800/20 dark:text-green-500'
												: providerOverride === 'cheapest'
													? 'bg-blue-100 text-blue-600 dark:bg-blue-800/20 dark:text-blue-500'
													: ''}"
											title="Provider: {providerOverride}"
										>
											{#if providerOverride === "fastest"}
												<IconFast classNames="text-sm" />
											{:else if providerOverride === "cheapest"}
												<IconCheap classNames="text-sm" />
											{:else if hubOrg}
												<img
													src="https://huggingface.co/api/avatars/{hubOrg}"
													alt={providerOverride}
													class="size-3 flex-none rounded-xs"
												/>
											{/if}
										</span>
									{/if}
								{/if}
							</ModelEffortPicker>
						{:else if showRouterDetails && streamingRouterMetadata?.route}
							<div
								class="mr-2 flex items-center gap-1.5 text-xs text-[.70rem] leading-none whitespace-nowrap text-gray-400 dark:text-gray-400"
							>
								<IconOmni classNames="text-xs animate-pulse" />

								<span class="router-badge-text router-shimmer">
									{streamingRouterMetadata.route}
								</span>

								<span class="text-gray-500">with</span>

								<span class="router-badge-text">
									{streamingRouterModelName}
								</span>
							</div>
						{:else}
							<div
								class="loading-dots relative inline-flex items-center text-gray-400 dark:text-gray-400"
								aria-label="Routing…"
							>
								<IconOmni classNames="text-xs animate-pulse mr-1" /> Routing
							</div>
						{/if}
					{:else}
						<span class="inline-flex items-center line-through dark:border-gray-700">
							{currentModel.id}
						</span>
					{/if}
					{#if !messages.length && !loading}
						<span class="max-sm:hidden"
							>{publicConfig.PUBLIC_CAVEAT || "Generated content may be inaccurate or false."}</span
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
		canScreenshot={!shared && !isReadOnly && mimeMatchesAllowlist("image/png", activeMimeTypes)}
		canPersistFiles={!shared && !isReadOnly}
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

	.router-badge-text {
		display: inline-block;
		position: relative;
		color: inherit;
	}

	.router-shimmer {
		display: inline-block;
		background-image: linear-gradient(
			90deg,
			rgba(156, 163, 175, 1) 0%,
			rgba(156, 163, 175, 0.6) 10%,
			rgba(156, 163, 175, 0.6) 50%,
			rgba(156, 163, 175, 0.6) 90%,
			rgba(156, 163, 175, 1) 100%
		);
		background-size: 220% 100%;
		animation: router-shimmer 2.8s linear infinite;
		background-clip: text;
		-webkit-background-clip: text;
		color: transparent;
		-webkit-text-fill-color: transparent;
	}

	:global(.dark) .router-shimmer {
		background-image: linear-gradient(
			90deg,
			rgba(255, 255, 255, 0.15) 0%,
			rgba(255, 255, 255, 0.7) 50%,
			rgba(255, 255, 255, 0.15) 100%
		);
	}

	@keyframes router-shimmer {
		0% {
			background-position: 200% 0;
		}
		100% {
			background-position: -200% 0;
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
