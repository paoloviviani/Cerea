<script lang="ts">
	import type { ElicitationAction, ElicitationRequestPayload } from "$lib/types/McpElicitation";
	import type { MessageElicitationResolvedUpdate } from "$lib/types/MessageUpdate";
	import CarbonCheckmark from "~icons/carbon/checkmark";
	import CarbonClose from "~icons/carbon/close";
	import CarbonChevronRight from "~icons/carbon/chevron-right";
	import BlockWrapper from "./BlockWrapper.svelte";
	import { sendElicitationAnswer } from "$lib/utils/sendElicitationAnswer";

	/**
	 * The tool-approval gate (ADR 0075): a dedicated card, not the generic
	 * `ElicitationForm` select — an approval needs exactly three buttons
	 * (accept once, accept for longer, deny), never a dropdown. Wired the
	 * same way as any other elicitation: `sendElicitationAnswer` posts to the
	 * same endpoint, with the scope carried in `content`.
	 */
	interface Props {
		conversationId: string;
		request: ElicitationRequestPayload;
		expiresAt?: number;
		resolved?: MessageElicitationResolvedUpdate;
		/**
		 * Pluggable answer path: when set, the card answers through it instead
		 * of `sendElicitationAnswer`, and the second button reads "Always
		 * allow" rather than "Allow for this conversation" — the caller owns
		 * the semantics (the coding-agent surface answers a daemon permission
		 * through its own forwarder; `scope: "always"` there is the daemon's
		 * own `permission.reply` vocabulary — the rest of this session — not
		 * a conversation-scoped grant).
		 */
		onanswer?: (
			action: ElicitationAction,
			scope?: "always"
		) => Promise<{ ok: boolean; error?: string }>;
		/** The allow button's label; the agent path approves a single request. */
		approveLabel?: string;
	}

	let {
		conversationId,
		request,
		expiresAt,
		resolved,
		onanswer,
		approveLabel = "Allow once",
	}: Props = $props();

	const toolApproval = $derived(request.toolApproval);

	let submitting = $state<"once" | "conversation" | "always" | "deny" | null>(null);
	let error = $state<string | null>(null);
	/** Settles the card without waiting for the run to echo the outcome back. */
	let submitted = $state<ElicitationAction | null>(null);

	let now = $state(Date.now());
	let outcome = $derived(resolved?.action ?? submitted);
	let expired = $derived(!outcome && expiresAt !== undefined && now >= expiresAt);
	let open = $derived(!outcome && !expired);

	$effect(() => {
		if (!open || expiresAt === undefined) return;
		const period = expiresAt - now > 120_000 ? 30_000 : 1_000;
		const timer = setInterval(() => (now = Date.now()), period);
		return () => clearInterval(timer);
	});

	let timeLeft = $derived.by(() => {
		if (expiresAt === undefined) return "";
		const seconds = Math.max(0, Math.ceil((expiresAt - now) / 1000));
		if (seconds >= 3_600) return `${Math.floor(seconds / 3_600)}h left`;
		if (seconds >= 120) return `${Math.floor(seconds / 60)}m left`;
		return `${seconds}s left`;
	});

	let showArgs = $state(false);

	/**
	 * Who is asking: a subagent's approval carries the child's session (set
	 * by the coding-agent stream bridge, never by chat) — the card names it
	 * ("Subagent ‹title›"), since the tool and its args alone do not say
	 * which session is blocked on this click.
	 */
	let subagentLabel = $derived.by(() => {
		if (!request.childSessionId) return null;
		const title = request.childTitle?.trim();
		return title ? `Subagent ${title}` : "Subagent";
	});

	let settledLabel = $derived.by(() => {
		if (outcome === "accept") return "Allowed";
		if (outcome === "decline") return "Denied";
		if (resolved?.resolution === "expired" || expired) return "Timed out — denied";
		if (resolved?.resolution === "aborted") return "Cancelled with the response";
		if (resolved?.resolution === "withdrawn") return "Stopped waiting";
		return "Denied";
	});

	async function send(action: ElicitationAction, scope?: "once" | "conversation" | "always") {
		if (submitting || !open) return;
		submitting = scope ?? "deny";
		error = null;
		if (onanswer) {
			const result = await onanswer(action, scope === "always" ? "always" : undefined);
			submitting = null;
			if (!result.ok) {
				error = result.error ?? "The answer did not go through.";
				return;
			}
			submitted = action;
			return;
		}
		const result = await sendElicitationAnswer({
			conversationId,
			elicitationId: request.elicitationId,
			action,
			...(scope ? { content: { scope } } : {}),
		});
		submitting = null;
		if (!result.ok) {
			error = result.error;
			return;
		}
		submitted = action;
	}

	/**
	 * galopin's own approvals (`session_spawn`, `session_send`; PROTOCOL.md §6
	 * "Agent tools") are recognised by the request itself, never by the tool's
	 * name, exactly as the machine does. They read as a person-facing summary
	 * of what the model is about to do — the whole prompt or message, since a
	 * truncated preview would approve text the person never saw — and offer no
	 * "always": the machine never remembers one, so a button for it would lie.
	 * Only on the agent surface (`onanswer`): in chat the args are a model's own
	 * tool arguments, which may say anything.
	 */
	const galopin = $derived(onanswer !== undefined && toolApproval?.args?.galopin === true);
	type Fact = { label: string; value: string; long?: boolean };
	const galopinFacts = $derived.by((): Fact[] => {
		const args = toolApproval?.args;
		if (!galopin || !args) return [];
		const text = (value: unknown) => (typeof value === "string" ? value : "");
		const facts: Fact[] = [];
		if (toolApproval?.tool === "session_spawn") {
			facts.push({ label: "Title", value: text(args.title) });
			facts.push({ label: "Mode", value: text(args.modeId) });
			facts.push({ label: "Model", value: text(args.modelId) || "this session's model" });
			facts.push({ label: "Prompt", value: text(args.prompt), long: true });
		} else if (toolApproval?.tool === "session_send") {
			const target = args.target as { title?: unknown } | undefined;
			facts.push({ label: "To", value: text(target?.title) });
			facts.push({ label: "Message", value: text(args.text), long: true });
			if (typeof args.hop === "number")
				facts.push({
					label: "Hop",
					value:
						args.hop > 3
							? `${args.hop}. This chain has passed 3 hops, so each further message needs you`
							: `${args.hop} of 3`,
				});
		}
		return facts.filter((fact) => fact.value !== "");
	});

	const argsJson = $derived.by(() => {
		if (!toolApproval) return "";
		try {
			return JSON.stringify(toolApproval.args, null, 2);
		} catch {
			return String(toolApproval.args);
		}
	});
</script>

{#if !toolApproval}
	<!-- Malformed payload; nothing safe to render. -->
{:else if !open}
	<BlockWrapper>
		<div class="flex max-w-full flex-col items-start gap-1 select-none">
			<button
				type="button"
				class="group/header flex max-w-full cursor-pointer items-center gap-1 text-left whitespace-nowrap focus:outline-hidden"
				onclick={() => (showArgs = !showArgs)}
				aria-label={showArgs ? "Collapse" : "Expand"}
			>
				<span
					class="shrink-0 text-sm font-medium text-gray-500 transition-colors group-hover/header:text-gray-600 dark:text-gray-400 dark:group-hover/header:text-gray-300"
				>
					{#if subagentLabel}{subagentLabel} ·
					{/if}{settledLabel}
				</span>
				<code
					class="min-w-0 truncate rounded-sm bg-blue-50 px-1 py-px font-mono text-xs text-blue-700 opacity-90 dark:bg-blue-900/30 dark:text-blue-300"
					>{toolApproval.tool}</code
				>
				<CarbonChevronRight
					class="size-3.5 shrink-0 transition-all duration-200 group-hover/header:text-gray-600 dark:group-hover/header:text-gray-300 {showArgs
						? 'rotate-90 text-gray-600 dark:text-gray-300'
						: 'text-gray-400'}"
				/>
			</button>
		</div>

		{#if showArgs}
			<div class="mt-2 mb-4 space-y-1 text-gray-500 dark:text-gray-400">
				<div class="text-[10px] font-semibold text-gray-400 uppercase dark:text-gray-500">
					Arguments
				</div>
				<pre
					class="overflow-x-auto rounded-lg bg-gray-100 p-2 font-mono text-xs whitespace-pre-wrap text-gray-700 dark:bg-gray-800/70 dark:text-gray-300">{argsJson}</pre>
			</div>
		{/if}
	</BlockWrapper>
{:else}
	<BlockWrapper>
		<div
			class="rounded-xl border border-gray-200 bg-gray-50/60 p-4 dark:border-gray-700 dark:bg-gray-800/40"
		>
			<div class="flex flex-wrap items-baseline gap-x-2 gap-y-1">
				<span class="text-sm font-medium text-gray-700 dark:text-gray-200"
					>{#if subagentLabel}{subagentLabel} ·
					{/if}{galopin ? "Agent action" : "Tool approval"}</span
				>
				<span class="text-xs text-gray-500 dark:text-gray-400">
					wants to call <code
						class="rounded-sm bg-blue-50 px-1 py-px font-mono text-blue-700 dark:bg-blue-900/30 dark:text-blue-300"
						>{toolApproval.tool}</code
					>
				</span>
				{#if expiresAt !== undefined}
					<span class="ml-auto text-xs text-gray-400 tabular-nums dark:text-gray-500">
						{timeLeft}
					</span>
				{/if}
			</div>

			{#if galopin && galopinFacts.length > 0}
				<dl class="mt-3 space-y-2 text-sm" data-testid="galopin-approval">
					{#each galopinFacts as fact (fact.label)}
						<div class={fact.long ? "" : "flex flex-wrap gap-x-2"}>
							<dt class="text-xs font-medium text-gray-500 dark:text-gray-400">{fact.label}</dt>
							<dd class="min-w-0 text-gray-800 dark:text-gray-100">
								{#if fact.long}
									<pre
										class="mt-1 max-h-48 overflow-auto rounded-lg bg-gray-100 p-2 font-sans text-sm whitespace-pre-wrap text-gray-700 dark:bg-gray-800/70 dark:text-gray-200">{fact.value}</pre>
								{:else}
									{fact.value}
								{/if}
							</dd>
						</div>
					{/each}
				</dl>
			{:else}
				<pre
					class="mt-3 max-h-48 overflow-auto rounded-lg bg-gray-100 p-2 font-mono text-xs whitespace-pre-wrap text-gray-600 dark:bg-gray-800/70 dark:text-gray-300">{argsJson}</pre>
			{/if}

			{#if error}
				<p class="mt-3 text-xs text-red-600 dark:text-red-400">{error}</p>
			{/if}

			<div class="mt-4 flex flex-wrap gap-2">
				<button
					type="button"
					onclick={() => send("accept", onanswer ? undefined : "once")}
					disabled={submitting !== null}
					class="rounded-lg bg-gray-900 px-3 py-1.5 text-sm text-white hover:bg-gray-700 disabled:opacity-50 dark:bg-gray-200 dark:text-gray-900 dark:hover:bg-white"
				>
					<CarbonCheckmark class="mr-1 inline size-3.5 align-text-bottom" />
					{approveLabel}
				</button>
				{#if !galopin}
					<button
						type="button"
						onclick={() => send("accept", onanswer ? "always" : "conversation")}
						disabled={submitting !== null}
						class="rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100 disabled:opacity-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
					>
						{onanswer ? "Always allow" : "Allow for this conversation"}
					</button>
				{/if}
				<button
					type="button"
					onclick={() => send("decline")}
					disabled={submitting !== null}
					class="rounded-lg px-3 py-1.5 text-sm text-gray-500 hover:bg-gray-100 disabled:opacity-50 dark:text-gray-400 dark:hover:bg-gray-700"
				>
					<CarbonClose class="mr-1 inline size-3.5 align-text-bottom" />
					Deny
				</button>
			</div>
		</div>
	</BlockWrapper>
{/if}
