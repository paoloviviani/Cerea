<!--
	A workspace backed by a directory the person can see on their machine.

	One step, not two: the daemon serves whatever directory it is given, so
	the person types the absolute path (a checkout, e.g. ~/Pystino) and an
	optional title. The server refuses relative paths — they would resolve
	against whatever cwd the daemon process was born with, unguessable from
	here — and the daemon refuses paths it cannot serve. Either refusal
	arrives as the failure below, never as a row that pretends.
-->
<script lang="ts">
	import Modal from "$lib/components/Modal.svelte";
	import IconFolder from "~icons/carbon/folder";
	import IconWarning from "~icons/carbon/warning-filled";
	import { createWorkspace, suggestWorkspaceDirectories } from "$lib/codeApi";
	import type { CodeDirectory, CodeWorkspace } from "$lib/types/CodeAgent";
	import * as s from "$lib/components/overlay/styles";

	interface Props {
		deviceId: string;
		onclose: () => void;
		oncreated: (workspace: CodeWorkspace) => void;
	}

	let { deviceId, onclose, oncreated }: Props = $props();

	let path = $state("");
	let title = $state("");
	let busy = $state(false);
	let failure = $state<string | null>(null);

	// Debounced directory autocomplete: a keystroke schedules a lookup, and
	// only the *last* scheduled one is still pending by the time it fires —
	// an in-flight response for a stale prefix is simply never requested.
	let suggestions = $state<CodeDirectory[]>([]);
	let suggestOpen = $state(false);
	let suggestTimer: ReturnType<typeof setTimeout> | undefined;
	const SUGGEST_DEBOUNCE_MS = 250;

	function scheduleSuggest(prefix: string) {
		clearTimeout(suggestTimer);
		if (!prefix.trim()) {
			suggestions = [];
			suggestOpen = false;
			return;
		}
		suggestTimer = setTimeout(() => void runSuggest(prefix), SUGGEST_DEBOUNCE_MS);
	}

	async function runSuggest(prefix: string) {
		try {
			const { directories } = await suggestWorkspaceDirectories(deviceId, prefix);
			// The field may have moved on while this was in flight; only the
			// still-current prefix's answer gets shown.
			if (path !== prefix) return;
			suggestions = directories;
			suggestOpen = directories.length > 0;
		} catch {
			// Autocomplete is a nicety, not the form's own validation — a failed
			// lookup just leaves the list empty rather than surfacing a failure
			// banner over someone still typing.
			suggestions = [];
			suggestOpen = false;
		}
	}

	function selectSuggestion(dir: CodeDirectory) {
		path = dir.path;
		suggestOpen = false;
		suggestions = [];
	}

	async function handleCreate() {
		if (!path.trim() || busy) return;
		busy = true;
		failure = null;
		suggestOpen = false;
		try {
			const created = await createWorkspace(deviceId, {
				path: path.trim(),
				...(title.trim() ? { title: title.trim() } : {}),
			});
			oncreated(created.workspace);
			onclose();
		} catch (err) {
			failure = err instanceof Error ? err.message : "Could not create the workspace.";
		} finally {
			busy = false;
		}
	}
</script>

<Modal width="max-w-md" closeButton labelledBy="workspace-title" {onclose}>
	<div class="p-6">
		<div class="mb-6 flex items-center gap-3">
			<div class={s.STRIP_TILE}>
				<IconFolder class="size-5 text-blue-600" />
			</div>
			<div>
				<h2 id="workspace-title" class={s.TITLE}>Add a workspace</h2>
				<p class={s.SUBTITLE}>A directory on this machine the daemon serves agents from.</p>
			</div>
		</div>

		{#if failure}
			<div class="{s.ERROR} mb-4">
				<p class="flex items-center gap-1.5 font-medium">
					<IconWarning class="size-4" />
					Workspace failed
				</p>
				<p class="mt-1">{failure}</p>
			</div>
		{/if}

		<form
			onsubmit={(e) => {
				e.preventDefault();
				void handleCreate();
			}}
		>
			<label class={s.LABEL} for="workspace-path">Directory on the machine</label>
			<div class="relative">
				<input
					id="workspace-path"
					class={s.INPUT}
					placeholder="/home/you/checkouts/myrepo"
					maxlength={1024}
					autocomplete="off"
					role="combobox"
					aria-expanded={suggestOpen}
					aria-controls="workspace-path-listbox"
					bind:value={path}
					oninput={() => scheduleSuggest(path)}
					onfocus={() => {
						if (suggestions.length > 0) suggestOpen = true;
					}}
					onblur={() => {
						// A click on a suggestion fires onblur first (mousedown before
						// blur); pointerdown below cancels that native blur, so this
						// only ever closes the list for an unrelated blur.
						suggestOpen = false;
					}}
					disabled={busy}
				/>
				{#if suggestOpen}
					<div
						id="workspace-path-listbox"
						role="listbox"
						aria-label="Matching directories"
						class="absolute z-20 mt-1 scrollbar-custom max-h-48 w-full overflow-y-auto rounded-lg border border-gray-200 bg-white py-1 text-sm shadow-lg dark:border-gray-700 dark:bg-gray-900"
					>
						{#each suggestions as dir (dir.path)}
							<button
								type="button"
								role="option"
								aria-selected="false"
								class="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-gray-800 hover:bg-gray-50 focus:outline-hidden dark:text-gray-200 dark:hover:bg-gray-800/60"
								onpointerdown={(e) => e.preventDefault()}
								onclick={() => selectSuggestion(dir)}
							>
								<IconFolder class="size-3.5 shrink-0 text-gray-400" />
								<span class="min-w-0 flex-1 truncate">{dir.path}</span>
								{#if dir.isGitRepo}
									<span class="shrink-0 text-[10px] text-gray-400">git</span>
								{/if}
							</button>
						{/each}
					</div>
				{/if}
			</div>
			<p class={s.HINT}>Absolute path, as the daemon sees it — not this browser.</p>
			<label class="{s.LABEL} mt-4" for="workspace-name">Title (optional)</label>
			<input
				id="workspace-name"
				class={s.INPUT}
				placeholder="myrepo"
				maxlength={120}
				bind:value={title}
				disabled={busy}
			/>
			<div class="mt-4 flex justify-end gap-2">
				<button type="button" onclick={onclose} class={s.SECONDARY} disabled={busy}>
					Cancel
				</button>
				<button type="submit" class={s.PRIMARY} disabled={busy || !path.trim()}>
					{busy ? "Adding…" : "Add workspace"}
				</button>
			</div>
		</form>
	</div>
</Modal>
