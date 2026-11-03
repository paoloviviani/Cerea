<!--
	One file's text in CodeMirror 6 (the /code explorer, ADR 0090): read-only,
	and an editor when the file may be saved (issue #69). CodeMirror and the
	file's language are imported on first use, so the chat bundle does not grow.

	Edit turns the view editable, with a dirty marker, Save (also Ctrl/Cmd-S)
	and Discard. The parent does the saving (`onsave`), so it keeps the file's
	revision: a save that finds the file changed on disk reports a conflict, and
	this view offers Reload (drop the edits, show what is on disk) or Overwrite
	(save again over it). A text file that cannot be saved here (over 1 MiB, or
	only partly loaded) stays read-only with `readOnlyReason` shown in place of
	the Edit button. The parent mounts one per file ({#key path}), so editing
	never carries over to another file.
-->
<script lang="ts" module>
	/** What a save came to: the file is on disk, or it changed there first. */
	export type SaveOutcome = "saved" | "conflict";
</script>

<script lang="ts">
	import { m } from "$lib/paraglide/messages";
	import { onDestroy } from "svelte";
	import type { EditorView } from "@codemirror/view";

	interface Props {
		/** Workspace-relative path: picks the syntax by file name. */
		path: string;
		content: string;
		/** Whether files may be saved here at all (the deployment, the
		 * machine's policy and its galopin all allow it). */
		writable?: boolean;
		/** Why this file stays read-only although files may be saved, or null. */
		readOnlyReason?: string | null;
		/** Saves `text`; `overwrite` saves over the change on disk the last save
		 * reported. Throws for any other failure (its message is shown). */
		onsave?: (text: string, overwrite: boolean) => Promise<SaveOutcome>;
		/** Re-reads the file from disk (the conflict's Reload). */
		onreload?: () => Promise<void> | void;
		/** True while there are edits not saved yet. */
		dirty?: boolean;
	}

	let {
		path,
		content,
		writable = false,
		readOnlyReason = null,
		onsave,
		onreload,
		dirty = $bindable(false),
	}: Props = $props();

	let host = $state<HTMLDivElement>();
	let view: EditorView | null = null;
	let viewEditable = false;
	let viewPath = "";
	let token = 0;

	let editing = $state(false);
	/** The text in the editor while editing; null when not editing. */
	let draft = $state<string | null>(null);
	/** What the editor started from, or last saved: the dirty marker's baseline. */
	let saved = $state<string | null>(null);
	let saving = $state(false);
	let conflict = $state(false);
	let saveError = $state<string | null>(null);

	let canEdit = $derived(writable && !readOnlyReason && onsave !== undefined);

	$effect(() => {
		dirty = editing && draft !== null && draft !== saved;
	});

	function stopEditing() {
		editing = false;
		draft = null;
		saved = null;
		conflict = false;
		saveError = null;
	}

	function startEditing() {
		saved = content;
		draft = content;
		conflict = false;
		saveError = null;
		editing = true;
	}

	async function save(overwrite: boolean) {
		if (!onsave || draft === null || saving) return;
		const text = draft;
		saving = true;
		saveError = null;
		try {
			const outcome = await onsave(text, overwrite);
			if (outcome === "conflict") {
				conflict = true;
			} else {
				conflict = false;
				saved = text;
				// Back to the text, so typing (and Ctrl/Cmd-S) carries on after a click on Save.
				if (editing) view?.focus();
			}
		} catch (err) {
			saveError = err instanceof Error ? err.message : m["code.files.edit.save_failed"]();
		} finally {
			saving = false;
		}
	}

	async function reload() {
		stopEditing();
		await onreload?.();
	}

	$effect(() => {
		const name = path;
		const parent = host;
		const editable = editing;
		// While editing, the editor holds the text; outside it, the file's.
		const doc = editable ? (saved ?? content) : content;
		if (!parent) return;
		if (view && viewEditable === editable && viewPath === name) {
			// Still editing the same file: a save, or the parent echoing the saved
			// text back, must not rebuild the editor and lose the cursor.
			if (editable) return;
			if (view.state.doc.toString() === doc) return;
		}
		const mine = ++token;
		void (async () => {
			const [cmView, cmState, cmLanguage, cmData] = await Promise.all([
				import("@codemirror/view"),
				import("@codemirror/state"),
				import("@codemirror/language"),
				import("@codemirror/language-data"),
			]);
			const description = cmLanguage.LanguageDescription.matchFilename(cmData.languages, name);
			const language = description ? await description.load().catch(() => null) : null;
			if (mine !== token) return;
			view?.destroy();
			viewEditable = editable;
			viewPath = name;
			view = new cmView.EditorView({
				parent,
				state: cmState.EditorState.create({
					doc,
					extensions: [
						cmView.lineNumbers(),
						cmState.EditorState.readOnly.of(!editable),
						cmView.EditorView.editable.of(editable),
						...(editable
							? [
									cmView.keymap.of([
										{
											key: "Mod-s",
											preventDefault: true,
											// During a conflict the choice is the buttons' to make.
											run: () => {
												if (!conflict) void save(false);
												return true;
											},
										},
									]),
									cmView.EditorView.updateListener.of((update) => {
										if (update.docChanged) draft = update.state.doc.toString();
									}),
								]
							: []),
						cmLanguage.syntaxHighlighting(cmLanguage.defaultHighlightStyle, { fallback: true }),
						cmView.EditorView.theme({
							"&": { fontSize: "12px", backgroundColor: "transparent" },
							"&.cm-focused": { outline: "none" },
							".cm-gutters": { backgroundColor: "transparent", border: "none" },
							".cm-content": { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" },
						}),
						...(language ? [language] : []),
					],
				}),
			});
			if (editable) view.focus();
		})();
	});

	onDestroy(() => {
		token += 1;
		view?.destroy();
		view = null;
	});

	const BUTTON =
		"rounded-md border border-gray-200 px-2 py-0.5 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:hover:bg-gray-700";
</script>

{#if writable && onsave}
	<div
		class="flex min-h-8 flex-wrap items-center gap-2 border-b border-gray-200 px-2 py-1 text-xs dark:border-gray-700"
		data-testid="file-editor-bar"
	>
		{#if editing}
			<span class="flex min-w-0 flex-1 items-center gap-1.5 text-gray-500" data-testid="file-dirty">
				{#if dirty}
					<span class="size-2 shrink-0 rounded-full bg-amber-500" aria-hidden="true"></span>
					{m["code.files.edit.unsaved"]()}
				{:else}
					{m["code.files.edit.no_changes"]()}
				{/if}
			</span>
			<button
				type="button"
				class={BUTTON}
				data-testid="file-discard"
				disabled={saving}
				onclick={stopEditing}>{m["code.files.edit.discard"]()}</button
			>
			<button
				type="button"
				class="{BUTTON} font-medium"
				data-testid="file-save"
				title={m["code.files.edit.save_title"]()}
				disabled={saving || !dirty || conflict}
				onclick={() => save(false)}
				>{saving ? m["code.files.edit.saving"]() : m["code.files.edit.save"]()}</button
			>
		{:else if canEdit}
			<span class="flex-1"></span>
			<button type="button" class={BUTTON} data-testid="file-edit" onclick={startEditing}
				>{m["code.files.edit.edit"]()}</button
			>
		{:else if readOnlyReason}
			<span class="flex-1 text-gray-500" data-testid="file-read-only">{readOnlyReason}</span>
		{/if}
	</div>
	{#if conflict}
		<div
			class="flex flex-wrap items-center gap-2 border-b border-amber-300 bg-amber-50 px-2 py-1.5 text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200"
			role="alert"
			data-testid="file-conflict"
		>
			<span class="min-w-0 flex-1">
				<span class="font-medium">{m["code.files.edit.conflict_title"]()}</span>
				{m["code.files.edit.conflict_text"]()}
			</span>
			<button
				type="button"
				class={BUTTON}
				data-testid="file-conflict-reload"
				disabled={saving}
				onclick={reload}>{m["code.files.edit.reload"]()}</button
			>
			<button
				type="button"
				class="{BUTTON} font-medium"
				data-testid="file-conflict-overwrite"
				disabled={saving}
				onclick={() => save(true)}>{m["code.files.edit.overwrite"]()}</button
			>
		</div>
	{/if}
	{#if saveError}
		<p class="px-2 py-1 text-xs text-red-600 dark:text-red-400" role="alert">{saveError}</p>
	{/if}
{/if}
<div
	bind:this={host}
	class="min-h-0 overflow-auto text-gray-800 dark:text-gray-200"
	data-testid="file-viewer"
	data-editing={editing ? "true" : undefined}
></div>
