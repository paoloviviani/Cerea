<!--
	The /code explorer (ADR 0090, F1): the workspace's files, read-only,
	served by galopin from inside the workspace directory. A tree with git
	badges; picking a file opens it in place (a back link returns to the
	tree), as text in a read-only CodeMirror view with "Load more" past
	1 MiB, as a raster image (SVG stays a text view; anything over the
	8 MB image cap gets a message, not a viewer), or as a note for
	binaries. Refreshed by hand and at every turn boundary, when an agent
	may have written.

	When the machine allows saving (`writable`), a text file can be edited in
	place (CodeFileViewer): each save carries the revision the file was read
	at, so a change on disk since then (an agent's edit) is a conflict to
	resolve, never silently overwritten. Leaving the file, the pane or the page
	with unsaved edits asks first; a refresh keeps the edits and re-reads only
	the tree.
-->
<script lang="ts">
	import { m } from "$lib/paraglide/messages";
	import { onDestroy, untrack } from "svelte";
	import { beforeNavigate } from "$app/navigation";
	import { sidePane } from "$lib/stores/sidePane.svelte";
	import IconRenew from "~icons/carbon/renew";
	import IconUpload from "~icons/carbon/upload";
	import IconDownload from "~icons/carbon/download";
	import IconFolderAdd from "~icons/carbon/folder-add";
	import IconZip from "~icons/carbon/zip";
	import { UPLOAD_MAX_FILE_BYTES } from "$lib/constants/transfer";
	import { formatNumber } from "$lib/i18n/format";
	import {
		batchProblem,
		dirOf,
		itemsFromDrop,
		itemsFromFiles,
		joinPath,
		overFileLimit,
		type UploadItem,
	} from "$lib/utils/codeUpload";
	import IconArrowLeft from "~icons/carbon/arrow-left";
	import IconLocked from "~icons/carbon/locked";
	import CodeFileTree from "./CodeFileTree.svelte";
	import CodeFileViewer, { type SaveOutcome } from "./CodeFileViewer.svelte";
	import {
		CodeApiError,
		FileConflictError,
		listWorkspaceFiles,
		readWorkspaceFile,
		workspaceFileRawUrl,
		workspaceFileStatus,
		uploadWorkspaceFile,
		workspaceFileDownloadUrl,
		workspaceFileZipUrl,
		writeWorkspaceFile,
	} from "$lib/codeApi";
	import type { FileEntry, FilesReadResult } from "$lib/types/machineProtocol";
	import { gitBadges, humanSize, type FileSaveBlock, type GitBadge } from "$lib/utils/codeFiles";
	import { isInlineRasterMime } from "$lib/utils/filePreview";

	interface Props {
		deviceId: string;
		workspaceId: string;
		/** Bumped by the view at each turn boundary. */
		turnKey?: number;
		/** Files may be saved here: the deployment's switch, the machine's
		 * fileWrite policy and its galopin all allow it. */
		writable?: boolean;
		/** Why saving is off, shown above a text file so a read-only editor says
		 * why and how to turn saving on. */
		saveBlocked?: FileSaveBlock | null;
		/** Files may be uploaded into the folder shown: saving is allowed and
		 * this galopin implements `files.upload`. */
		uploadable?: boolean;
		/** Files may be downloaded: this galopin implements `files.download`. */
		downloadable?: boolean;
		/** Folders may be downloaded as a zip: the galopin has `folderDownload`. */
		folderDownloadable?: boolean;
	}

	let {
		deviceId,
		workspaceId,
		turnKey = 0,
		writable = false,
		saveBlocked = null,
		uploadable = false,
		downloadable = false,
		folderDownloadable = false,
	}: Props = $props();

	const SAVE_BLOCKED: Record<FileSaveBlock, () => string> = {
		policy: m["code.files.save_blocked.policy"],
		machine: m["code.files.save_blocked.machine"],
		deployment: m["code.files.save_blocked.deployment"],
	};

	/** files.write's cap (§9.3): a larger text file stays read-only. */
	const MAX_EDIT_BYTES = 1024 * 1024;

	let refreshKey = $state(0);
	let badges = $state<Map<string, GitBadge>>(new Map());
	let branch = $state<string | null>(null);
	let open = $state<FileEntry | null>(null);
	let file = $state<FilesReadResult | null>(null);
	let text = $state("");
	let loading = $state(false);
	let failure = $state<string | null>(null);
	/** The editor holds edits not saved yet. */
	let dirty = $state(false);
	/** What is on disk after a save answered "changed on disk": Overwrite saves
	 * against it. */
	let conflictRevision = $state<string | null>(null);

	/** The folder uploads go into: the last folder clicked in the tree, or the
	 * parent of the file open ("." is the workspace folder). */
	let uploadDir = $state(".");
	let dragging = $state(false);
	let fileInput = $state<HTMLInputElement>();
	let folderInput = $state<HTMLInputElement>();

	/** One pick or drop: its files go up one at a time, and it shows as one row. */
	interface UploadBatch {
		id: number;
		state: "working" | "done" | "error";
		text: string;
		/** Why files failed, by name (the first few are shown). */
		failures: string[];
		cancel: () => void;
	}
	let uploads = $state<UploadBatch[]>([]);
	let uploadSeq = 0;
	let uploadChain: Promise<void> = Promise.resolve();
	/** The batch conflict dialog: how many files already exist, and the answer. */
	let conflictAsk = $state<{
		count: number;
		name: string;
		answer: (choice: "replace" | "skip" | "cancel") => void;
	} | null>(null);
	const uploadFolder = $derived(uploadDir === "." ? m["code.files.upload_root"]() : uploadDir);

	function parentOf(path: string): string {
		const i = path.lastIndexOf("/");
		return i < 0 ? "." : path.slice(0, i);
	}

	/** The files already in the folders a batch targets, by full path. A folder
	 * that does not exist yet has none; a listing that fails or is cut short
	 * leaves its files to the conflict galopin answers at the start of each. */
	async function existingPaths(dir: string, items: UploadItem[]): Promise<Set<string>> {
		const folders = new Set(items.map((item) => dirOf(joinPath(dir, item.rel))));
		const found = new Set<string>();
		for (const folder of folders) {
			try {
				const res = await listWorkspaceFiles(deviceId, workspaceId, folder);
				for (const entry of res.entries) if (entry.type !== "dir") found.add(entry.path);
			} catch {
				/* a folder that is not there has nothing in it */
			}
		}
		return found;
	}

	function askConflicts(count: number, name: string): Promise<"replace" | "skip" | "cancel"> {
		return new Promise((resolve) => {
			conflictAsk = {
				count,
				name,
				answer: (choice) => {
					conflictAsk = null;
					resolve(choice);
				},
			};
		});
	}

	/** Queue a pick or drop for upload into the folder shown. */
	function startUploads(items: UploadItem[]) {
		if (!uploadable || items.length === 0) return;
		const dir = uploadDir;
		const abort = new AbortController();
		const batch: UploadBatch = {
			id: ++uploadSeq,
			state: "working",
			text: "",
			failures: [],
			cancel: () => abort.abort(),
		};
		uploads.push(batch);
		const live = uploads[uploads.length - 1];
		uploadChain = uploadChain.then(() => runBatch(live, dir, items, abort.signal));
	}

	async function runBatch(row: UploadBatch, dir: string, items: UploadItem[], signal: AbortSignal) {
		const problem = batchProblem(items);
		if (problem) {
			row.state = "error";
			row.text =
				problem.kind === "too_many"
					? m["code.files.upload_too_many"]({
							count: formatNumber(problem.count),
							limit: formatNumber(problem.limit),
						})
					: m["code.files.upload_too_big_total"]({
							size: humanSize(problem.bytes),
							limit: humanSize(problem.limit),
						});
			return;
		}
		const sendable: UploadItem[] = [];
		for (const item of items) {
			if (overFileLimit(item)) {
				row.failures.push(
					m["code.files.upload_too_large"]({
						name: item.rel,
						limit: UPLOAD_MAX_FILE_BYTES / 1024 / 1024,
					})
				);
			} else sendable.push(item);
		}
		row.text = m["code.files.checking"]();
		const existing = await existingPaths(dir, sendable);
		const clashes = sendable.filter((item) => existing.has(joinPath(dir, item.rel)));
		let replace = false;
		let skipClashes = false;
		if (clashes.length > 0) {
			const choice = await askConflicts(clashes.length, clashes[0].rel);
			if (choice === "cancel") {
				row.state = "error";
				row.text = m["code.files.upload_cancelled"]({ done: 0, total: items.length });
				return;
			}
			replace = choice === "replace";
			skipClashes = choice === "skip";
		}
		const clashSet = new Set(clashes);
		let done = 0;
		let skipped = 0;
		const bytesTotal = sendable.reduce((n, item) => n + item.file.size, 0);
		let bytesDone = 0;
		const percent = (current: number) =>
			bytesTotal === 0 ? 100 : Math.floor(((bytesDone + current) / bytesTotal) * 100);
		const label = (current: number) =>
			sendable.length === 1
				? m["code.files.uploading_one"]({ name: sendable[0].rel, percent: percent(current) })
				: m["code.files.uploading_many"]({
						done: done + skipped,
						total: sendable.length,
						percent: percent(current),
					});
		for (const item of sendable) {
			if (signal.aborted) break;
			if (skipClashes && clashSet.has(item)) {
				skipped += 1;
				continue;
			}
			row.text = label(0);
			try {
				await uploadWorkspaceFile(deviceId, workspaceId, dir, item.rel, item.file, {
					overwrite: replace && clashSet.has(item),
					mkdirs: true,
					signal,
					onProgress: (sent) => (row.text = label(sent)),
				});
				done += 1;
			} catch (err) {
				if (signal.aborted) break;
				row.failures.push(
					err instanceof FileConflictError
						? m["code.files.upload_exists"]({ name: item.rel })
						: m["code.files.upload_failed"]({
								name: item.rel,
								reason: err instanceof Error ? err.message : "",
							})
				);
			}
			bytesDone += item.file.size;
		}
		refreshKey += 1;
		void loadStatus();
		const failed = row.failures.length;
		if (signal.aborted) {
			row.state = "error";
			row.text = m["code.files.upload_cancelled"]({ done, total: items.length });
		} else if (failed === 0 && skipped === 0) {
			row.state = "done";
			row.text =
				done === 1
					? m["code.files.uploaded"]({ name: sendable[0].rel })
					: m["code.files.uploaded_many"]({ count: formatNumber(done) });
		} else {
			row.state = failed > 0 ? "error" : "done";
			row.text = m["code.files.upload_summary"]({
				done: formatNumber(done),
				total: formatNumber(items.length),
				failed: formatNumber(failed),
				skipped: formatNumber(skipped),
			});
		}
	}

	async function onDrop(event: DragEvent) {
		if (!uploadable) return;
		event.preventDefault();
		dragging = false;
		if (!event.dataTransfer) return;
		startUploads(await itemsFromDrop(event.dataTransfer));
	}
	function onDragOver(event: DragEvent) {
		if (!uploadable || !event.dataTransfer?.types.includes("Files")) return;
		event.preventDefault();
		dragging = true;
	}

	/** Why an open text file cannot be edited here, or null. */
	let readOnlyReason = $derived(
		!file
			? null
			: file.kind !== "text"
				? m["code.files.edit.binary_read_only"]()
				: file.size > MAX_EDIT_BYTES || file.offset !== 0 || !file.eof
					? m["code.files.edit.too_large"]()
					: null
	);

	/** Asks before unsaved edits are dropped; true when there are none. */
	function mayLeave(): boolean {
		return !dirty || confirm(m["code.files.edit.leave_confirm"]());
	}

	$effect(() => {
		sidePane.filesLeaveGuard = mayLeave;
	});
	onDestroy(() => {
		if (sidePane.filesLeaveGuard === mayLeave) sidePane.filesLeaveGuard = null;
	});
	beforeNavigate((navigation) => {
		if (!dirty) return;
		// A reload or a closed tab can only get the browser's own question.
		if (navigation.willUnload) {
			navigation.cancel();
			return;
		}
		if (!mayLeave()) navigation.cancel();
	});

	async function saveFile(content: string, overwrite: boolean): Promise<SaveOutcome> {
		if (!open || !file) return "conflict";
		const entry = open;
		const base = overwrite ? conflictRevision : file.revision;
		try {
			const res = await writeWorkspaceFile(deviceId, workspaceId, entry.path, content, base);
			conflictRevision = null;
			if (open === entry && file) {
				const size = new TextEncoder().encode(content).length;
				file = {
					...file,
					revision: res.entry.revision ?? file.revision,
					size,
					length: size,
					eof: true,
				};
				text = content;
			}
			void loadStatus();
			return "saved";
		} catch (err) {
			if (err instanceof FileConflictError) {
				conflictRevision = err.revision;
				return "conflict";
			}
			throw err;
		}
	}

	async function loadStatus() {
		try {
			const status = await workspaceFileStatus(deviceId, workspaceId);
			badges = gitBadges(status.entries);
			branch = status.branch ?? null;
		} catch {
			badges = new Map();
		}
	}

	async function loadFile(entry: FileEntry, append = false) {
		loading = true;
		failure = null;
		try {
			const res = await readWorkspaceFile(
				deviceId,
				workspaceId,
				entry.path,
				append && file ? file.offset + file.length : 0
			);
			if (!append) text = "";
			text += res.content ?? "";
			file = res;
		} catch (err) {
			failure = failureMessage(err);
		} finally {
			loading = false;
		}
	}

	/**
	 * What a failed read tells the person. An image past galopin's 8 MB cap
	 * answers `too_large` (413): the raw route serves from the same read, so
	 * no download link could succeed either — the message says the limit
	 * instead of showing the wire error.
	 */
	function failureMessage(err: unknown): string {
		if (err instanceof CodeApiError && err.status === 413) {
			return m["code.files.too_large"]();
		}
		return err instanceof Error ? err.message : m["code.files.could_not_read"]();
	}

	function select(entry: FileEntry) {
		if (entry.path !== open?.path && !mayLeave()) return;
		dirty = false;
		conflictRevision = null;
		open = entry;
		uploadDir = parentOf(entry.path);
		file = null;
		text = "";
		if (entry.redacted) return;
		void loadFile(entry);
	}

	function refresh() {
		refreshKey += 1;
		void loadStatus();
		// Unsaved edits stay: the editor is not re-read under them. A save
		// still finds out about a change on disk (the revision check).
		if (open && !open.redacted && !dirty) void loadFile(open);
	}

	/** The conflict's Reload: the file as it is on disk now. */
	async function reloadOpen() {
		conflictRevision = null;
		if (open) await loadFile(open);
	}

	function back() {
		if (!mayLeave()) return;
		dirty = false;
		conflictRevision = null;
		open = null;
	}

	// Only the turn key re-runs this: refresh() reads and bumps its own state.
	$effect(() => {
		void turnKey;
		untrack(refresh);
	});
</script>

<div class="flex h-full min-h-0 flex-col" data-testid="code-files">
	<div
		class="flex h-9 shrink-0 items-center gap-2 border-b border-gray-200 px-3 dark:border-gray-700"
	>
		{#if open}
			<button
				type="button"
				class="flex items-center gap-1 text-xs text-gray-600 hover:text-gray-900 dark:text-gray-300 dark:hover:text-white"
				aria-label={m["code.files.back_label"]()}
				onclick={back}
			>
				<IconArrowLeft class="size-3.5" />
				{m["code.files.back"]()}
			</button>
			<span
				class="min-w-0 flex-1 truncate font-mono text-xs text-gray-600 dark:text-gray-300"
				title={open.path}>{open.path}</span
			>
			{#if downloadable && !open.redacted}
				<a
					href={workspaceFileDownloadUrl(deviceId, workspaceId, open.path)}
					download={open.name}
					class="flex h-6 items-center gap-1 rounded-md px-1.5 text-xs text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700"
					data-testid="file-download-open"
				>
					<IconDownload class="size-3.5" />
					{m["code.files.download"]()}
				</a>
			{/if}
		{:else}
			<span class="min-w-0 flex-1 truncate text-xs text-gray-500">
				{branch ? m["code.files.on_branch"]({ branch }) : m["code.files.workspace_files"]()}
			</span>
		{/if}
		{#if folderDownloadable && !open}
			<a
				href={workspaceFileZipUrl(deviceId, workspaceId, uploadDir)}
				download
				class="flex size-6 items-center justify-center rounded-md text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700"
				title={m["code.files.zip_title"]({ folder: uploadFolder })}
				aria-label={m["code.files.zip_title"]({ folder: uploadFolder })}
				data-testid="folder-zip"
			>
				<IconZip class="size-3.5" />
			</a>
		{/if}
		{#if uploadable}
			<input
				bind:this={fileInput}
				type="file"
				multiple
				class="hidden"
				aria-label={m["code.files.upload_input_label"]()}
				data-testid="file-upload-input"
				onchange={(event) => {
					startUploads(itemsFromFiles(event.currentTarget.files ?? []));
					event.currentTarget.value = "";
				}}
			/>
			<input
				bind:this={folderInput}
				type="file"
				multiple
				webkitdirectory
				class="hidden"
				aria-label={m["code.files.upload_folder"]()}
				data-testid="folder-upload-input"
				onchange={(event) => {
					startUploads(itemsFromFiles(event.currentTarget.files ?? []));
					event.currentTarget.value = "";
				}}
			/>
			<button
				type="button"
				class="flex h-6 items-center gap-1 rounded-md px-1.5 text-xs text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700"
				title={m["code.files.upload_title"]({ folder: uploadFolder })}
				data-testid="file-upload"
				onclick={() => fileInput?.click()}
			>
				<IconUpload class="size-3.5" />
				{m["code.files.upload"]()}
			</button>
			<button
				type="button"
				class="flex size-6 items-center justify-center rounded-md text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700"
				title={m["code.files.upload_folder_title"]({ folder: uploadFolder })}
				aria-label={m["code.files.upload_folder"]()}
				data-testid="folder-upload"
				onclick={() => folderInput?.click()}
			>
				<IconFolderAdd class="size-3.5" />
			</button>
		{/if}
		<button
			type="button"
			class="flex size-6 items-center justify-center rounded-md text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-700"
			title={m["code.files.refresh"]()}
			aria-label={m["code.files.refresh_label"]()}
			onclick={refresh}
		>
			<IconRenew class="size-3.5 {loading ? 'animate-spin' : ''}" />
		</button>
	</div>

	{#if conflictAsk}
		<div
			class="shrink-0 border-b border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-100"
			role="alertdialog"
			aria-label={m["code.files.conflict_label"]()}
			data-testid="upload-conflicts"
		>
			<p class="mb-2 font-medium">
				{conflictAsk.count === 1
					? m["code.files.conflict_one"]({ name: conflictAsk.name })
					: m["code.files.conflict_many"]({ count: formatNumber(conflictAsk.count) })}
			</p>
			<div class="flex flex-wrap gap-2">
				<button
					type="button"
					class="rounded-md border border-amber-400 px-2 py-0.5 font-medium hover:bg-amber-100 dark:hover:bg-amber-900/40"
					data-testid="conflict-replace"
					onclick={() => conflictAsk?.answer("replace")}
					>{conflictAsk.count === 1
						? m["code.files.conflict_replace"]()
						: m["code.files.conflict_replace_all"]()}</button
				>
				<button
					type="button"
					class="rounded-md border border-amber-400 px-2 py-0.5 hover:bg-amber-100 dark:hover:bg-amber-900/40"
					data-testid="conflict-skip"
					onclick={() => conflictAsk?.answer("skip")}>{m["code.files.conflict_skip"]()}</button
				>
				<button
					type="button"
					class="rounded-md border border-amber-400 px-2 py-0.5 hover:bg-amber-100 dark:hover:bg-amber-900/40"
					data-testid="conflict-cancel"
					onclick={() => conflictAsk?.answer("cancel")}>{m["code.files.conflict_cancel"]()}</button
				>
			</div>
		</div>
	{/if}
	{#if uploads.length > 0}
		<ul
			class="shrink-0 border-b border-gray-200 text-xs dark:border-gray-700"
			data-testid="uploads"
		>
			{#each uploads as row (row.id)}
				<li
					class="px-3 py-1 {row.state === 'error'
						? 'text-red-600 dark:text-red-400'
						: 'text-gray-500'}"
					data-state={row.state}
				>
					<div class="flex items-center gap-2">
						<span class="min-w-0 flex-1 truncate" title={row.text}>{row.text}</span>
						{#if row.state === "working"}
							<button type="button" class="shrink-0 hover:underline" onclick={row.cancel}
								>{m["code.files.conflict_cancel"]()}</button
							>
						{:else}
							<button
								type="button"
								class="shrink-0 hover:underline"
								onclick={() => (uploads = uploads.filter((u) => u.id !== row.id))}
								>{m["code.files.upload_dismiss"]()}</button
							>
						{/if}
					</div>
					{#each row.failures.slice(0, 5) as failure (failure)}
						<p class="truncate text-red-600 dark:text-red-400" title={failure}>{failure}</p>
					{/each}
					{#if row.failures.length > 5}
						<p class="text-gray-500">
							{m["code.files.upload_more_failures"]({ count: row.failures.length - 5 })}
						</p>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}

	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="relative min-h-0 flex-1 overflow-auto"
		ondragover={onDragOver}
		ondragleave={() => (dragging = false)}
		ondrop={onDrop}
		data-testid="file-drop-zone"
	>
		{#if dragging}
			<div
				class="pointer-events-none absolute inset-1 z-10 flex items-center justify-center rounded-lg border-2 border-dashed border-blue-500 bg-blue-50/80 text-sm text-blue-700 dark:bg-blue-900/40 dark:text-blue-200"
				data-testid="file-drop-hint"
			>
				{m["code.files.drop_hint"]({ folder: uploadFolder })}
			</div>
		{/if}
		<div class={open ? "hidden" : "p-1"}>
			<CodeFileTree
				{deviceId}
				{workspaceId}
				path="."
				depth={0}
				{badges}
				selected={open?.path ?? null}
				{refreshKey}
				onselect={select}
				ondir={(dir) => (uploadDir = dir)}
				{downloadable}
				{folderDownloadable}
			/>
		</div>
		{#if open}
			{#if open.redacted}
				<p class="flex items-center gap-2 p-4 text-sm text-gray-500">
					<IconLocked class="size-4 shrink-0" />
					{m["code.files.redacted"]()}
				</p>
			{:else if failure}
				<p class="p-4 text-sm text-red-600 dark:text-red-400">{failure}</p>
			{:else if !file}
				<p class="p-4 text-sm text-gray-400">{m["code.files.loading"]()}</p>
			{:else if file.kind === "image" && isInlineRasterMime(file.mime)}
				<!-- Raster only: an SVG never takes this branch (it reads as
				     text), and the raw route 415s anything non-raster — this
				     MIME check is the Cerea-side backstop. -->
				<div class="flex justify-center p-4">
					<img
						src={workspaceFileRawUrl(deviceId, workspaceId, open.path)}
						alt={open.name}
						class="max-w-full rounded-sm border border-gray-200 dark:border-gray-700"
					/>
				</div>
				{#if writable}
					<p class="px-4 text-center text-xs text-gray-500" data-testid="file-read-only">
						{m["code.files.edit.image_read_only"]()}
					</p>
				{/if}
			{:else if file.kind === "binary"}
				<p class="p-4 text-sm text-gray-500">
					{m["code.files.binary"]({ size: humanSize(file.size) })}
				</p>
				{#if writable}
					<p class="px-4 text-xs text-gray-500" data-testid="file-read-only">
						{m["code.files.edit.binary_read_only"]()}
					</p>
				{/if}
			{:else}
				{#if !writable && saveBlocked}
					<p
						class="flex items-start gap-2 border-b border-gray-200 px-3 py-2 text-xs text-gray-500 dark:border-gray-700"
						data-testid="file-save-blocked"
					>
						<IconLocked class="mt-0.5 size-3.5 shrink-0" />
						{SAVE_BLOCKED[saveBlocked]()}
					</p>
				{/if}
				{#key open.path}
					<CodeFileViewer
						path={open.path}
						content={text}
						{writable}
						{readOnlyReason}
						onsave={saveFile}
						onreload={reloadOpen}
						bind:dirty
					/>
				{/key}
				{#if !file.eof}
					<div
						class="flex items-center gap-2 border-t border-gray-200 p-2 text-xs dark:border-gray-700"
					>
						<span class="text-gray-500"
							>{m["code.files.showing"]({
								shown: humanSize(file.offset + file.length),
								total: humanSize(file.size),
							})}</span
						>
						<button
							type="button"
							class="rounded-md border border-gray-200 px-2 py-0.5 hover:bg-gray-50 dark:border-gray-600 dark:hover:bg-gray-700"
							disabled={loading}
							onclick={() => open && loadFile(open, true)}
						>
							{m["code.files.load_more"]()}
						</button>
					</div>
				{/if}
			{/if}
		{/if}
	</div>
</div>
