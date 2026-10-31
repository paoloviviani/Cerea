<script lang="ts">
	import { m } from "$lib/paraglide/messages";
	import { formatNumber } from "$lib/i18n/format";
	import { base } from "$app/paths";
	import EosIconsLoading from "~icons/eos-icons/loading";
	import CarbonChip from "~icons/carbon/chip";
	import CarbonChevronRight from "~icons/carbon/chevron-right";
	import CarbonCheckmark from "~icons/carbon/checkmark";
	import CarbonClose from "~icons/carbon/close";
	import BlockWrapper from "./BlockWrapper.svelte";
	import RunOutput from "./RunOutput.svelte";
	import RunFiles from "./RunFiles.svelte";
	import { getRunsStore } from "$lib/utils/execution/runs.svelte";
	import { isCodeExecutionDisabled } from "$lib/utils/execution/codeExecutionDisabled";
	import { browserExecutionEnabled } from "$lib/utils/execution/backend.svelte";
	import {
		describeRunFiles,
		noteLiveRunFiles,
		uploadAndDescribe,
	} from "$lib/utils/execution/runFiles";
	import { getMessageRunContext } from "$lib/utils/execution/messageContext";
	import {
		clearRunPause,
		createWakeLock,
		readRunPause,
		reportPaused,
		storeRunPause,
	} from "$lib/utils/execution/pauseResume";
	import { NO_OUTCOME_RECORDED } from "$lib/utils/execution/protocol";
	import { untrack } from "svelte";
	import { chatRunKey } from "$lib/utils/execution/keys";
	import type { MessageCodeExecutionRequestUpdate } from "$lib/types/MessageUpdate";
	import type { MessageCodeExecutionResolvedUpdate } from "$lib/types/MessageUpdate";
	import type { RunState } from "$lib/utils/execution/runs.svelte";
	import type { RunOutcome } from "$lib/utils/execution/protocol";

	/**
	 * The browser side of the `execute_code` tool: the parked code runs in the
	 * person's own ExecutionSession through the SAME RunsStore path a fence Run
	 * uses, so the outcome and the files the run created surface through the
	 * existing RunOutput → FileCard rendering untouched. When the run settles,
	 * its own output files (its deliverables) are uploaded to the persisted
	 * output store, and the outcome — with those references — is posted to the
	 * resolve endpoint once; that records it on the parked row and wakes the
	 * turn via the sweep. If the tab is gone before the run settles, nothing is
	 * posted and the sweeper's deadline turns the parked row into the
	 * "environment unavailable" fallback.
	 */
	interface Props {
		conversationId: string;
		request: MessageCodeExecutionRequestUpdate;
		/** Set on replay from the persisted update (sandbox paths dropped; `files` carries the durable references). */
		resolved?: MessageCodeExecutionResolvedUpdate;
	}

	let { conversationId, request, resolved }: Props = $props();

	let runsStore = getRunsStore();
	// The agent transcript never executes (see AgentView/SubagentCard): a
	// parked `execute_code` row there renders its persisted outcome only.
	const codeExecutionDisabled = isCodeExecutionDisabled();
	let runKey = $derived(runsStore ? chatRunKey(request.code) : "");
	let runState = $derived(runsStore && runKey ? runsStore.get(runKey) : undefined);

	// Kick the run exactly once per mounted card: the RunsStore dedups by key,
	// so a fence autorun of the same code settles this card too.
	let kicked = false;
	$effect(() => {
		if (resolved || codeExecutionDisabled || !runsStore || !runKey || kicked) return;
		kicked = true;
		runsStore.run(runKey, request.code);
	});

	const messageRun = getMessageRunContext();

	// --- Pause and resume (browser backend) -------------------------------
	// While the page is hidden its sandbox may be frozen or killed, and the
	// parked turn would expire waiting for it. `pausedWhilePending` is set when
	// the page hid with the run unfinished; on return the run restarts from the
	// start. A sandbox-level failure that lands in that window (a timer that
	// fired late on thaw) is the freeze, not the code, so it is never posted.
	const MAX_RESUME_RESTARTS = 3;
	let pageVisible = $state(
		typeof document === "undefined" || document.visibilityState !== "hidden"
	);
	let pausedWhilePending = false;
	let pausedEver = false;
	let restarts = 0;
	let resumedNote = $state(false);
	let deadlineMissed = $state(false);
	let showKeepOpen = $state(false);
	let posted = false;

	function runUnfinished(): boolean {
		if (!runsStore || !runKey || posted) return false;
		const st = runsStore.get(runKey);
		if (!st) return false;
		return (
			st.status === "loading" ||
			st.status === "running" ||
			st.status === "queued" ||
			Boolean(st.sandboxError)
		);
	}

	function onHidden() {
		pageVisible = false;
		if (pausedWhilePending || !runUnfinished()) return;
		pausedWhilePending = true;
		pausedEver = true;
		storeRunPause({
			conversationId,
			executionId: request.executionId,
			code: request.code,
			pausedAt: Date.now(),
		});
		reportPaused(conversationId, request.executionId);
	}

	// Restart the run from the start on a fresh sandbox, and ask the server for the
	// longer wait again since the new warm-up takes a while.
	function doRestart() {
		if (!runsStore) return;
		restarts += 1;
		resumedNote = true;
		reportPaused(conversationId, request.executionId);
		runsStore.restart(runKey, request.code);
	}

	// On return only a run that never got going is restarted: a warm-up still
	// `loading`. A `running` run is left alone (its worker is still working and
	// its variables and files matter to later calls); one that failed while the
	// page was away is restarted by the post effect below.
	function onVisible() {
		pageVisible = true;
		if (!pausedWhilePending) return;
		pausedWhilePending = false;
		if (!runsStore || restarts >= MAX_RESUME_RESTARTS || posted) return;
		if (runsStore.get(runKey)?.status === "loading") doRestart();
	}

	$effect(() => {
		if (resolved || codeExecutionDisabled || !runsStore || !pausable) return;
		const onVisibility = () => (document.visibilityState === "hidden" ? onHidden() : onVisible());
		const onPageShow = () => onVisible();
		document.addEventListener("visibilitychange", onVisibility);
		window.addEventListener("pagehide", onHidden);
		window.addEventListener("pageshow", onPageShow);
		return () => {
			document.removeEventListener("visibilitychange", onVisibility);
			window.removeEventListener("pagehide", onHidden);
			window.removeEventListener("pageshow", onPageShow);
		};
	});

	// The page was discarded while this run was pending and has been reloaded:
	// this mount is the resume. It runs the call once (the kick above) and asks
	// the server for the longer wait, since a reload takes a while.
	let reloadedFromPause = false;
	$effect(() => {
		if (resolved || codeExecutionDisabled || !runsStore || !pausable) return;
		untrack(() => {
			if (!readRunPause(request.executionId)) return;
			reloadedFromPause = true;
			resumedNote = true;
			reportPaused(conversationId, request.executionId);
		});
	});

	// Live feed: the run's files are in this message's registry the moment they
	// are listed and fingerprinted, so the card is the artifact card now and
	// after a reload alike.
	$effect(() => {
		const state = runState;
		const messageId = messageRun?.messageId;
		if (resolved || !state?.outputsCollected || !state.outputFiles?.length) return;
		if (!messageId || !runKey) return;
		noteLiveRunFiles(messageId, runKey, describeRunFiles(state.outputFiles));
	});

	// Post the outcome back exactly once per mounted card once the run settles.
	// A re-mounted card (navigation) may re-post; the endpoint's CAS answers 409
	// and the duplicate is silently dropped.
	//
	// A sandbox-level failure (worker load error, run timeout, forced restart)
	// settles the RunsStore entry into `sandboxError` rather than `outcome` —
	// see runs.svelte.ts. Without turning that into an outcome too, this
	// effect had nothing to post, so a genuine load error (the worker's own
	// `loadError` message) sat unposted until the sweeper's deadline collapsed
	// it into the generic "browser did not answer" fallback, indistinguishable
	// from a tab that was simply backgrounded. Posting it as a failed outcome
	// keeps the actual reason in the model's tool result.
	$effect(() => {
		const state = runState;
		if (resolved || posted || !state) return;
		if (state.status !== "done" && state.status !== "error") return;
		// A sandbox failure after the page was away is the freeze, not the code
		// (a timer that fired late on thaw): wait for the page to be back, then
		// restart instead of posting it. Past the restart cap it is posted.
		if (pausedEver && state.sandboxError && restarts < MAX_RESUME_RESTARTS) {
			if (pageVisible) untrack(doRestart);
			return;
		}
		// Wait for the async file listing before the one-shot POST: posting
		// on `status` alone races the listing, uploads nothing, and wins the
		// endpoint's CAS with `files: []` — the later upload's bytes then land
		// orphaned (no `fileRefs` on the recorded outcome). The flag always
		// flips (even when empty; sandbox failures set it immediately), so
		// this cannot hang the post past the park deadline.
		if (!state.outputsCollected) return;
		const outcome: RunOutcome | undefined =
			state.outcome ??
			(state.sandboxError
				? {
						ok: false,
						stdout: "",
						stderr: "",
						error: state.sandboxError,
						...(state.timeout ? { timeout: state.timeout } : {}),
					}
				: undefined);
		if (!outcome) return;
		posted = true;
		void (async () => {
			// One reference per produced file whether or not its upload worked: a
			// failed save is recorded `uploaded: false`, never silently absent.
			const fileRefs = await uploadAndDescribe(conversationId, state.outputFiles ?? []);
			if (messageRun?.messageId) noteLiveRunFiles(messageRun.messageId, runKey, fileRefs);
			const response = await fetch(`${base}/conversation/${conversationId}/code-execution`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Accept: "application/json" },
				body: JSON.stringify({
					executionId: request.executionId,
					outcome: {
						ok: outcome.ok,
						stdout: outcome.stdout,
						stderr: outcome.stderr,
						...(outcome.result ? { result: outcome.result } : {}),
						...(outcome.error ? { error: outcome.error } : {}),
						...(outcome.timeout ? { timeout: outcome.timeout } : {}),
						files: (state.outputFiles ?? []).map((f) => ({ path: f.path, size: f.size })),
						...(fileRefs.length ? { fileRefs } : {}),
					},
				}),
			}).catch(() => {
				// Nothing is waiting on the POST response: the sweeper's deadline is
				// the backstop, and a failed POST means the turn falls back the same
				// way an absent browser would.
				return undefined;
			});
			clearRunPause(request.executionId);
			// Refused as already answered after the page was away: the deadline passed
			// and the turn went on without this run.
			if (response?.status === 409 && (resumedNote || reloadedFromPause)) deadlineMissed = true;
		})();
	});

	/**
	 * Replay: the persisted outcome, with sandbox paths dropped (dead on
	 * replay — no live worker holds them) and, when the browser uploaded them,
	 * `persistedFiles` built from the durable references so a download card
	 * still renders, reading its bytes from the server instead of a sandbox.
	 */
	let resolvedRunState = $derived.by((): RunState | undefined => {
		if (!resolved) return undefined;
		const outcome = resolved.outcome;
		return {
			status: outcome.ok ? "done" : "error",
			outcome,
			startedAt: 0,
			finishedAt: 0,
			persistedFiles: resolved.files?.map((f) => ({
				name: f.name,
				size: f.size,
				sha256: f.sha256,
				uploaded: f.uploaded,
				downloadUrl: `${base}/conversation/${conversationId}/code-execution/output/${f.sha256}`,
			})),
		};
	});

	/**
	 * Which state RunOutput draws. Prefer the live run whenever this session
	 * still holds it settled: its RunsStore entry carries `outputFiles` whose
	 * bytes are still in the worker, which previews faster than a server round
	 * trip and works even if the upload above is still in flight or failed.
	 * The persisted `resolved` update streams back seconds after the run —
	 * still the same session — so switching to it on arrival would swap a
	 * working card for one that depends on the upload having landed. Fall
	 * back to the resolved state (its `persistedFiles`, if any) only on true
	 * replay, when a fresh page load has left the RunsStore with no run for
	 * this code.
	 */
	let displayState = $derived.by((): RunState | undefined => {
		if (runState && (runState.status === "done" || runState.status === "error")) {
			return runState;
		}
		return resolved ? resolvedRunState : runState;
	});

	// Files a run produced are the deliverable, not a log line, so they live
	// OUTSIDE the collapse: the code output folds away once the run settles, but
	// the file stays in its own box below (`showFiles={false}` on RunOutput keeps
	// it from also drawing them inside). Live-session bytes (`outputFiles`) win
	// over the persisted references (`persistedFiles`, used on replay), the same
	// precedence RunOutput uses.

	// Collapse the output the way a thinking section does (see
	// OpenReasoningResults.svelte): open while the code is actually running so
	// the person can watch it, then collapse once it settles — a completed run's
	// output is reference, not the thing they are waiting on. A replayed card
	// (`resolved`, fresh load) starts collapsed for the same reason. The header
	// stays the toggle, so an error or a finished result is one click away. A
	// failed run says "Failed" in the header and nothing more while folded: a
	// traceback means nothing to most users, and the model reads it anyway.
	let isRunning = $derived(
		!resolved &&
			runState != null &&
			(runState.status === "loading" ||
				runState.status === "running" ||
				runState.status === "queued")
	);
	let isOpen = $state(false);
	let failed = $derived(!!displayState && displayState.status === "error" && !isRunning);
	let duration = $derived.by(() => {
		const st = displayState;
		if (!st?.finishedAt || !st.startedAt) return "";
		const ms = st.finishedAt - st.startedAt;
		return ms < 100
			? ""
			: ms < 10_000
				? m["chat.run.seconds"]({
						value: formatNumber(ms / 1000, { minimumFractionDigits: 1, maximumFractionDigits: 1 }),
					})
				: m["chat.run.seconds"]({ value: formatNumber(Math.round(ms / 1000)) });
	});
	let pausable = $derived(browserExecutionEnabled());
	// The server gave up on this run while the page was away: the resolved
	// update carries no outcome.
	let missed = $derived(
		deadlineMissed ||
			(!!resolved &&
				resolved.outcome.error === NO_OUTCOME_RECORDED &&
				(resumedNote || !!readRunPause(request.executionId)))
	);

	// Said once a run has taken a moment: the run lives in this page.
	$effect(() => {
		if (!isRunning || !pausable) {
			showKeepOpen = false;
			return;
		}
		const timer = setTimeout(() => (showKeepOpen = true), 2000);
		return () => clearTimeout(timer);
	});

	// Keep the screen on while the run is going (best effort). The browser drops
	// the lock when the page hides, so it is taken again on return.
	$effect(() => {
		if (!pausable || !isRunning || !pageVisible) return;
		const lock = createWakeLock();
		void lock.acquire();
		return () => lock.release();
	});

	let startingPython = $derived(runState?.status === "loading" && !resolved);
	let wasRunning = $state(false);
	let initialized = $state(false);
	$effect(() => {
		if (!initialized) {
			initialized = true;
			if (isRunning) {
				isOpen = true;
				wasRunning = true;
				return;
			}
		}
		if (isRunning && !wasRunning) {
			isOpen = true;
		} else if (!isRunning && wasRunning) {
			isOpen = false;
		}
		wasRunning = isRunning;
	});
</script>

<BlockWrapper>
	<div
		class="my-3 min-w-[min(26rem,calc(100vw-4.5rem))] rounded-[14px] border border-gray-300/60 bg-gray-500/[0.06] dark:border-gray-600/50"
		data-testid="code-execution-card"
	>
		<button
			type="button"
			onclick={() => (isOpen = !isOpen)}
			aria-expanded={isOpen}
			aria-label={isOpen ? m["chat.code_card.collapse"]() : m["chat.code_card.expand"]()}
			class="flex w-full cursor-pointer items-center gap-2 px-4 py-3 text-left text-sm text-gray-700 select-none focus:outline-hidden dark:text-gray-300"
		>
			<CarbonChip class="text-gray-400" />
			<span class="font-medium">
				{isRunning
					? startingPython
						? m["chat.code_card.starting"]()
						: m["chat.code_card.running"]()
					: m["chat.code_card.ran"]()}
			</span>
			<span class="ml-auto flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400">
				{#if isRunning}
					<EosIconsLoading class="text-gray-400" />
				{:else if failed}
					<CarbonClose class="text-red-500 dark:text-red-400" />
					<span class="text-red-600 dark:text-red-400">{m["chat.code_card.failed"]()}</span>
				{:else if displayState}
					<CarbonCheckmark class="text-green-600 dark:text-green-500" />
					{#if duration}<span>{duration}</span>{/if}
				{/if}
			</span>
			<CarbonChevronRight
				class="size-3.5 flex-none text-gray-400 transition-transform duration-200 {isOpen
					? 'rotate-90'
					: ''}"
			/>
		</button>
		{#if missed}
			<p class="px-4 pb-3 text-xs text-gray-500 dark:text-gray-400" data-testid="code-card-hint">
				{m["chat.code_card.missed"]()}
			</p>
		{:else if resumedNote}
			<p class="px-4 pb-3 text-xs text-gray-500 dark:text-gray-400" data-testid="code-card-hint">
				{m["chat.code_card.resumed"]()}
			</p>
		{:else if isRunning && showKeepOpen}
			<p class="px-4 pb-3 text-xs text-gray-500 dark:text-gray-400" data-testid="code-card-hint">
				{m["chat.code_card.keep_open"]()}
			</p>
		{/if}
		{#if isOpen}
			<div class="space-y-2 border-t border-gray-300/50 px-4 py-3 dark:border-gray-600/40">
				<pre
					class="scrollbar-custom max-h-60 overflow-auto rounded-lg bg-gray-500/10 p-2 font-mono text-xs whitespace-pre-wrap"
					data-testid="run-code">{request.code}</pre>
				<RunOutput state={displayState} showFiles={false} bare />
			</div>
		{/if}
		<!-- Deliverables, never collapsed: rows under the header whatever the
		     code section is doing. -->
		<RunFiles state={displayState} />
	</div>
</BlockWrapper>
