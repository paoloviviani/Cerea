<!--
	A machine's delegate profiles: a name and a model each, one of them the
	default (PROTOCOL.md §6 "Delegate profiles"). When the agent on that
	machine delegates work (a spawned session, a committee member) and names no
	profile, the default's model is used; with no profiles, the agent's own.

	The machine owns the set. The dialog reads it with `getDelegateProfiles`,
	edits a local copy and replaces the whole set on Save; the machine validates
	(name pattern, at most 32, each model one it offers, the default) and what
	the dialog shows afterwards is the set the machine answered with, never the
	typed one. A model is not a permission: this dialog changes which brain a
	delegate runs on and nothing about what it may do.

	It stays disabled, with the sentence that says why, for a machine that is
	offline or whose galopin predates the ops (update galopin on that machine).
-->
<script lang="ts">
	import { m } from "$lib/paraglide/messages";
	import { onMount } from "svelte";
	import Modal from "$lib/components/Modal.svelte";
	import IconUsers from "~icons/carbon/user-multiple";
	import IconWarning from "~icons/carbon/warning-filled";
	import IconAdd from "~icons/carbon/add";
	import IconTrash from "~icons/carbon/trash-can";
	import {
		getDelegateProfiles,
		listProviderModels,
		setDelegateProfiles,
		type CodeDeviceView,
	} from "$lib/codeApi";
	import type { CodeProviderModel } from "$lib/types/CodeAgent";
	import {
		DELEGATE_PROFILE_NAME,
		MAX_DELEGATE_PROFILES,
		type DelegateProfiles,
	} from "$lib/types/machineProtocol";
	import { delegateProfilesSupport } from "$lib/utils/delegateProfiles";
	/** The sentence for each reason a machine cannot be edited. */
	const PROFILES_DETAIL = {
		offline: m["code.profiles.offline"],
		"too-old": m["code.profiles.too_old"],
		"tools-off": m["code.profiles.tools_off"],
	} as const;
	import * as s from "$lib/components/overlay/styles";

	interface Props {
		device: CodeDeviceView;
		onclose: () => void;
	}

	let { device, onclose }: Props = $props();

	interface Row {
		/** A stable key for the keyed list: the name changes as it is typed. */
		key: number;
		name: string;
		model: string;
	}

	// svelte-ignore state_referenced_locally
	const support = delegateProfilesSupport(device);
	let nextKey = 0;
	let rows = $state<Row[]>([]);
	let defaultKey = $state<number | null>(null);
	let models = $state<CodeProviderModel[]>([]);
	let loading = $state(support.ok);
	let busy = $state(false);
	let failure = $state<string | null>(null);
	let saved = $state(false);

	function load(set: DelegateProfiles) {
		rows = set.profiles.map((p) => ({ key: nextKey++, name: p.name, model: p.model }));
		defaultKey = rows.find((r) => r.name === set.default)?.key ?? null;
	}

	onMount(async () => {
		if (!support.ok) return;
		try {
			const backend = device.backends[0]?.id ?? "opencode";
			const [set, listed] = await Promise.all([
				getDelegateProfiles(device.id),
				listProviderModels(device.id, backend),
			]);
			models = listed.models;
			load(set);
		} catch (err) {
			failure = err instanceof Error ? err.message : m["code.profiles.could_not_read"]();
		} finally {
			loading = false;
		}
	});

	const editable = $derived(support.ok && !loading && !busy);

	/** A model a saved profile names that the machine no longer lists stays
	 * selectable, so opening and saving never silently rewrites it. */
	function optionsFor(row: Row): CodeProviderModel[] {
		if (!row.model || models.some((x) => x.id === row.model)) return models;
		return [
			{ id: row.model, label: m["code.profiles.not_offered"]({ model: row.model }) },
			...models,
		];
	}

	/** Lower case, whitespace as "-", and no leading "-" or "_" (a name starts with a-z or 0-9). */
	function normaliseProfileName(value: string): string {
		return value
			.toLowerCase()
			.replace(/\s+/g, "-")
			.replace(/^[-_]+/, "");
	}

	function problem(): string | null {
		const seen = new Set<string>();
		for (const row of rows) {
			if (!DELEGATE_PROFILE_NAME.test(row.name)) {
				return row.name
					? m["code.profiles.err_invalid_name"]({ name: row.name })
					: m["code.profiles.err_no_name"]();
			}
			if (seen.has(row.name)) return m["code.profiles.err_twice"]({ name: row.name });
			seen.add(row.name);
			if (!row.model) return m["code.profiles.err_model"]({ name: row.name });
		}
		return null;
	}
	const invalid = $derived(problem());

	function add() {
		if (rows.length >= MAX_DELEGATE_PROFILES) return;
		rows = [...rows, { key: nextKey++, name: "", model: models[0]?.id ?? "" }];
		saved = false;
	}

	function remove(key: number) {
		rows = rows.filter((r) => r.key !== key);
		if (defaultKey === key) defaultKey = null;
		saved = false;
	}

	async function save() {
		if (!editable || invalid) return;
		busy = true;
		failure = null;
		saved = false;
		try {
			const stored = await setDelegateProfiles(device.id, {
				default: rows.find((r) => r.key === defaultKey)?.name ?? null,
				profiles: rows.map((r) => ({ name: r.name, model: r.model })),
			});
			load(stored);
			saved = true;
		} catch (err) {
			failure = err instanceof Error ? err.message : m["code.profiles.could_not_save"]();
		} finally {
			busy = false;
		}
	}
</script>

<Modal width="max-w-xl" closeButton labelledBy="machine-profiles-title" {onclose}>
	<div class="p-6">
		<div class="mb-4 flex items-center gap-3">
			<div class={s.STRIP_TILE}>
				<IconUsers class="size-5 text-blue-600" />
			</div>
			<div class="min-w-0">
				<h2 id="machine-profiles-title" class={s.TITLE}>{m["code.profiles.title"]()}</h2>
				<p class="{s.SUBTITLE} truncate">{device.name}</p>
			</div>
		</div>

		<p class="mb-4 text-sm text-ink-muted">
			{m["code.profiles.intro"]()}
		</p>

		{#if !support.ok}
			<div class="{s.NOTICE} mb-4" data-testid="profiles-unavailable">
				{PROFILES_DETAIL[support.reason]()}
			</div>
		{/if}

		{#if failure}
			<div class="{s.ERROR} mb-4">
				<p class="flex items-center gap-1.5 font-medium">
					<IconWarning class="size-4" />
					{saved ? m["code.profiles.saved_heading"]() : m["code.profiles.not_saved_heading"]()}
				</p>
				<p class="mt-1">{failure}</p>
			</div>
		{/if}

		<form
			onsubmit={(e) => {
				e.preventDefault();
				void save();
			}}
		>
			{#if loading}
				<p class="text-sm text-ink-muted">{m["code.profiles.reading"]()}</p>
			{:else if support.ok && rows.length === 0}
				<p class="rounded-lg border border-dashed border-line px-3 py-4 text-sm text-ink-muted">
					{m["code.profiles.empty"]()}
				</p>
			{:else if rows.length > 0}
				<div
					class="mb-1 grid grid-cols-[3.5rem_1fr_1.4fr_2rem] items-center gap-2 text-xs text-ink-faint"
				>
					<span class="text-center">{m["code.profiles.col_default"]()}</span>
					<span>{m["code.profiles.col_name"]()}</span>
					<span>{m["code.profiles.col_model"]()}</span>
					<span></span>
				</div>
				<ul class="space-y-2" data-testid="profile-rows">
					{#each rows as row, i (row.key)}
						<li class="grid grid-cols-[3.5rem_1fr_1.4fr_2rem] items-center gap-2">
							<input
								type="radio"
								name="profile-default"
								class="mx-auto size-4 accent-blue-600"
								aria-label={m["code.profiles.make_default"]({ name: row.name || String(i + 1) })}
								checked={defaultKey === row.key}
								disabled={!editable}
								onchange={() => {
									defaultKey = row.key;
									saved = false;
								}}
							/>
							<input
								class={s.INPUT}
								placeholder={m["code.profiles.name_placeholder"]()}
								maxlength={32}
								aria-label={m["code.profiles.name_label"]({ index: i + 1 })}
								autocapitalize="none"
								autocomplete="off"
								autocorrect="off"
								spellcheck={false}
								bind:value={row.name}
								oninput={() => {
									// A phone keyboard capitalises, autocorrects and adds a space after a
									// suggestion: fold what it typed into the allowed form rather than
									// refuse a name that looks right.
									row.name = normaliseProfileName(row.name);
									saved = false;
								}}
								disabled={!editable}
							/>
							<select
								class={s.INPUT}
								style="font-size: 16px;"
								aria-label={m["code.profiles.model_label"]({ index: i + 1 })}
								bind:value={row.model}
								onchange={() => (saved = false)}
								disabled={!editable}
							>
								{#each optionsFor(row) as model (model.id)}
									<option value={model.id}>{model.label || model.id}</option>
								{/each}
							</select>
							<button
								type="button"
								class="flex size-8 items-center justify-center rounded-lg text-ink-faint hover:bg-sunken hover:text-danger disabled:opacity-50"
								title={m["code.profiles.remove_title"]()}
								aria-label={m["code.profiles.remove_label"]({ name: row.name || String(i + 1) })}
								disabled={!editable}
								onclick={() => remove(row.key)}
							>
								<IconTrash class="size-4" />
							</button>
						</li>
					{/each}
				</ul>
				<div class="mt-1 flex">
					<button
						type="button"
						class="text-xs text-ink-faint hover:text-ink disabled:opacity-50"
						disabled={!editable || defaultKey === null}
						onclick={() => {
							defaultKey = null;
							saved = false;
						}}
					>
						{m["code.profiles.no_default"]()}
					</button>
				</div>
			{/if}

			{#if invalid && rows.length > 0}
				<p class="{s.HINT} text-danger" data-testid="profiles-invalid">{invalid}</p>
			{/if}
			{#if saved}
				<p class={s.HINT} role="status">{m["code.profiles.saved"]()}</p>
			{/if}

			<div class="mt-4 flex items-center justify-between gap-2">
				<button
					type="button"
					class={s.SECONDARY}
					disabled={!editable || rows.length >= MAX_DELEGATE_PROFILES || models.length === 0}
					onclick={add}
				>
					<IconAdd class="size-4" />
					{m["code.profiles.add"]()}
				</button>
				<div class="flex gap-2">
					<button type="button" onclick={onclose} class={s.SECONDARY} disabled={busy}>
						{m["code.profiles.close"]()}
					</button>
					<button type="submit" class={s.PRIMARY} disabled={!editable || !!invalid}>
						{busy ? m["code.profiles.saving"]() : m["code.profiles.save"]()}
					</button>
				</div>
			</div>
		</form>
	</div>
</Modal>
