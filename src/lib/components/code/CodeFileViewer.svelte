<!--
	A read-only CodeMirror 6 view of one file's text (the /code explorer,
	ADR 0090). CodeMirror and the file's language are imported on first use,
	so the chat bundle does not grow; the same view becomes the editor later.
-->
<script lang="ts">
	import { onDestroy } from "svelte";
	import type { EditorView } from "@codemirror/view";

	interface Props {
		/** Workspace-relative path: picks the syntax by file name. */
		path: string;
		content: string;
	}

	let { path, content }: Props = $props();

	let host = $state<HTMLDivElement>();
	let view: EditorView | null = null;
	let token = 0;

	$effect(() => {
		const doc = content;
		const name = path;
		const parent = host;
		if (!parent) return;
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
			view = new cmView.EditorView({
				parent,
				state: cmState.EditorState.create({
					doc,
					extensions: [
						cmView.lineNumbers(),
						cmState.EditorState.readOnly.of(true),
						cmView.EditorView.editable.of(false),
						cmLanguage.syntaxHighlighting(cmLanguage.defaultHighlightStyle, { fallback: true }),
						cmView.EditorView.theme({
							"&": { fontSize: "12px", backgroundColor: "transparent" },
							".cm-gutters": { backgroundColor: "transparent", border: "none" },
							".cm-content": { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" },
						}),
						...(language ? [language] : []),
					],
				}),
			});
		})();
	});

	onDestroy(() => {
		token += 1;
		view?.destroy();
		view = null;
	});
</script>

<div
	bind:this={host}
	class="min-h-0 overflow-auto text-gray-800 dark:text-gray-200"
	data-testid="file-viewer"
></div>
