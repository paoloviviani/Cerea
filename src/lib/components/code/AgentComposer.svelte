<!--
	A follow-up, with its licence attached.

	Every message carries a posture, and the posture defaults to "plan":
	propose, never write, until the person opts into writes for this agent.
	The default resets on every mount on purpose — writes are a decision made
	looking at the transcript, not a preference remembered from last week.
	The provider stays pickable (opencode-first; a daemon can run others
	later) as a plain input, because no live catalogue exists to choose from.

	The reply is NOT inserted optimistically: the timeline stream echoes the
	person's message back, and the stream is the transcript's source of truth.
	Sending twice against a slow daemon would print twice.
-->
<script lang="ts">
	import IconSend from "~icons/carbon/send";
	import IconWarning from "~icons/carbon/warning-filled";
	import { sendFollowUp, type AgentPosture } from "$lib/codeApi";
	import * as s from "$lib/components/overlay/styles";

	interface Props {
		agentId: string;
	}

	let { agentId }: Props = $props();

	let text = $state("");
	let provider = $state("opencode");
	let posture = $state<AgentPosture>("plan");
	let busy = $state(false);
	let failure = $state<string | null>(null);
	let box: HTMLTextAreaElement | undefined = $state();

	async function send() {
		const message = text.trim();
		if (!message || busy) return;
		busy = true;
		failure = null;
		try {
			await sendFollowUp(agentId, message, {
				provider: provider.trim() || "opencode",
				posture,
			});
			text = "";
			box?.focus();
		} catch (err) {
			failure = err instanceof Error ? err.message : "Could not send the follow-up.";
		} finally {
			busy = false;
		}
	}

	function onKeydown(event: KeyboardEvent) {
		if (event.key === "Enter" && !event.shiftKey) {
			event.preventDefault();
			void send();
		}
	}
</script>

<div class="border-t border-line px-4 pt-3 pb-4">
	{#if failure}
		<div class="{s.ERROR} mb-2">{failure}</div>
	{/if}
	<div class="flex flex-col gap-2">
		<textarea
			bind:this={box}
			bind:value={text}
			onkeydown={onKeydown}
			rows={2}
			placeholder="Follow up with the agent… (Enter to send, Shift+Enter for a newline)"
			class="{s.INPUT} scrollbar-custom resize-none"
			disabled={busy}
		></textarea>
		<div class="flex flex-wrap items-center gap-2">
			<label class="flex items-center gap-1.5 text-xs text-ink-muted">
				Provider
				<input
					bind:value={provider}
					class="{s.INPUT} w-28 px-2 py-1 text-xs"
					disabled={busy}
					aria-label="Agent provider"
				/>
			</label>
			<div
				class="flex overflow-hidden rounded-lg border border-line text-xs font-medium"
				role="group"
				aria-label="Posture"
			>
				<button
					onclick={() => (posture = "plan")}
					aria-pressed={posture === "plan"}
					class="px-2.5 py-1 {posture === 'plan'
						? 'bg-accent-subtle text-accent'
						: 'text-ink-muted hover:bg-sunken'}"
					disabled={busy}
					title="The agent proposes; it never writes."
				>
					Plan
				</button>
				<button
					onclick={() => (posture = "write")}
					aria-pressed={posture === "write"}
					class="px-2.5 py-1 {posture === 'write'
						? 'bg-accent-subtle text-accent'
						: 'text-ink-muted hover:bg-sunken'}"
					disabled={busy}
					title="The agent may edit files."
				>
					Write
				</button>
			</div>
			{#if posture === "write"}
				<span class="flex items-center gap-1 text-xs text-amber-700">
					<IconWarning class="size-3.5" />
					May edit files
				</span>
			{/if}
			<span class="flex-1"></span>
			<button onclick={() => void send()} class={s.PRIMARY} disabled={!text.trim() || busy}>
				<IconSend class="size-4" />
				{busy ? "Sending…" : "Send"}
			</button>
		</div>
	</div>
</div>
