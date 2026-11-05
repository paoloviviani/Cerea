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

	/** The fence markers the server refuses; the same list, so the page says so before the save does. */
	const FENCE_MARKERS = ["<<<", ">>>", "```", "</", "[[", "]]", "BEGIN ", "END "];

	interface TestCase {
		id: string;
		label: string;
		expected: "allow" | "escalate";
		got: "allow" | "escalate" | "error";
		probability: number | null;
		ok: boolean;
	}

	let loading = $state(true);
	let loadFailure = $state<string | null>(null);
	let killSwitchOn = $state(false);
	let catalogue = $state<"ok" | "unreachable" | "no_gateway">("ok");
	let decisionModels = $state<string[]>([]);
	let testAvailable = $state(false);

	let enabled = $state(false);
	let modelId = $state("");
	let threshold = $state(0.85);
	let instructions = $state("");
	let perClass = $state<Record<PermissionClass, ReviewAnswerer>>({ ...PER_CLASS_DEFAULTS });
	let perHour = $state(300);
	let saved = $state<string>("");

	let busy = $state(false);
	let failure = $state<string | null>(null);
	let note = $state<string | null>(null);
	let testing = $state(false);
	let testFailure = $state<string | null>(null);
	let testReport = $state<{ passed: boolean; cases: TestCase[] } | null>(null);
	let testedKey = $state<string | null>(null);

	const snapshot = () =>
		JSON.stringify([enabled, modelId, threshold, instructions.trim(), perClass, perHour]);
	const reviewKey = () => JSON.stringify([modelId, threshold, instructions.trim()]);
	const dirty = $derived(snapshot() !== saved);
	const reviewChanged = $derived(testedKey !== reviewKey());
	/** The save needs a test that passed on these exact values, only when it turns the reviewer on. */
	const needsTest = $derived(testAvailable && enabled && dirty && reviewChanged);

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
			maxPerHourPerMachine: number;
		};
		killSwitchOn: boolean;
		decisionModels: string[];
		catalogue: "ok" | "unreachable" | "no_gateway";
		testAvailable: boolean;
	}) {
		const s = data.settings;
		enabled = s.enabled;
		modelId = s.decisionModelId ?? "";
		threshold = s.threshold;
		instructions = s.instructions;
		perClass = { ...PER_CLASS_DEFAULTS, ...s.perClass, loop: "you" };
		perHour = s.maxPerHourPerMachine;
		killSwitchOn = data.killSwitchOn;
		decisionModels = data.decisionModels;
		catalogue = data.catalogue;
		testAvailable = data.testAvailable;
		saved = snapshot();
	}

	async function problem(response: Response): Promise<string> {
		const parsed = (await response.json().catch(() => null)) as { message?: string } | null;
		return parsed?.message ?? m["admin.common.error_status"]({ status: response.status });
	}

	async function load() {
		try {
			const response = await fetch(`${base}/api/v2/admin/agent-review`);
			if (!response.ok) throw new Error(await problem(response));
			apply(await response.json());
		} catch (err) {
			loadFailure = err instanceof Error ? err.message : m["admin.common.read_failed"]();
		} finally {
			loading = false;
		}
	}
	onMount(load);

	async function runTest() {
		testing = true;
		testFailure = null;
		testReport = null;
		const key = reviewKey();
		try {
			const response = await fetch(`${base}/api/v2/admin/agent-review/test`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					decisionModelId: modelId,
					threshold,
					instructions: instructions.trim(),
				}),
			});
			if (response.status === 501) {
				testAvailable = false;
				testFailure = m["admin.auto.test.unavailable"]();
				return;
			}
			if (!response.ok) throw new Error(await problem(response));
			testReport = await response.json();
			testedKey = testReport?.passed ? key : null;
		} catch (err) {
			testFailure = err instanceof Error ? err.message : m["admin.auto.test.failed"]();
		} finally {
			testing = false;
		}
	}

	async function save() {
		busy = true;
		failure = null;
		note = null;
		try {
			const response = await fetch(`${base}/api/v2/admin/agent-review`, {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					enabled,
					decisionModelId: modelId || null,
					threshold,
					instructions: instructions.trim(),
					perClass,
					maxPerHourPerMachine: perHour,
				}),
			});
			if (!response.ok) throw new Error(await problem(response));
			apply(await response.json());
			note = m["admin.auto.saved"]();
		} catch (err) {
			failure = err instanceof Error ? err.message : m["admin.common.save_failed"]();
		} finally {
			busy = false;
		}
	}

	const INPUT =
		"rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm dark:border-gray-600 dark:bg-gray-800";
	const BTN =
		"rounded-md bg-gray-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50 dark:bg-gray-100 dark:text-gray-900";
	const BTN2 =
		"rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium disabled:opacity-50 dark:border-gray-600";
</script>

<div class="flex flex-col gap-8" data-testid="agent-review">
	<section id="auto-approval" aria-labelledby="auto-title" class="flex flex-col gap-4">
		<div>
			<h2 id="auto-title" class="text-lg font-semibold">{m["admin.auto.title"]()}</h2>
			<p class="mt-1 text-sm text-gray-600 dark:text-gray-400">{m["admin.auto.intro"]()}</p>
			<a
				href="{base}/admin/agents/review-log"
				class="mt-1 inline-block text-sm underline"
				data-testid="auto-log-link">{m["admin.auto.log.link"]()}</a
			>
			<p
				class="mt-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100"
				data-testid="auto-egress"
			>
				{m["admin.auto.egress"]()}
			</p>
		</div>

		{#if loading}
			<p class="text-sm text-gray-500">{m["admin.common.loading"]()}</p>
		{:else if loadFailure}
			<p class="text-sm text-red-600" role="alert">{loadFailure}</p>
		{:else}
			{#if killSwitchOn}
				<p
					class="rounded-md border border-gray-300 bg-gray-50 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-800"
					data-testid="auto-killswitch"
				>
					{m["admin.auto.killswitch"]()}
				</p>
			{/if}

			<label class="flex items-start gap-2 text-sm">
				<input type="checkbox" bind:checked={enabled} class="mt-0.5" />
				<span>
					<span class="font-medium">{m["admin.auto.enabled"]()}</span>
					<span class="block text-gray-600 dark:text-gray-400"
						>{m["admin.auto.enabled_detail"]()}</span
					>
				</span>
			</label>

			<div class="flex flex-col gap-1">
				<label for="auto-model" class="text-sm font-medium">{m["admin.auto.model"]()}</label>
				{#if decisionModels.length === 0}
					<p class="text-sm text-gray-600 dark:text-gray-400" data-testid="auto-no-models">
						{catalogue === "unreachable"
							? m["admin.auto.model_unreachable"]()
							: catalogue === "no_gateway"
								? m["admin.auto.model_no_gateway"]()
								: m["admin.auto.model_none"]()}
					</p>
					{#if modelId}<p class="text-sm">
							{m["admin.auto.model_current"]({ model: modelId })}
						</p>{/if}
				{:else}
					<select id="auto-model" bind:value={modelId} class="{INPUT} max-w-sm">
						<option value="">{m["admin.auto.model_choose"]()}</option>
						{#each decisionModels as id (id)}
							<option value={id}>{id}</option>
						{/each}
					</select>
				{/if}
			</div>

			<div class="flex flex-col gap-1">
				<label for="auto-threshold" class="text-sm font-medium">{m["admin.auto.threshold"]()}</label
				>
				<input
					id="auto-threshold"
					type="number"
					min={THRESHOLD_MIN}
					max={THRESHOLD_MAX}
					step="0.01"
					bind:value={threshold}
					class="{INPUT} w-28"
					aria-invalid={thresholdBad}
				/>
				<p class="text-sm text-gray-600 dark:text-gray-400">
					{m["admin.auto.threshold_detail"]({ min: THRESHOLD_MIN, max: THRESHOLD_MAX })}
				</p>
				{#if thresholdBad}
					<p class="text-sm text-red-600" role="alert">
						{m["admin.auto.threshold_bad"]({ min: THRESHOLD_MIN, max: THRESHOLD_MAX })}
					</p>
				{/if}
			</div>

			<div class="flex flex-col gap-1">
				<label for="auto-instructions" class="text-sm font-medium"
					>{m["admin.auto.instructions"]()}</label
				>
				<p class="text-sm text-gray-600 dark:text-gray-400">
					{m["admin.auto.instructions_detail"]()}
				</p>
				<div
					class="rounded-t-md border border-b-0 border-dashed border-gray-300 bg-gray-50 px-2 py-1.5 font-mono text-xs text-gray-600 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-400"
					data-testid="auto-frame-top"
				>
					<span class="mb-0.5 block font-sans font-medium">{m["admin.auto.frame_top_label"]()}</span
					>
					{m["admin.auto.frame_top"]()}
				</div>
				<textarea
					id="auto-instructions"
					rows="8"
					bind:value={instructions}
					class="{INPUT} font-mono"
					aria-invalid={Boolean(marker) || tooLong}
				></textarea>
				<div
					class="rounded-b-md border border-t-0 border-dashed border-gray-300 bg-gray-50 px-2 py-1.5 font-mono text-xs text-gray-600 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-400"
					data-testid="auto-frame-bottom"
				>
					<span class="mb-0.5 block font-sans font-medium"
						>{m["admin.auto.frame_bottom_label"]()}</span
					>
					{m["admin.auto.frame_bottom"]()}
				</div>
				<p class="text-xs {tooLong ? 'text-red-600' : 'text-gray-500'}" data-testid="auto-count">
					{m["admin.auto.count"]({ n: instructions.trim().length, max: INSTRUCTIONS_MAX })}
				</p>
				{#if marker}
					<p class="text-sm text-red-600" role="alert">
						{m["admin.auto.marker"]({ marker: marker.trim() })}
					</p>
				{/if}
			</div>

			<fieldset class="flex flex-col gap-2">
				<legend class="text-sm font-medium">{m["admin.auto.rows"]()}</legend>
				<p class="text-sm text-gray-600 dark:text-gray-400">{m["admin.auto.rows_detail"]()}</p>
				<div class="overflow-x-auto">
					<table class="w-full max-w-xl text-sm">
						<tbody>
							{#each PERMISSION_CLASSES as c (c)}
								<tr class="border-t border-gray-200 dark:border-gray-700">
									<th scope="row" class="py-1.5 pr-3 text-left font-normal">{className(c)}</th>
									<td class="py-1.5">
										{#if c === "loop"}
											<span class="text-gray-600 dark:text-gray-400" data-testid="auto-row-loop"
												>{m["admin.auto.row.you"]()} · {m["admin.auto.row.loop_fixed"]()}</span
											>
										{:else}
											<div role="radiogroup" aria-label={className(c)} class="flex gap-3">
												{#each ["you", "reviewer"] as const as who (who)}
													<label class="flex items-center gap-1">
														<input
															type="radio"
															name="row-{c}"
															value={who}
															checked={perClass[c] === who}
															onchange={() => (perClass[c] = who)}
															data-testid="auto-row-{c}-{who}"
														/>
														{who === "you"
															? m["admin.auto.row.you"]()
															: m["admin.auto.row.reviewer"]()}
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
				<p class="text-sm text-gray-600 dark:text-gray-400">{m["admin.auto.escalate_list"]()}</p>
			</fieldset>

			<div class="flex flex-col gap-1">
				<label for="auto-cap" class="text-sm font-medium">{m["admin.auto.cap"]()}</label>
				<input
					id="auto-cap"
					type="number"
					min="1"
					max="10000"
					bind:value={perHour}
					class="{INPUT} w-28"
				/>
				<p class="text-sm text-gray-600 dark:text-gray-400">{m["admin.auto.cap_detail"]()}</p>
			</div>

			<div class="flex flex-col gap-2">
				<div class="flex flex-wrap items-center gap-2">
					<button
						type="button"
						class={BTN2}
						onclick={runTest}
						disabled={testing || !modelId || invalid}
						data-testid="auto-test"
					>
						{testing ? m["admin.auto.test.running"]() : m["admin.auto.test.button"]()}
					</button>
					<button
						type="button"
						class={BTN}
						onclick={save}
						disabled={busy || !dirty || invalid || (needsTest && !testReport?.passed)}
						data-testid="auto-save"
					>
						{busy ? m["admin.common.saving"]() : m["admin.common.save"]()}
					</button>
				</div>
				{#if !testAvailable}
					<p class="text-sm text-gray-600 dark:text-gray-400" data-testid="auto-test-unavailable">
						{m["admin.auto.test.unavailable"]()}
					</p>
				{:else if needsTest && !testReport?.passed}
					<p class="text-sm text-gray-600 dark:text-gray-400" data-testid="auto-test-required">
						{m["admin.auto.test.required"]()}
					</p>
				{/if}
				{#if testFailure}<p class="text-sm text-red-600" role="alert">{testFailure}</p>{/if}
				{#if testReport}
					<div data-testid="auto-test-report" class="text-sm">
						<p
							class="font-medium {testReport.passed
								? 'text-green-700 dark:text-green-400'
								: 'text-red-600'}"
						>
							{testReport.passed
								? m["admin.auto.test.passed"]()
								: m["admin.auto.test.not_passed"]()}
						</p>
						<ul class="mt-1 flex flex-col gap-0.5">
							{#each testReport.cases as c (c.id)}
								<li class={c.ok ? "" : "text-red-600"}>
									{c.ok ? "✓" : "✗"}
									{c.label}
									<span class="text-gray-500">
										· {c.expected === "allow"
											? m["admin.auto.test.expect_allow"]()
											: m["admin.auto.test.expect_escalate"]()}
										{#if c.probability !== null}· {Math.round(c.probability * 100)}%{/if}
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
</div>
