<!--
	The Needs-you inbox: every pending permission/question across the person's
	paired machines, answerable inline, at the top of /code.

	One round trip per machine (`listPendingApprovals`, backed by galopin's
	`permissions.pending` op) refreshes the list on the same 8s cadence the
	device poll uses; answering uses the existing reply ops, so an answer
	given here, on an agent card, or on another device converges everywhere:
	each listed session also tails its own agent stream, and a
	permission.replied/question.resolved frame for a listed ask dismisses it
	immediately instead of waiting for the next poll tick.

	Each item renders the SAME card the agent transcript uses
	(`ToolApprovalCard` for a permission, `AskQuestion` for a question) from
	the SAME payload mapping (`$lib/utils/codeInboxCards`, shared with
	`machineTimeline`) — one card component, never a second rendering of an
	approval. The context line above each card names the device and session
	and deep-links to that agent card (`?device=&ws=&agent=`).

	The bar starts collapsed — one line, "N need you" — and expands on a click
	(the choice is remembered for the browser session). It leaves out the asks
	of the session open in the agent view: that view already shows them inline,
	so listing them here as well put the same question on screen twice. With
	only those pending the bar is not drawn, and it lists them again the moment
	the person opens another session.

	The same component serves three places, selected by props:

	- On /code (no props) it is the bar described above.
	- App-wide (`scroll`, `publish`, mounted by `NeedsYouShell` in the app
	  shell on every other page): the same collapsed bar, its list capped in
	  height so an expanded one never pushes the page out of view. It also
	  leaves out the sessions another instance has claimed on this screen,
	  and it publishes what is pending (`codeNeedsYou`) so the sidebar can
	  badge the Agents option.
	- Pinned (`sessions`, above the composer of a chat that started or
	  prompted agent sessions): lists only the asks of those sessions,
	  expanded by default (they are the reason the person is here) and
	  claims them, so the app-wide bar does not list them again.

	Nothing is requested while the tab is hidden: a poll tick is skipped and
	the first visible moment re-reads.

	Asks persist on the machine — there is deliberately no server-side queue
	here, only a read of live state. An unattended run that stalls on an ask
	is expected: the composer's Allow setting is the answer for those, not this
	inbox.
-->
<script lang="ts">
	import { m } from "$lib/paraglide/messages";
	import { onMount, untrack } from "svelte";
	import { replyOutcome } from "$lib/utils/permissionReply";
	import { browser } from "$app/environment";
	import { page } from "$app/state";
	import {
		claimSessions,
		clearPending,
		isClaimed,
		publishPending,
		type SessionRef,
	} from "$lib/stores/codeNeedsYou.svelte";
	import IconChevronDown from "~icons/carbon/chevron-down";
	import IconLaunch from "~icons/carbon/launch";
	import ToolApprovalCard from "$lib/components/chat/ToolApprovalCard.svelte";
	import AskQuestion from "$lib/components/chat/AskQuestion.svelte";
	import AlwaysCappedScope from "./AlwaysCappedScope.svelte";
	import FirstTurnScope from "./FirstTurnScope.svelte";
	import { ceilingOfPolicy, isCapped } from "$lib/utils/permissionRules";
	import { codeDeviceList } from "$lib/stores/codeDeviceList.svelte";
	import {
		listPendingApprovals,
		respondPermission,
		respondQuestion,
		getAgent,
		type PendingPermission,
		type PendingQuestion,
	} from "$lib/codeApi";
	import { codeAgentStream } from "$lib/codeAgentStream";
	import {
		inboxAgentHref,
		permissionToElicitation,
		questionToElicitation,
	} from "$lib/utils/codeInboxCards";
	import type { ElicitationAction, ElicitationValue } from "$lib/types/McpElicitation";
	import { MessageElicitationUpdateType, MessageUpdateType } from "$lib/types/MessageUpdate";

	interface InboxPermissionItem {
		kind: "permission";
		key: string;
		deviceId: string;
		deviceName: string;
		sessionId: string;
		workspaceId: string;
		sessionTitle: string;
		rootId?: string;
		request: PendingPermission["request"];
	}

	interface InboxQuestionItem {
		kind: "question";
		key: string;
		deviceId: string;
		deviceName: string;
		sessionId: string;
		workspaceId: string;
		sessionTitle: string;
		rootId?: string;
		request: PendingQuestion["request"];
	}

	type InboxItem = InboxPermissionItem | InboxQuestionItem;

	interface Props {
		/** Only these sessions' asks, expanded by default, claimed from the app-wide bar. */
		sessions?: SessionRef[];
		/** Publish what is pending for the sidebar badge (one instance per screen). */
		publish?: boolean;
		/** Cap the expanded list's height and scroll inside it. */
		scroll?: boolean;
	}

	let { sessions, publish = false, scroll = false }: Props = $props();
	const pinned = $derived(sessions !== undefined);

	const POLL_MS = 8000;

	let items = $state<InboxItem[]>([]);
	let loading = $state(true);

	// Collapsed unless the person opened it earlier in this browser session.
	const EXPANDED_KEY = "code.inbox.expanded";
	function readExpanded(): boolean {
		try {
			return globalThis.sessionStorage?.getItem(EXPANDED_KEY) === "1";
		} catch {
			return false;
		}
	}
	// Pinned asks start expanded and keep the choice for this view only.
	let collapsed = $state(untrack(() => (sessions !== undefined ? false : !readExpanded())));
	function toggleCollapsed() {
		collapsed = !collapsed;
		if (pinned) return;
		try {
			if (collapsed) globalThis.sessionStorage?.removeItem(EXPANDED_KEY);
			else globalThis.sessionStorage?.setItem(EXPANDED_KEY, "1");
		} catch {
			// Storage can be blocked; the bar still works for this page view.
		}
	}

	let fetchSeq = 0;
	/** One tail stream per listed session (`device:session` → its abort). */
	const tails = new Map<string, AbortController>();

	/** Paired machines that could answer: pending rows and offline ones have nothing to ask. */
	let eligibleDevices = $derived(
		codeDeviceList.devices.filter((d) => d.status === "paired" && d.online !== false)
	);

	/** The session open in the agent view, whose asks it already shows inline. */
	const openDeviceId = $derived(page.url.searchParams.get("device"));
	const openAgentId = $derived(page.url.searchParams.get("agent"));
	const listed = $derived(
		sessions
			? items.filter((item) =>
					sessions.some((s) => s.deviceId === item.deviceId && s.sessionId === item.sessionId)
				)
			: items.filter(
					(item) =>
						!(item.deviceId === openDeviceId && item.sessionId === openAgentId) &&
						!isClaimed({ deviceId: item.deviceId, sessionId: item.sessionId })
				)
	);
	let count = $derived(listed.length);

	function toItems(
		deviceId: string,
		deviceName: string,
		pending: { permissions: PendingPermission[]; questions: PendingQuestion[] }
	): InboxItem[] {
		const out: InboxItem[] = [];
		for (const p of pending.permissions ?? []) {
			out.push({
				kind: "permission",
				key: `${deviceId}:${p.sessionId}:perm:${p.request.id}`,
				deviceId,
				deviceName,
				sessionId: p.sessionId,
				workspaceId: p.workspaceId,
				sessionTitle: p.sessionTitle || p.sessionId,
				...(p.rootId ? { rootId: p.rootId } : {}),
				request: p.request,
			});
		}
		for (const q of pending.questions ?? []) {
			out.push({
				kind: "question",
				key: `${deviceId}:${q.sessionId}:que:${q.request.id}`,
				deviceId,
				deviceName,
				sessionId: q.sessionId,
				workspaceId: q.workspaceId,
				sessionTitle: q.sessionTitle || q.sessionId,
				...(q.rootId ? { rootId: q.rootId } : {}),
				request: q.request,
			});
		}
		return out;
	}

	async function refresh() {
		// A hidden tab asks nothing; the visibility handler re-reads on return.
		if (browser && document.hidden) return;
		const seq = ++fetchSeq;
		const devices = untrack(() => eligibleDevices);
		if (devices.length === 0) {
			if (seq !== fetchSeq) return;
			items = [];
			loading = false;
			syncTails();
			return;
		}
		const settled = await Promise.allSettled(
			devices.map(async (d) => ({
				device: d,
				pending: await listPendingApprovals(d.id),
			}))
		);
		if (seq !== fetchSeq) return;
		const next: InboxItem[] = [];
		for (const result of settled) {
			// An unreachable machine reads as "nothing pending", never a
			// failure: the panel stays clean on a flag-on/daemon-off
			// deployment, and the next tick re-asks.
			if (result.status !== "fulfilled") continue;
			next.push(...toItems(result.value.device.id, result.value.device.name, result.value.pending));
		}
		// Stable order: by device, then session, then ask — a poll tick must
		// not reshuffle the cards someone is reading.
		next.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
		items = next;
		loading = false;
		void refreshRootModes(next);
		syncTails();
	}

	/**
	 * The chip needs each asking subagent's ROOT mode, which the pending
	 * items don't carry: one snapshot read per distinct root, redone every
	 * poll so a mode switch shows up within a tick. Roots with pending
	 * subagent asks are few; unknown modes simply draw no chip.
	 */
	let rootModes = $state(new Map<string, string>());
	async function refreshRootModes(list: InboxItem[]) {
		const seq = fetchSeq;
		const roots = new Map<string, { deviceId: string; rootId: string }>();
		for (const item of list) {
			if (item.kind !== "permission" || !item.rootId || item.rootId === item.sessionId) continue;
			const key = `${item.deviceId}:${item.rootId}`;
			if (!roots.has(key)) roots.set(key, { deviceId: item.deviceId, rootId: item.rootId });
		}
		const settled = await Promise.allSettled(
			[...roots].map(async ([key, { deviceId, rootId }]) => {
				const detail = await getAgent(deviceId, rootId);
				return { key, mode: detail.agent?.permissionMode ?? null };
			})
		);
		if (seq !== fetchSeq) return;
		const modes = new Map<string, string>();
		for (const result of settled) {
			if (result.status !== "fulfilled" || !result.value.mode) continue;
			modes.set(result.value.key, result.value.mode);
		}
		rootModes = modes;
	}

	function dismiss(key: string) {
		items = items.filter((item) => item.key !== key);
		syncTails();
	}

	/**
	 * Tail each listed session's own agent stream (the same frames the agent
	 * card folds): a replied/resolved frame for a listed ask dismisses it
	 * here the moment it is answered anywhere, and a `reset` (the machine's
	 * process restarted) re-reads that device rather than trusting stale ids.
	 */
	function syncTails() {
		const wanted = new Map<string, InboxItem>();
		for (const item of untrack(() => items)) {
			const tailKey = `${item.deviceId}:${item.sessionId}`;
			if (!wanted.has(tailKey)) wanted.set(tailKey, item);
		}
		for (const [tailKey, abort] of tails) {
			if (!wanted.has(tailKey)) {
				abort.abort();
				tails.delete(tailKey);
			}
		}
		for (const [tailKey, item] of wanted) {
			if (tails.has(tailKey)) continue;
			const abort = new AbortController();
			tails.set(tailKey, abort);
			void tailSession(item.deviceId, item.sessionId, abort.signal);
		}
	}

	async function tailSession(deviceId: string, sessionId: string, signal: AbortSignal) {
		try {
			for await (const update of codeAgentStream(deviceId, sessionId, signal)) {
				if (signal.aborted) return;
				if (update.type === "reset") {
					void refresh();
					return;
				}
				if (
					update.type === MessageUpdateType.Elicitation &&
					update.subtype === MessageElicitationUpdateType.Resolved
				) {
					const key = untrack(() =>
						items.find(
							(item) =>
								item.deviceId === deviceId &&
								item.sessionId === sessionId &&
								item.request.id === update.elicitationId
						)
					)?.key;
					if (key) dismiss(key);
				}
			}
		} catch {
			// A failed tail keeps the poll as the backstop: the next tick
			// re-reads, and `syncTails` re-opens whatever is still listed.
		}
	}

	/**
	 * The agent card's own answer path (`AgentView.answerPermission`): the
	 * card's three buttons map onto the daemon's `permission.reply`
	 * vocabulary unmediated. A subagent's ask answers through its root with
	 * the child session, exactly as the parent view replies — otherwise it
	 * answers its owning session directly.
	 */
	async function answerPermission(
		item: InboxPermissionItem,
		action: ElicitationAction,
		scope?: "always"
	): Promise<{ ok: boolean; error?: string }> {
		try {
			const decision = action === "accept" ? (scope === "always" ? "always" : "once") : "reject";
			if (item.rootId && item.rootId !== item.sessionId) {
				await respondPermission(
					item.deviceId,
					item.rootId,
					item.request.id,
					decision,
					item.sessionId
				);
			} else {
				await respondPermission(item.deviceId, item.sessionId, item.request.id, decision);
			}
			dismiss(item.key);
			return { ok: true };
		} catch (err) {
			const outcome = replyOutcome(err, m["code.inbox.could_not_answer"]());
			if (outcome.ok) dismiss(item.key);
			return outcome;
		}
	}

	/**
	 * The agent card's own question path (`AgentView.answerQuestion`):
	 * `content` keys are `q0`, `q1`, … in question order, each the option
	 * label(s) picked — `respondQuestion` wants them back the same way the
	 * resolved event reads them.
	 */
	async function answerQuestion(
		item: InboxQuestionItem,
		action: ElicitationAction,
		content?: Record<string, ElicitationValue>
	): Promise<{ ok: boolean; error?: string }> {
		try {
			const answers = content
				? Object.keys(content)
						.sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)))
						.map((key) => {
							const value = content[key];
							return (Array.isArray(value) ? value : [value]).map(String);
						})
				: undefined;
			if (item.rootId && item.rootId !== item.sessionId) {
				await respondQuestion(
					item.deviceId,
					item.rootId,
					item.request.id,
					action === "accept" ? "accept" : "decline",
					answers,
					item.sessionId
				);
			} else {
				await respondQuestion(
					item.deviceId,
					item.sessionId,
					item.request.id,
					action === "accept" ? "accept" : "decline",
					answers
				);
			}
			dismiss(item.key);
			return { ok: true };
		} catch (err) {
			return {
				ok: false,
				error: err instanceof Error ? err.message : m["code.inbox.could_not_answer_question"](),
			};
		}
	}

	$effect(() => {
		if (!publish) return;
		publishPending(items.map((i) => ({ deviceId: i.deviceId, sessionId: i.sessionId })));
	});
	$effect(() => {
		if (!publish) return;
		return clearPending;
	});
	$effect(() => {
		if (!sessions) return;
		return claimSessions(sessions);
	});

	// Read as soon as there is a machine to ask, and again when the set of
	// eligible machines changes (the device list may land after this mounts,
	// as it does in the app shell); between those, the poll tick keeps it fresh.
	const eligibleKey = $derived(eligibleDevices.map((d) => d.id).join(","));
	$effect(() => {
		void eligibleKey;
		untrack(() => void refresh());
	});

	onMount(() => {
		if (!browser) return;
		const timer = setInterval(() => void refresh(), POLL_MS);
		const onVisible = () => {
			if (!document.hidden) void refresh();
		};
		document.addEventListener("visibilitychange", onVisible);
		return () => {
			document.removeEventListener("visibilitychange", onVisible);
			clearInterval(timer);
			fetchSeq += 1;
			for (const abort of tails.values()) abort.abort();
			tails.clear();
		};
	});
</script>

{#if browser && !loading && count > 0}
	<!-- Full-width strip pinned above the agent pane: on a phone it is the
	     first thing under the top bar (the whole screen, like a
	     conversation); on a desktop it spans the pane beside the rail. The
	     cards inside are the transcript's own, so both surfaces answer with
	     the same touch targets they already use on an agent card. -->
	<section
		aria-label={m["code.inbox.label"]()}
		data-testid={pinned ? "needs-you-pinned" : "needs-you-inbox"}
		class="pointer-events-auto bg-amber-50/60 dark:bg-amber-950/20 {pinned
			? 'mb-3 rounded-xl border border-amber-200 dark:border-amber-900/50'
			: 'border-b border-line'}"
	>
		<div class="mx-auto w-full {pinned ? 'px-3' : 'max-w-4xl px-4'} py-1.5">
			<button
				type="button"
				class="flex min-h-11 w-full items-center gap-2 text-left"
				aria-expanded={!collapsed}
				onclick={toggleCollapsed}
			>
				<span class="size-2.5 shrink-0 rounded-full bg-amber-500" aria-hidden="true"></span>
				<span class="text-sm font-semibold text-ink">{m["code.inbox.count"]({ count })}</span>
				{#if !collapsed}
					<span class="hidden text-xs text-ink-muted sm:inline">
						{m["code.inbox.hint"]()}
					</span>
				{/if}
				<IconChevronDown
					class="ml-auto size-4 shrink-0 text-ink-muted transition-transform {collapsed
						? '-rotate-90'
						: ''}"
				/>
			</button>
			{#if !collapsed}
				<ul
					class="mt-2 scrollbar-custom flex flex-col gap-4 pb-1 {pinned || scroll
						? 'max-h-[45dvh] overflow-y-auto'
						: ''}"
				>
					{#each listed as item (item.key)}
						<li
							class="rounded-xl border border-amber-200 bg-white p-3 shadow-sm dark:border-amber-900/50 dark:bg-gray-900"
							data-testid="needs-you-item"
						>
							<div class="mb-2 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs">
								<span class="min-w-0 truncate font-medium text-ink" title={item.sessionTitle}>
									{item.sessionTitle}
								</span>
								<span class="shrink-0 text-ink-faint">·</span>
								<span class="shrink-0 text-ink-muted">{item.deviceName}</span>
								<span
									class="shrink-0 rounded-full bg-amber-100 px-2 py-0.5 font-medium text-amber-800 dark:bg-amber-900/40 dark:text-amber-200"
								>
									{item.kind === "permission" ? item.request.tool : m["code.inbox.question"]()}
								</span>
								<a
									class="ml-auto inline-flex min-h-11 items-center gap-1 py-2 pl-2 font-medium text-blue-600 hover:underline sm:min-h-0 sm:py-0 dark:text-blue-400"
									href={inboxAgentHref(item.deviceId, item.workspaceId, item.sessionId)}
								>
									{m["code.inbox.open_agent"]()}
									<IconLaunch class="size-3.5" />
								</a>
							</div>
							{#if item.kind === "permission"}
								<!-- The machine's own ceiling, from its hello: the inbox has
								     no per-session read, and the ceiling is per machine. -->
								<AlwaysCappedScope
									capped={(tool) =>
										isCapped(
											ceilingOfPolicy(
												codeDeviceList.devices.find((d) => d.id === item.deviceId)?.policy
											),
											tool
										)}
								>
									<!-- An ask from a subagent (its session is not the root's)
									     says its first turn asks whatever the setting is. -->
									<FirstTurnScope
										deviceId={item.deviceId}
										rootId={item.rootId}
										childId={item.sessionId}
										rootMode={item.rootId
											? (rootModes.get(`${item.deviceId}:${item.rootId}`) ?? null)
											: null}
									>
										<ToolApprovalCard
											conversationId={item.sessionId}
											request={permissionToElicitation(item.request)}
											onanswer={(action, scope) => answerPermission(item, action, scope)}
										/>
									</FirstTurnScope>
								</AlwaysCappedScope>
							{:else}
								<AskQuestion
									conversationId={item.sessionId}
									request={questionToElicitation(item.request.id, item.request.questions)}
									onanswer={(action, content) => answerQuestion(item, action, content)}
								/>
							{/if}
						</li>
					{/each}
				</ul>
			{/if}
		</div>
	</section>
{/if}
