<!--
	Workspace -> Agents (ADR 0109): the user's own auto-approval. When a coding session is on Auto,
	each kind of action either runs, is judged by a decision-model reviewer, or comes to the user.
	The user chooses the reviewer's on/off, model, threshold and instructions (inside a fixed frame)
	and the rows. "Test on the standard cases" shows how the reviewer would rule; it never blocks a
	save. The administrator only switches reviewers on for the deployment.
-->
<script lang="ts">
	import { onMount } from "svelte";
	import { base } from "$app/paths";
	import { m } from "$lib/paraglide/messages";
	import { PERMISSION_CLASSES, type PermissionClass } from "$lib/types/machineProtocol";
	import {
		INSTRUCTIONS_MAX,
		PER_CLASS_DEFAULTS,
		THRESHOLD_MAX,
		THRESHOLD_MIN,
		type ReviewAnswerer,
	} from "$lib/types/AgentReview";
	import { className } from "$lib/utils/autoApproval";
	import LocalAgentConnectors from "$lib/components/workspace/LocalAgentConnectors.svelte";

	/** The fence markers the server refuses; the same list, so the page says so before the save does. */
	const FENCE_MARKERS = ["<<<", ">>>", "```", "</", "[[", "]]", "BEGIN ", "END "];

	interface TestCase {
		id: string;
		label: string;
		expected: "allow" | "escalate";
		got: "allow" | "escalate" | "error";
		probability: number | null;
		ok: boolean;
		gating?: boolean;
	}

	let loading = $state(true);
	let loadFailure = $state<string | null>(null);
	let killSwitchOn = $state(false);
	let deploymentEnabled = $state(true);
	let catalogue = $state<"ok" | "unreachable" | "no_gateway">("ok");
	let decisionModels = $state<string[]>([]);

	let enabled = $state(false);
	let modelId = $state("");
	let threshold = $state(0.85);
	let instructions = $state("");
	let perClass = $state<Record<PermissionClass, ReviewAnswerer>>({ ...PER_CLASS_DEFAULTS });
	let saved = $state<string>("");

	let busy = $state(false);
	let failure = $state<string | null>(null);
	let note = $state<string | null>(null);
	let testing = $state(false);
	let testFailure = $state<string | null>(null);
	let testReport = $state<{ passed: boolean; cases: TestCase[] } | null>(null);

	const snapshot = () =>
		JSON.stringify([enabled, modelId, threshold, instructions.trim(), perClass]);
	const dirty = $derived(snapshot() !== saved);

	const marker = $derived(FENCE_MARKERS.find((x) => instructions.includes(x)) ?? null);
	const tooLong = $derived(instructions.trim().length > INSTRUCTIONS_MAX);
	const thresholdBad = $derived(
		!Number.isFinite(threshold) || threshold < THRESHOLD_MIN || threshold > THRESHOLD_MAX
	);
	const noModel = $derived(enabled && !modelId);
	const invalid = $derived(Boolean(marker) || tooLong || thresholdBad || noModel);

	function apply(data: {
		settings: {
			enabled: boolean;
			decisionModelId: string | null;
			threshold: number;
			instructions: string;
			perClass: Record<PermissionClass, ReviewAnswerer>;
		};
		deploymentEnabled: boolean;
		killSwitchOn: boolean;
		decisionModels: string[];
		catalogue: "ok" | "unreachable" | "no_gateway";
	}) {
		const s = data.settings;
		enabled = s.enabled;
		modelId = s.decisionModelId ?? "";
		threshold = s.threshold;
		instructions = s.instructions;
		perClass = { ...PER_CLASS_DEFAULTS, ...s.perClass, loop: "you" };
		deploymentEnabled = data.deploymentEnabled;
		killSwitchOn = data.killSwitchOn;
		decisionModels = data.decisionModels;
		catalogue = data.catalogue;
		saved = snapshot();
	}

	async function problem(response: Response): Promise<string> {
		const parsed = (await response.json().catch(() => null)) as { message?: string } | null;
		return parsed?.message ?? m["workspace.agents.error_status"]({ status: response.status });
	}

	async function load() {
		try {
			const response = await fetch(`${base}/api/v2/code/auto-approval/settings`);
			if (!response.ok) throw new Error(await problem(response));
			apply(await response.json());
		} catch (err) {
			loadFailure = err instanceof Error ? err.message : m["workspace.agents.read_failed"]();
		} finally {
			loading = false;
		}
	}
	onMount(load);

	async function runTest() {
		testing = true;
		testFailure = null;
		testReport = null;
		try {
			const response = await fetch(`${base}/api/v2/code/auto-approval/test`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					decisionModelId: modelId,
					threshold,
					instructions: instructions.trim(),
				}),
			});
			if (response.status === 501) {
				testFailure = m["workspace.agents.test.unavailable"]();
				return;
			}
			if (!response.ok) throw new Error(await problem(response));
			testReport = await response.json();
		} catch (err) {
			testFailure = err instanceof Error ? err.message : m["workspace.agents.test.failed"]();
		} finally {
			testing = false;
		}
	}

	async function save() {
		busy = true;
		failure = null;
		note = null;
		try {
			const response = await fetch(`${base}/api/v2/code/auto-approval/settings`, {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					enabled,
					decisionModelId: modelId || null,
					threshold,
					instructions: instructions.trim(),
					perClass,
				}),
			});
			if (!response.ok) throw new Error(await problem(response));
			apply(await response.json());
			note = m["workspace.agents.saved"]();
		} catch (err) {
			failure = err instanceof Error ? err.message : m["workspace.agents.save_failed"]();
		} finally {
			busy = false;
		}
	}

	const ANSWERS: ReviewAnswerer[] = ["run", "reviewer", "you"];
	const answerLabel = (who: ReviewAnswerer) =>
		who === "run"
			? m["workspace.agents.row.run"]()
			: who === "reviewer"
				? m["workspace.agents.row.reviewer"]()
				: m["workspace.agents.row.you"]();
	/** Credential paths always raise a card, so "runs" is not offered for secrets. */
	const offered = (c: PermissionClass) => (c === "secrets" ? ANSWERS.slice(1) : ANSWERS);

	const INPUT =
		"rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm dark:border-gray-600 dark:bg-gray-800";
	const BTN =
		"rounded-md bg-gray-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50 dark:bg-gray-100 dark:text-gray-900";
	const BTN2 =
		"rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium disabled:opacity-50 dark:border-gray-600";
	const FRAME =
		"border border-dashed border-gray-300 bg-gray-50 px-2 py-1.5 font-mono text-xs text-gray-600 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-400";
</script>

<div class="flex flex-col gap-8" data-testid="agents-settings">
	<section id="auto-approval" aria-labelledby="agents-title" class="flex flex-col gap-4">
		<div>
			<h2 id="agents-title" class="text-lg font-semibold">{m["workspace.agents.title"]()}</h2>
			<p class="mt-1 text-sm text-gray-600 dark:text-gray-400">{m["workspace.agents.intro"]()}</p>
			<a
				href="{base}/settings/review-log"
				class="mt-1 inline-block text-sm underline"
				data-testid="agents-log-link">{m["workspace.agents.log_link"]()}</a
			>
		</div>

		{#if loading}
			<p class="text-sm text-gray-500">{m["workspace.agents.loading"]()}</p>
		{:else if loadFailure}
			<p class="text-sm text-red-600" role="alert">{loadFailure}</p>
		{:else}
			{#if killSwitchOn}
				<p
					class="rounded-md border border-gray-300 bg-gray-50 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-800"
					data-testid="agents-killswitch"
				>
					{m["workspace.agents.killswitch"]()}
				</p>
			{:else if !deploymentEnabled}
				<p
					class="rounded-md border border-gray-300 bg-gray-50 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-800"
					data-testid="agents-not-enabled"
				>
					{m["workspace.agents.not_enabled"]()}
				</p>
			{/if}

			<label class="flex items-start gap-2 text-sm">
				<input type="checkbox" bind:checked={enabled} class="mt-0.5" data-testid="agents-enabled" />
				<span>
					<span class="font-medium">{m["workspace.agents.enabled"]()}</span>
					<span class="block text-gray-600 dark:text-gray-400"
						>{m["workspace.agents.enabled_detail"]()}</span
					>
				</span>
			</label>

			<div class="flex flex-col gap-1">
				<label for="agents-model" class="text-sm font-medium">{m["workspace.agents.model"]()}</label
				>
				{#if decisionModels.length === 0}
					<p class="text-sm text-gray-600 dark:text-gray-400" data-testid="agents-no-models">
						{catalogue === "unreachable"
							? m["workspace.agents.model_unreachable"]()
							: catalogue === "no_gateway"
								? m["workspace.agents.model_no_gateway"]()
								: m["workspace.agents.model_none"]()}
					</p>
					{#if modelId}<p class="text-sm">
							{m["workspace.agents.model_current"]({ model: modelId })}
						</p>{/if}
				{:else}
					<select id="agents-model" bind:value={modelId} class="{INPUT} max-w-sm">
						<option value="">{m["workspace.agents.model_choose"]()}</option>
						{#each decisionModels as id (id)}
							<option value={id}>{id}</option>
						{/each}
					</select>
				{/if}
			</div>

			<div class="flex flex-col gap-1">
				<label for="agents-threshold" class="text-sm font-medium"
					>{m["workspace.agents.threshold"]()}</label
				>
				<input
					id="agents-threshold"
					type="number"
					min={THRESHOLD_MIN}
					max={THRESHOLD_MAX}
					step="0.01"
					bind:value={threshold}
					class="{INPUT} w-28"
					aria-invalid={thresholdBad}
				/>
				<p class="text-sm text-gray-600 dark:text-gray-400">
					{m["workspace.agents.threshold_detail"]({ min: THRESHOLD_MIN, max: THRESHOLD_MAX })}
				</p>
				{#if thresholdBad}
					<p class="text-sm text-red-600" role="alert">
						{m["workspace.agents.threshold_bad"]({ min: THRESHOLD_MIN, max: THRESHOLD_MAX })}
					</p>
				{/if}
			</div>

			<div class="flex flex-col gap-1">
				<label for="agents-instructions" class="text-sm font-medium"
					>{m["workspace.agents.instructions"]()}</label
				>
				<p class="text-sm text-gray-600 dark:text-gray-400">
					{m["workspace.agents.instructions_detail"]()}
				</p>
				<div class="rounded-t-md border-b-0 {FRAME}" data-testid="agents-frame-top">
					<span class="mb-0.5 block font-sans font-medium"
						>{m["workspace.agents.frame_top_label"]()}</span
					>
					{m["workspace.agents.frame_top"]()}
				</div>
				<textarea
					id="agents-instructions"
					rows="8"
					bind:value={instructions}
					class="{INPUT} font-mono"
					aria-invalid={Boolean(marker) || tooLong}
				></textarea>
				<div class="rounded-b-md border-t-0 {FRAME}" data-testid="agents-frame-bottom">
					<span class="mb-0.5 block font-sans font-medium"
						>{m["workspace.agents.frame_bottom_label"]()}</span
					>
					{m["workspace.agents.frame_bottom"]()}
				</div>
				<p class="text-xs {tooLong ? 'text-red-600' : 'text-gray-500'}" data-testid="agents-count">
					{m["workspace.agents.count"]({ n: instructions.trim().length, max: INSTRUCTIONS_MAX })}
				</p>
				{#if marker}
					<p class="text-sm text-red-600" role="alert">
						{m["workspace.agents.marker"]({ marker: marker.trim() })}
					</p>
				{/if}
			</div>

			<fieldset class="flex flex-col gap-2">
				<legend class="text-sm font-medium">{m["workspace.agents.rows"]()}</legend>
				<p class="text-sm text-gray-600 dark:text-gray-400">
					{m["workspace.agents.rows_detail"]()}
				</p>
				<div class="overflow-x-auto">
					<table class="w-full max-w-xl text-sm">
						<tbody>
							{#each PERMISSION_CLASSES as c (c)}
								<tr class="border-t border-gray-200 dark:border-gray-700">
									<th scope="row" class="py-1.5 pr-3 text-left font-normal">{className(c)}</th>
									<td class="py-1.5">
										{#if c === "loop"}
											<span class="text-gray-600 dark:text-gray-400" data-testid="agents-row-loop"
												>{m["workspace.agents.row.you"]()} · {m[
													"workspace.agents.row.loop_fixed"
												]()}</span
											>
										{:else}
											<div role="radiogroup" aria-label={className(c)} class="flex flex-wrap gap-3">
												{#each offered(c) as who (who)}
													<label class="flex items-center gap-1">
														<input
															type="radio"
															name="row-{c}"
															value={who}
															checked={perClass[c] === who}
															onchange={() => (perClass[c] = who)}
															data-testid="agents-row-{c}-{who}"
														/>
														{answerLabel(who)}
													</label>
												{/each}
											</div>
										{/if}
									</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
				<p class="text-sm text-gray-600 dark:text-gray-400">
					{m["workspace.agents.escalate_list"]()}
				</p>
				<p class="text-sm text-gray-600 dark:text-gray-400" data-testid="agents-never-review">
					{m["workspace.agents.never_review"]()}
				</p>
			</fieldset>

			<div class="flex flex-col gap-2">
				<div class="flex flex-wrap items-center gap-2">
					<button
						type="button"
						class={BTN2}
						onclick={runTest}
						disabled={testing || !modelId || invalid}
						data-testid="agents-test"
					>
						{testing ? m["workspace.agents.test.running"]() : m["workspace.agents.test.button"]()}
					</button>
					<button
						type="button"
						class={BTN}
						onclick={save}
						disabled={busy || !dirty || invalid}
						data-testid="agents-save"
					>
						{busy ? m["workspace.agents.saving"]() : m["workspace.agents.save"]()}
					</button>
				</div>
				<p class="text-sm text-gray-600 dark:text-gray-400">
					{m["workspace.agents.test.detail"]()}
				</p>
				{#if testFailure}<p class="text-sm text-red-600" role="alert">{testFailure}</p>{/if}
				{#if testReport}
					<div data-testid="agents-test-report" class="text-sm">
						<p class="font-medium">
							{testReport.passed
								? m["workspace.agents.test.passed"]()
								: m["workspace.agents.test.not_passed"]()}
						</p>
						<ul class="mt-1 flex flex-col gap-0.5">
							{#each testReport.cases as c (c.id)}
								<li
									class={c.gating && !c.ok ? "font-medium text-red-600" : ""}
									data-gating={c.gating ? "true" : undefined}
									data-ok={c.ok ? "true" : "false"}
								>
									{c.ok ? "✓" : "✗"}
									{c.label}
									<span class="text-gray-500">
										· {c.expected === "allow"
											? m["workspace.agents.test.expect_allow"]()
											: m["workspace.agents.test.expect_escalate"]()}
										{#if c.probability !== null}· {Math.round(c.probability * 100)}%{/if}
										{#if c.gating}· {m["workspace.agents.test.gating"]()}{/if}
									</span>
								</li>
							{/each}
						</ul>
					</div>
				{/if}
				{#if failure}<p class="text-sm text-red-600" role="alert">{failure}</p>{/if}
				{#if note}<p class="text-sm text-green-700 dark:text-green-400" role="status">
						{note}
					</p>{/if}
			</div>
		{/if}
	</section>

	<LocalAgentConnectors />
</div>
