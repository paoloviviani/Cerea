<!--
	A new coding session on one workspace of one paired device.

	The daemon decides what is possible: the provider list is fetched from
	it (never hardcoded here — the panel would drift from what the daemon
	can actually run), and creation is scoped to the workspace so the
	agent lands in the tree it was opened from. The first prompt is not
	asked here; the agent view's composer is that surface, so the person
	enrolls the device once and does everything else through Cerea.

	The dialog is phone-sized first: the operator's primary surface is a
	264px viewport, where the workspace path in the subtitle — one
	unbreakable word — used to drive the modal's fit-content width past
	the screen and clip the posture pills and the footer buttons. The
	path wraps (`break-words` breaks only words that cannot fit a line,
	so normal subtitles are untouched), the header text column can
	shrink (`min-w-0`, plus the right inset that keeps it clear of the
	close button), the padding steps down on phones, and the footer may
	wrap rather than clip.

	The provider select and the title input carry an inline
	`font-size: 16px` because their shared `s.INPUT` class is `text-sm`
	(14px) — WebKit auto-zooms the whole page on focus of any control
	under 16px, and `user-scalable=no` in the viewport meta does not stop
	it (WebKit ignores that attribute for accessibility).

	What actually broke on the operator's Safari after clicking Create,
	confirmed against a real WebKit engine (not just modern-Safari-should-
	support-it assumptions): a failed create mounts the error banner above
	the form, and on a short viewport (her 264x568 screenshot) that pushes
	the dialog's total content past the shell's `max-height` cap. The
	shell's own `overflow-y-auto` then clips the overflow rather than
	resizing — normal, expected behaviour — but the clip starts at
	scrollTop 0, so the newly-relevant footer (Cancel/Create) is exactly
	what falls into the clipped region, with no visible cue that scrolling
	the dialog itself would reveal it. Chromium and WebKit render this
	scenario at nearly the same total height, but WebKit's native
	`<select>` — at this 16px font size — measures 8px taller than
	Chromium's for the same markup (39px vs 47px, confirmed via
	`getBoundingClientRect`), which is exactly enough to tip the footer
	from "fits" (Chromium) to "clipped" (WebKit) at this viewport height.
	The fix does not fight the `<select>` sizing (that is native chrome,
	not something to override without its own cross-engine risk) — it
	makes the footer `sticky` to the bottom of the scrollable shell, so it
	is pinned in view regardless of how tall the content above it renders
	on a given engine.
-->
<script lang="ts">
	import { onMount } from "svelte";
	import Modal from "$lib/components/Modal.svelte";
	import IconCode from "~icons/carbon/code";
	import IconWarning from "~icons/carbon/warning-filled";
	import { createAgent, listProviders } from "$lib/codeApi";
	import type { CodeAgentSession, CodeWorkspace } from "$lib/types/CodeAgent";
	import * as s from "$lib/components/overlay/styles";

	interface Props {
		deviceId: string;
		workspace: CodeWorkspace;
		onclose: () => void;
		oncreated: (agent: CodeAgentSession) => void;
	}

	let { deviceId, workspace, onclose, oncreated }: Props = $props();

	let providers = $state<Array<{ id: string; available: boolean }>>([]);
	let provider = $state("");
	let posture = $state<"plan" | "build">("plan");
	let title = $state("");
	let busy = $state(true);
	let failure = $state<string | null>(null);

	onMount(async () => {
		try {
			const result = await listProviders(deviceId);
			providers = result.providers.filter((p) => p.available);
			provider = providers[0]?.id ?? "opencode";
		} catch (err) {
			failure = err instanceof Error ? err.message : "Could not read the daemon's providers.";
		} finally {
			busy = false;
		}
	});

	async function handleCreate() {
		if (busy) return;
		busy = true;
		failure = null;
		try {
			const created = await createAgent(deviceId, {
				provider,
				posture,
				...(title.trim() ? { title: title.trim() } : {}),
				workspaceId: workspace.id,
			});
			oncreated(created.agent);
			onclose();
		} catch (err) {
			failure = err instanceof Error ? err.message : "Could not create the agent.";
		} finally {
			busy = false;
		}
	}
</script>

<Modal width="max-w-md" closeButton labelledBy="agent-title" {onclose}>
	<div class="p-4 sm:p-6">
		<div class="mb-6 flex items-center gap-3">
			<div class="{s.STRIP_TILE} shrink-0">
				<IconCode class="size-5 text-blue-600" />
			</div>
			<!-- min-w-0 lets the column shrink below the path's min-content —
			     without it the flex row stays as wide as the unbreakable path
			     and everything past the first line clips. pr-8 keeps the
			     wrapped lines clear of the close button floating at top-right. -->
			<div class="min-w-0 pr-8">
				<h2 id="agent-title" class={s.TITLE}>New agent</h2>
				<p class="{s.SUBTITLE} break-words">In {workspace.name} — {workspace.path}</p>
			</div>
		</div>

		{#if failure}
			<div class="{s.ERROR} mb-4">
				<p class="flex items-center gap-1.5 font-medium">
					<IconWarning class="size-4" />
					Agent failed
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
			<label class={s.LABEL} for="agent-provider">Provider</label>
			{#if busy && providers.length === 0}
				<p class="text-sm text-ink-muted">Reading the daemon's providers…</p>
			{:else}
				<select
					id="agent-provider"
					class={s.INPUT}
					style="font-size: 16px;"
					bind:value={provider}
					disabled={busy || providers.length === 0}
				>
					{#if providers.length === 0}
						<option value="opencode">opencode</option>
					{/if}
					{#each providers as p (p.id)}
						<option value={p.id}>{p.id}</option>
					{/each}
				</select>
				<p class={s.HINT}>
					{providers.length > 0
						? "As configured on your daemon."
						: "No providers reported available; opencode is the default."}
				</p>
			{/if}

			<label class="{s.LABEL} mt-4" for="agent-title-input">Title (optional)</label>
			<input
				id="agent-title-input"
				class={s.INPUT}
				style="font-size: 16px;"
				placeholder="Refactor the login flow"
				maxlength={120}
				bind:value={title}
				disabled={busy}
			/>

			<span class="{s.LABEL} mt-4">Posture</span>
			<div class="flex flex-wrap gap-2">
				<button
					type="button"
					class={posture === "plan" ? s.PRIMARY : s.SECONDARY}
					onclick={() => (posture = "plan")}
					disabled={busy}
				>
					Plan
				</button>
				<button
					type="button"
					class={posture === "build" ? s.PRIMARY : s.SECONDARY}
					onclick={() => (posture = "build")}
					disabled={busy}
				>
					Build
				</button>
			</div>
			<p class={s.HINT}>
				{posture === "plan"
					? "Proposes; asks before it writes anything."
					: "Writes; still asks before anything destructive."}
			</p>

			<!-- flex-wrap, not fixed widths: side-by-side whenever both buttons
			     fit (they do from ~264px viewports up with the reduced
			     padding), wrapped instead of clipped when they do not.
			     `sticky bottom-0`, not a plain `mt-4` row: the modal shell
			     above this is `overflow-y-auto` with its own `max-height`,
			     and on a short viewport a failed create's error banner can
			     push the footer past that cap. A non-sticky footer then
			     sits in the clipped-and-unscrolled-to region — reachable
			     only by scrolling the dialog itself, with nothing to
			     suggest that's needed. Pinning it to the shell's own bottom
			     edge keeps Cancel/Create in view no matter how tall the
			     content above renders (this is what varies by engine —
			     WebKit's native `<select>` measures taller than Chromium's
			     for the same markup, which is what turned this from a
			     latent bug into a visible one on Safari). The negative
			     margins cancel this dialog's own `p-4 sm:p-6` so the
			     footer's background reaches the shell's edges instead of
			     leaving its padding as a gap below the buttons. -->
			<div
				class="sticky bottom-0 -mx-4 mt-4 -mb-4 flex flex-wrap justify-end gap-2 border-t border-line bg-white px-4 py-3 sm:-mx-6 sm:-mb-6 sm:px-6 dark:border-white/10 dark:bg-gray-800"
			>
				<button type="button" onclick={onclose} class={s.SECONDARY} disabled={busy}>
					Cancel
				</button>
				<button type="submit" class={s.PRIMARY} disabled={busy}>
					{busy ? "Creating…" : "Create agent"}
				</button>
			</div>
		</form>
	</div>
</Modal>
