<!--
	A follow-up, with its licence attached — in the chat's own composer.

	The textarea is ChatInput with the default props: no mime types to offer
	(no upload affordances), no conversation to PATCH (so no web-search or
	knowledge or tool-approval pills either — the pill row hides with an
	empty allowlist), no hub mentions. What replaces the chat's model-picker
	row underneath is the posture: every follow-up carries a licence, and
	"plan" is the default — propose, never write, until the person opts into
	writes for this send. The default resets on every mount on purpose;
	writes are a decision made looking at the transcript, not a preference
	remembered from last week. There is no provider field: the agent already
	has one, and the daemon's send takes none.

	The reply is NOT inserted optimistically: the transcript stream echoes
	the person's message back, and the stream is the source of truth.
	Sending twice against a slow daemon would print twice.
-->
<script lang="ts">
	import ChatInput from "$lib/components/chat/ChatInput.svelte";
	import IconArrowUp from "~icons/lucide/arrow-up";
	import IconWarning from "~icons/carbon/warning-filled";
	import { isVirtualKeyboard } from "$lib/utils/isVirtualKeyboard";
	import type { AgentPosture } from "$lib/codeApi";

	interface Props {
		/** Called synchronously with the submit, before the POST — the view
		 * engages the column's follow and raises its pending placeholder. */
		onsend: (text: string, posture: AgentPosture) => Promise<void>;
	}

	let { onsend }: Props = $props();

	let draft = $state("");
	let posture = $state<AgentPosture>("plan");
	let focused = $state(false);
	let busy = $state(false);

	async function submit() {
		const message = draft.trim();
		if (!message || busy) return;
		busy = true;
		try {
			await onsend(message, posture);
			// Cleared only on a landed send: a refused follow-up keeps its text,
			// like every composer here.
			draft = "";
		} finally {
			busy = false;
		}
	}

	function postureClass(active: boolean): string {
		return active
			? "rounded-md bg-gray-200/80 px-1.5 py-0.5 font-medium text-gray-700 dark:bg-gray-700 dark:text-gray-200"
			: "rounded-md px-1.5 py-0.5 hover:text-gray-600 dark:hover:text-gray-300";
	}
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
			/>
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
		</div>
	</div>
</form>
<div
	class={{
		"mt-1.5 flex h-5 items-center self-stretch px-0.5 text-xs whitespace-nowrap text-gray-400/90 max-md:mb-2 max-sm:gap-2": true,
		"max-sm:hidden": focused && isVirtualKeyboard(),
	}}
>
	<div class="flex items-center gap-0.5" role="group" aria-label="Posture">
		<button
			type="button"
			onclick={() => (posture = "plan")}
			aria-pressed={posture === "plan"}
			class={postureClass(posture === "plan")}
			title="The agent proposes; it never writes."
		>
			Plan
		</button>
		<button
			type="button"
			onclick={() => (posture = "write")}
			aria-pressed={posture === "write"}
			class={postureClass(posture === "write")}
			title="The agent may edit files."
		>
			Write
		</button>
	</div>
	{#if posture === "write"}
		<span class="ml-1.5 flex items-center gap-1 text-amber-600 dark:text-amber-400">
			<IconWarning class="size-3" />
			May edit files
		</span>
	{/if}
</div>
