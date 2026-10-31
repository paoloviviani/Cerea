<script lang="ts">
	import { m } from "$lib/paraglide/messages";
	import Rich from "$lib/i18n/Rich.svelte";
	import { page } from "$app/state";
	import type { MessageFile } from "$lib/types/Message";
	import CarbonClose from "~icons/carbon/close";
	import CarbonDocumentBlank from "~icons/carbon/document-blank";
	import CarbonDownload from "~icons/carbon/download";
	import CarbonDocument from "~icons/carbon/document";
	import Modal from "../Modal.svelte";
	import IconMic from "~icons/lucide/mic";
	import EosIconsLoading from "~icons/eos-icons/loading";
	import { base } from "$app/paths";
	import { TEXT_MIME_ALLOWLIST } from "$lib/constants/mime";
	import { sidePane } from "$lib/stores/sidePane.svelte";
	import { isOfficeDocument } from "$lib/utils/officeFormats";
	import {
		officePreviewEnabledIn,
		pdfPayloadFor,
		previewUrlFor,
		slidesPayloadFor,
	} from "$lib/utils/officePreview";

	interface Props {
		file: MessageFile;
		canClose?: boolean;
		onclose?: () => void;
		/**
		 * Where a `hash` file's bytes are served, as `<fileBaseUrl>/<sha>`.
		 * Defaults to the page's own `…/output`, which is chat's
		 * `conversation/[id]/output/[sha256]`; a surface with no conversation
		 * in its path (the `/code` panel) passes its store's route instead.
		 */
		fileBaseUrl?: string;
	}

	let { file, canClose = true, onclose, fileBaseUrl }: Props = $props();

	let showModal = $state(false);

	// Capture URL once at component creation to prevent reactive updates during navigation
	// svelte-ignore state_referenced_locally
	let outputBase = (fileBaseUrl ?? page.url.pathname.replace(/\/$/, "") + "/output").replace(
		/\/$/,
		""
	);

	function truncateMiddle(text: string, maxLength: number): string {
		if (text.length <= maxLength) {
			return text;
		}

		const halfLength = Math.floor((maxLength - 1) / 2);
		const start = text.substring(0, halfLength);
		const end = text.substring(text.length - halfLength);

		return `${start}…${end}`;
	}

	const isImage = (mime: string) =>
		mime.startsWith("image/") || mime === "webp" || mime === "jpeg" || mime === "png";

	const isAudio = (mime: string) =>
		mime.startsWith("audio/") || mime === "mp3" || mime === "wav" || mime === "x-wav";
	const isVideo = (mime: string) =>
		mime.startsWith("video/") || mime === "mp4" || mime === "x-mpeg";

	function matchesAllowed(contentType: string, allowed: readonly string[]): boolean {
		const ct = contentType.split(";")[0]?.trim().toLowerCase();
		if (!ct) return false;
		const [ctType, ctSubtype] = ct.split("/");
		for (const a of allowed) {
			const [aType, aSubtype] = a.toLowerCase().split("/");
			const typeOk = aType === "*" || aType === ctType;
			const subOk = aSubtype === "*" || aSubtype === ctSubtype;
			if (typeOk && subOk) return true;
		}
		return false;
	}

	const isPlainText = (mime: string) =>
		mime === "application/vnd.chatui.clipboard" || matchesAllowed(mime, TEXT_MIME_ALLOWLIST);

	// An Office attachment of this conversation previews in the side pane: as the
	// server's PDF when the deployment has a converter, and for a PowerPoint deck
	// drawn in the browser when it has not. Only files in a conversation's own
	// store (not another surface's `fileBaseUrl`) have the preview route.
	const officeMode = $derived.by(() => {
		if (file.type !== "hash" || fileBaseUrl !== undefined || !isOfficeDocument(file.name)) {
			return null;
		}
		if (officePreviewEnabledIn(page.data)) return "pdf" as const;
		return file.name.toLowerCase().endsWith(".pptx") ? ("slides" as const) : null;
	});
	let officeBusy = $state(false);
	let officeError = $state<string | null>(null);

	async function openOfficePreview(): Promise<void> {
		if (!officeMode || officeBusy) return;
		officeBusy = true;
		officeError = null;
		try {
			const fileUrl = outputBase + "/" + file.value;
			if (officeMode === "pdf") {
				sidePane.openPreview(await pdfPayloadFor(file.name, previewUrlFor(fileUrl, file.name)));
			} else {
				const res = await fetch(fileUrl);
				if (!res.ok) throw new Error(m["chat.uploaded.gone"]());
				sidePane.openPreview(
					await slidesPayloadFor(file.name, new Uint8Array(await res.arrayBuffer()))
				);
			}
		} catch (err) {
			officeError = err instanceof Error ? err.message : m["chat.uploaded.preview_unavailable"]();
		} finally {
			officeBusy = false;
		}
	}

	// Audio: a chip with a badge and the duration when it is known; a stored
	// one opens a panel with the player and the transcript made at upload.
	const audioSrc = $derived(
		file.type === "base64"
			? `data:${file.mime};base64,${file.value}`
			: outputBase + "/" + file.value
	);
	let measured = $state<number | null>(null);
	const audioSeconds = $derived(file.audio?.durationSeconds ?? measured);

	function formatDuration(seconds: number): string {
		const total = Math.max(0, Math.round(seconds));
		const h = Math.floor(total / 3600);
		const mm = Math.floor((total % 3600) / 60);
		const ss = String(total % 60).padStart(2, "0");
		return h > 0 ? `${h}:${String(mm).padStart(2, "0")}:${ss}` : `${mm}:${ss}`;
	}

	// Without a recorded duration (a file still in the composer), ask the
	// browser for the file's own metadata. Best effort: no duration is fine.
	$effect(() => {
		if (!isAudio(file.mime) || file.audio?.durationSeconds || typeof Audio === "undefined") return;
		let probe: HTMLAudioElement | null = null;
		try {
			probe = new Audio();
			probe.preload = "metadata";
			probe.onloadedmetadata = () => {
				if (probe && Number.isFinite(probe.duration) && probe.duration > 0) {
					measured = probe.duration;
				}
			};
			probe.src = audioSrc;
		} catch {
			/* no metadata, no duration */
		}
		return () => {
			if (probe) {
				probe.onloadedmetadata = null;
				probe.removeAttribute("src");
			}
		};
	});

	let transcript = $state<{ state: "loading" | "ready" | "none" | "failed"; text: string }>({
		state: "loading",
		text: "",
	});

	async function loadTranscript(): Promise<void> {
		if (file.type !== "hash" || !file.extracted) {
			transcript = { state: "none", text: "" };
			return;
		}
		transcript = { state: "loading", text: "" };
		try {
			const res = await fetch(outputBase + "/" + file.extracted.value);
			if (!res.ok) throw new Error(String(res.status));
			transcript = { state: "ready", text: await res.text() };
		} catch {
			transcript = { state: "failed", text: "" };
		}
	}

	const audioPanel = $derived(isAudio(file.mime) && file.type === "hash");

	let isClickable = $derived(
		isImage(file.mime) || isPlainText(file.mime) || officeMode !== null || audioPanel
	);

	function activate(): void {
		if (!isClickable) return;
		if (officeMode !== null) void openOfficePreview();
		else {
			if (audioPanel) void loadTranscript();
			showModal = true;
		}
	}
</script>

{#snippet link(text: string)}<a href={`${base}/settings`} class="underline">{text}</a>{/snippet}

{#if showModal && isClickable}
	<!-- show the image file full screen, click outside to exit -->
	<Modal width="xl:max-w-[75dvw]" onclose={() => (showModal = false)}>
		{#if audioPanel}
			<div class="flex w-full flex-col gap-3 p-4" data-testid="audio-panel">
				<div class="flex items-center gap-2">
					<IconMic class="flex-none text-gray-600 dark:text-gray-300" />
					<h3 class="truncate text-lg font-semibold">{file.name}</h3>
					{#if audioSeconds}
						<span class="text-sm text-gray-500 tabular-nums">{formatDuration(audioSeconds)}</span>
					{/if}
					<button
						class="ml-auto text-xl text-gray-500 hover:text-gray-800 dark:text-gray-400 dark:hover:text-white"
						aria-label={m["chat.uploaded.close_audio"]()}
						onclick={() => (showModal = false)}
					>
						<CarbonClose class="text-xl" />
					</button>
				</div>
				<audio controls preload="metadata" src={audioSrc} class="w-full"></audio>
				<h4 class="text-sm font-medium">{m["chat.uploaded.transcript"]()}</h4>
				{#if transcript.state === "loading"}
					<p class="text-sm text-gray-500">{m["chat.uploaded.transcript_loading"]()}</p>
				{:else if transcript.state === "ready"}
					<pre
						class="max-h-[50dvh] overflow-y-auto font-sans text-sm wrap-break-word whitespace-pre-wrap"
						data-testid="audio-transcript">{transcript.text}</pre>
				{:else if transcript.state === "failed"}
					<p class="text-sm text-amber-700 dark:text-amber-400">
						{m["chat.uploaded.transcript_failed"]()}
					</p>
				{:else}
					<p class="text-sm text-gray-500">
						{file.extractionError?.reason ?? m["chat.uploaded.transcript_none"]()}
					</p>
				{/if}
			</div>
		{:else if isImage(file.mime)}
			{#if file.type === "hash"}
				<img
					src={outputBase + "/" + file.value}
					alt={m["chat.uploaded.input_alt"]()}
					class="aspect-auto"
				/>
			{:else}
				<!-- handle the case where this is a base64 encoded image -->
				<img
					src={`data:${file.mime};base64,${file.value}`}
					alt={m["chat.uploaded.input_alt"]()}
					class="aspect-auto"
				/>
			{/if}
		{:else if isPlainText(file.mime)}
			<div class="relative flex h-full w-full flex-col gap-2 p-4">
				<div class="flex items-center gap-1">
					<CarbonDocument />
					<h3 class="text-lg font-semibold">{file.name}</h3>
				</div>
				{#if file.mime === "application/vnd.chatui.clipboard"}
					<p class="text-sm text-gray-500">
						<Rich parts={m["chat.uploaded.paste_hint"].parts()} tags={{ link }} />
					</p>
				{/if}
				<button
					class="absolute top-4 right-4 text-xl text-gray-500 hover:text-gray-800 dark:text-gray-400 dark:hover:text-white"
					onclick={() => (showModal = false)}
				>
					<CarbonClose class="text-xl" />
				</button>
				{#if file.type === "hash"}
					{#await fetch(outputBase + "/" + file.value).then((res) => res.text())}
						<div class="flex h-full w-full items-center justify-center">
							<EosIconsLoading class="text-xl" />
						</div>
					{:then result}
						<pre
							class="w-full pt-0 text-xs wrap-break-word whitespace-pre-wrap"
							class:font-sans={file.mime === "text/plain" ||
								file.mime === "application/vnd.chatui.clipboard"}
							class:font-mono={file.mime !== "text/plain" &&
								file.mime !== "application/vnd.chatui.clipboard"}>{result}</pre>
					{/await}
				{:else}
					<pre
						class="w-full pt-0 text-xs wrap-break-word whitespace-pre-wrap"
						class:font-sans={file.mime === "text/plain" ||
							file.mime === "application/vnd.chatui.clipboard"}
						class:font-mono={file.mime !== "text/plain" &&
							file.mime !== "application/vnd.chatui.clipboard"}>{atob(file.value)}</pre>
				{/if}
			</div>
		{/if}
	</Modal>
{/if}

<div
	onclick={activate}
	onkeydown={(e) => {
		if (!isClickable) {
			return;
		}
		if (e.key === "Enter" || e.key === " ") {
			activate();
		}
	}}
	class:clickable={isClickable}
	role="button"
	tabindex="0"
>
	<div class="group relative flex items-center rounded-xl shadow-xs">
		{#if isImage(file.mime)}
			<div class="h-36 overflow-hidden rounded-xl">
				<img
					src={file.type === "base64"
						? `data:${file.mime};base64,${file.value}`
						: outputBase + "/" + file.value}
					alt={file.name}
					class="h-36 bg-gray-200 object-cover dark:bg-gray-800"
				/>
			</div>
		{:else if isAudio(file.mime)}
			<div
				class="flex h-14 w-72 items-center gap-2 overflow-hidden rounded-xl border border-gray-200 bg-white p-2 dark:border-gray-800 dark:bg-gray-900"
				class:file-hoverable={isClickable}
				data-testid="audio-chip"
				aria-label={audioPanel ? m["chat.uploaded.audio_open"]({ name: file.name }) : undefined}
			>
				<div
					class="grid size-10 flex-none place-items-center rounded-lg bg-gray-100 dark:bg-gray-800"
				>
					<IconMic class="text-base text-gray-700 dark:text-gray-300" />
				</div>
				<dl class="flex flex-col items-start truncate leading-tight">
					<dd class="text-sm">{truncateMiddle(file.name, 28)}</dd>
					<dt class="flex items-center gap-1.5 text-xs text-gray-400">
						<span
							class="rounded bg-gray-100 px-1 text-[10px] font-medium tracking-wide text-gray-600 uppercase dark:bg-gray-800 dark:text-gray-300"
							data-testid="audio-badge">{m["chat.uploaded.audio_badge"]()}</span
						>
						{#if audioSeconds}
							<span data-testid="audio-duration" class="tabular-nums"
								>{formatDuration(audioSeconds)}</span
							>
						{/if}
					</dt>
				</dl>
			</div>
		{:else if isVideo(file.mime)}
			<div
				class="w-72 overflow-clip rounded-xl border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900"
			>
				<!-- svelte-ignore a11y_media_has_caption -->
				<video
					src={file.type === "base64"
						? `data:${file.mime};base64,${file.value}`
						: outputBase + "/" + file.value}
					controls
				></video>
			</div>
		{:else if isPlainText(file.mime)}
			<div
				class="flex h-14 w-64 items-center gap-2 overflow-hidden rounded-xl border border-gray-200 bg-white p-2 2xl:w-72 dark:border-gray-800 dark:bg-gray-900"
				class:file-hoverable={isClickable}
			>
				<div
					class="grid size-10 flex-none place-items-center rounded-lg bg-gray-100 dark:bg-gray-800"
				>
					<CarbonDocument class="text-base text-gray-700 dark:text-gray-300" />
				</div>
				<dl class="flex flex-col items-start truncate leading-tight">
					<dd class="text-sm">
						{truncateMiddle(file.name, 28)}
					</dd>
					{#if file.mime === "application/vnd.chatui.clipboard"}
						<dt class="text-xs text-gray-400">{m["chat.uploaded.pasted"]()}</dt>
					{:else}
						<dt class="text-xs text-gray-400">{file.mime}</dt>
					{/if}
				</dl>
			</div>
		{:else if file.mime === "application/octet-stream"}
			<div
				class="flex h-14 w-72 items-center gap-2 overflow-hidden rounded-xl border border-gray-200 bg-white p-2 dark:border-gray-800 dark:bg-gray-900"
				class:file-hoverable={isClickable}
			>
				<div
					class="grid size-10 flex-none place-items-center rounded-lg bg-gray-100 dark:bg-gray-800"
				>
					<CarbonDocumentBlank class="text-base text-gray-700 dark:text-gray-300" />
				</div>
				<dl class="flex grow flex-col truncate leading-tight">
					<dd class="text-sm">
						{truncateMiddle(file.name, 28)}
					</dd>
					<dt class="text-xs text-gray-400">{m["chat.uploaded.unknown_kind"]()}</dt>
				</dl>
				<a
					href={file.type === "base64"
						? `data:application/octet-stream;base64,${file.value}`
						: outputBase + "/" + file.value}
					download={file.name}
					class="ml-auto flex-none"
				>
					<CarbonDownload class="text-base text-gray-700 dark:text-gray-300" />
				</a>
			</div>
		{:else}
			<div
				class="flex h-14 w-72 items-center gap-2 overflow-hidden rounded-xl border border-gray-200 bg-white p-2 dark:border-gray-800 dark:bg-gray-900"
				class:file-hoverable={isClickable}
			>
				<div
					class="grid size-10 flex-none place-items-center rounded-lg bg-gray-100 dark:bg-gray-800"
				>
					<CarbonDocumentBlank class="text-base text-gray-700 dark:text-gray-300" />
				</div>
				<dl class="flex flex-col items-start truncate leading-tight">
					<dd class="text-sm">
						{truncateMiddle(file.name, 28)}
					</dd>
					{#if officeError}
						<dt class="text-xs text-amber-600 dark:text-amber-400">{officeError}</dt>
					{:else if officeBusy}
						<dt class="text-xs text-gray-400">{m["chat.uploaded.preparing"]()}</dt>
					{:else}
						<dt class="text-xs text-gray-400">{file.mime}</dt>
					{/if}
				</dl>
			</div>
		{/if}
		<!-- add a button on top that removes the image -->
		{#if canClose}
			<button
				class="absolute -top-2 -right-2 z-10 grid size-6 place-items-center rounded-full border bg-black group-hover:visible dark:border-gray-700"
				class:invisible={navigator.maxTouchPoints === 0}
				onclick={(e) => {
					e.preventDefault();
					e.stopPropagation();
					onclose?.();
				}}
			>
				<CarbonClose class=" text-xs  text-white" />
			</button>
		{/if}
	</div>
</div>
