<script lang="ts">
	import { APP_VERSION } from "$lib/utils/appVersion";
	import CarbonTrashCan from "~icons/carbon/trash-can";

	import { useSettingsStore } from "$lib/stores/settings";
	import { m } from "$lib/paraglide/messages";
	import Rich from "$lib/i18n/Rich.svelte";
	import { activeLocale, localeLabel, rememberLocaleCookie } from "$lib/i18n/locale";
	import { parseLocale, selectableLocales } from "$lib/i18n/resolve";
	import type { StreamingMode } from "$lib/types/Settings";
	import LocationSettings from "$lib/components/settings/LocationSettings.svelte";
	import { parseLocationMode } from "$lib/utils/location";
	import Switch from "$lib/components/Switch.svelte";
	import SwatchGroup from "$lib/components/settings/SwatchGroup.svelte";
	import {
		ACCENTS,
		ACCENT_SWATCHES,
		DEFAULT_ACCENT,
		DEFAULT_NEUTRAL,
		NEUTRALS,
		NEUTRAL_SWATCHES,
		parseAccent,
		parseNeutral,
		type Accent,
		type Neutral,
	} from "$lib/utils/palettes";

	import { goto } from "$app/navigation";
	import { error } from "$lib/stores/errors";
	import { base } from "$app/paths";
	import { page } from "$app/state";
	import { webSearchUnavailableReason } from "$lib/utils/webSearchAvailability";
	import { usePublicConfig } from "$lib/utils/PublicConfig.svelte";
	import { useAPIClient, handleResponse } from "$lib/APIClient";
	import { onMount } from "svelte";
	import { browser } from "$app/environment";
	import { getThemePreference, setTheme, type ThemePreference } from "$lib/switchTheme";
	import { supportsHaptics } from "$lib/utils/haptics";
	import DeleteAllConversationsModal from "$lib/components/DeleteAllConversationsModal.svelte";

	const publicConfig = usePublicConfig();

	// Accent and tone names, as messages (the palette module only knows ids).
	const ACCENT_LABELS: Record<Accent, () => string> = {
		blue: m["settings.application.accent.option.blue"],
		violet: m["settings.application.accent.option.violet"],
		teal: m["settings.application.accent.option.teal"],
		green: m["settings.application.accent.option.green"],
		rose: m["settings.application.accent.option.rose"],
		orange: m["settings.application.accent.option.orange"],
	};
	const NEUTRAL_LABELS: Record<Neutral, () => string> = {
		neutral: m["settings.application.neutral.option.neutral"],
		cool: m["settings.application.neutral.option.cool"],
		warm: m["settings.application.neutral.option.warm"],
	};

	// The product's own name is not a word to translate. i18n: literal
	const PRODUCT_NAME = "Cerea";
	const CEREA_REPO = "https://github.com/paoloviviani/Cerea";
	// The image sets the full commit; a dev build may have "unknown" or nothing.
	const commitSha = $derived(
		/^[0-9a-f]{7,40}$/.test(publicConfig.PUBLIC_COMMIT_SHA ?? "")
			? publicConfig.PUBLIC_COMMIT_SHA
			: ""
	);
	let settings = useSettingsStore();

	// Functional bindings for store fields (Svelte 5): avoid mutating $settings directly
	function getStreamingMode() {
		return $settings.streamingMode;
	}
	function setStreamingMode(v: StreamingMode) {
		settings.update((s) => ({ ...s, streamingMode: v }));
	}
	function getDirectPaste() {
		return $settings.directPaste;
	}
	function setDirectPaste(v: boolean) {
		settings.update((s) => ({ ...s, directPaste: v }));
	}
	function getHapticsEnabled() {
		return $settings.hapticsEnabled;
	}
	function setHapticsEnabled(v: boolean) {
		settings.update((s) => ({ ...s, hapticsEnabled: v }));
	}
	// The default new chats inherit. The composer's toggle writes per-chat
	// state instead — settings hold *defaults*, a chat holds *per-chat state*.
	const webSearchUnavailable = $derived(
		webSearchUnavailableReason(
			page.data as { webSearchAvailable?: boolean; gatewayIsAdmin?: boolean }
		)
	);

	function getWebSearchDefault() {
		return $settings.webSearchEnabled === true;
	}
	function setWebSearchDefault(v: boolean) {
		settings.update((s) => ({ ...s, webSearchEnabled: v }));
	}
	function getPyodidePyPiInstallEnabled() {
		return $settings.pyodidePyPiInstallEnabled === true;
	}
	function setPyodidePyPiInstallEnabled(v: boolean) {
		settings.update((s) => ({ ...s, pyodidePyPiInstallEnabled: v }));
	}
	function getToolApprovalPolicy() {
		return $settings.toolApprovalPolicy ?? "manual";
	}
	function setToolApprovalPolicy(v: string) {
		settings.update((s) => ({
			...s,
			toolApprovalPolicy: v === "always-allow" ? "always-allow" : undefined,
		}));
	}

	const client = useAPIClient();

	let OPENAI_BASE_URL = $state<string | null>(null);

	onMount(async () => {
		// Fetch debug config
		try {
			const cfg = await client.debug.config.get().then(handleResponse);
			OPENAI_BASE_URL = (cfg as { OPENAI_BASE_URL?: string }).OPENAI_BASE_URL || null;
		} catch (e) {
			// ignore if debug endpoint is unavailable
		}
	});

	let themePref = $state<ThemePreference>(browser ? getThemePreference() : "system");

	const taskModelId = $derived((page.data as { taskModelId?: string | null }).taskModelId ?? null);

	// The language selector. Only real locales are listed; the pseudo-locale
	// (en-XA) appears only where the server says it may (dev, or CHAT_PSEUDO_LOCALE).
	const pseudoAllowed = $derived(page.data.pseudoLocaleEnabled === true);
	const languages = $derived(selectableLocales(pseudoAllowed));
	const language = activeLocale();

	function languageName(tag: string): string {
		return parseLocale(tag, false)
			? localeLabel(tag)
			: m["settings.application.language.pseudo_option"]({ tag });
	}

	async function chooseLanguage(value: string) {
		const next = parseLocale(value, pseudoAllowed);
		if (!next || next === language) return;
		rememberLocaleCookie(next);
		// Saved before the reload: the server reads the saved choice first, so a
		// reload that outran the save would come back in the old language.
		await settings.instantSet({ locale: next });
		window.location.reload();
	}

	let deleteAllOpen = $state(false);

	async function deleteAllConversations() {
		try {
			await client.conversations.delete().then(handleResponse);
			await goto(`${base}/`, { invalidateAll: true });
		} catch (err) {
			console.error(err);
			$error = err instanceof Error ? err.message : String(err);
		}
	}
</script>

{#snippet code(text: string)}<code class="font-mono">{text}</code>{/snippet}

{#snippet taskModelRow()}
	<div class="flex flex-col gap-2 py-3 sm:flex-row sm:items-start sm:justify-between">
		<div>
			<div class="text-[13px] font-medium text-gray-800 dark:text-gray-200">
				{m["settings.application.task_model.title"]()}
			</div>
			<p class="text-[12px] text-gray-500 dark:text-gray-400">
				<Rich
					parts={m["settings.application.task_model.description"].parts({ name: "TASK_MODEL" })}
					tags={{ code }}
				/>
			</p>
		</div>
		<select
			disabled
			class="max-w-full cursor-not-allowed self-start rounded-md border border-gray-300 bg-white px-1 py-1 text-xs text-gray-800 sm:self-auto dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200"
		>
			<option>{taskModelId}</option>
		</select>
	</div>
{/snippet}

<div class="flex w-full flex-col gap-4">
	{#if OPENAI_BASE_URL !== null}
		<div
			class="mt-1 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-[12px] text-gray-700 dark:border-gray-700 dark:bg-gray-700/80 dark:text-gray-300"
		>
			<span class="font-medium">{m["settings.application.api_base_url"]()}</span>
			<code class="ml-1 font-mono text-[12px] break-all text-gray-800 dark:text-gray-100"
				>{OPENAI_BASE_URL}</code
			>
		</div>
	{/if}
	<p class="text-sm font-light text-gray-500 dark:text-gray-400" data-testid="app-version">
		<a
			href={`${CEREA_REPO}/releases/tag/v${APP_VERSION}`}
			target="_blank"
			rel="noreferrer"
			class="hover:underline">{PRODUCT_NAME} {APP_VERSION}</a
		>{#if commitSha}
			·
			<a
				href={`${CEREA_REPO}/commit/${commitSha}`}
				target="_blank"
				rel="noreferrer"
				class="font-mono hover:underline">{commitSha.slice(0, 7)}</a
			>{/if}
	</p>
	{#if page.data.isAdmin}
		<div class="flex items-center gap-2">
			<p
				class="rounded-md bg-red-50 px-2 py-1 text-xs font-medium text-red-700 dark:bg-red-500/10 dark:text-red-300"
			>
				{m["settings.application.admin_mode"]()}
			</p>
		</div>
	{/if}
	<div class="flex h-full flex-col gap-4 max-sm:pt-0">
		<section
			aria-labelledby="appearance-heading"
			class="rounded-xl border border-gray-200 bg-white px-3 shadow-xs dark:border-gray-700 dark:bg-gray-800"
		>
			<h2
				id="appearance-heading"
				class="pt-3 text-[13px] font-semibold text-gray-800 dark:text-gray-200"
			>
				{m["settings.application.appearance.heading"]()}
			</h2>
			<div class="divide-y divide-gray-200 dark:divide-gray-700">
				<div class="flex items-start justify-between py-3">
					<div>
						<div class="text-[13px] font-medium text-gray-800 dark:text-gray-200">
							{m["settings.application.theme.title"]()}
						</div>
						<p class="text-[12px] text-gray-500 dark:text-gray-400">
							{m["settings.application.theme.description"]()}
						</p>
					</div>
					<select
						class="rounded-md border border-gray-300 bg-white px-1 py-1 text-xs text-gray-800 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200"
						value={themePref}
						onchange={(e) => {
							const v = e.currentTarget.value as ThemePreference;
							setTheme(v);
							themePref = v;
						}}
					>
						<option value="system">{m["settings.application.theme.option.system"]()}</option>
						<option value="light">{m["settings.application.theme.option.light"]()}</option>
						<option value="dark">{m["settings.application.theme.option.dark"]()}</option>
					</select>
				</div>

				<div class="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
					<div>
						<div class="text-[13px] font-medium text-gray-800 dark:text-gray-200">
							{m["settings.application.accent.title"]()}
						</div>
						<p class="text-[12px] text-gray-500 dark:text-gray-400">
							{m["settings.application.accent.description"]()}
						</p>
					</div>
					<SwatchGroup
						label={m["settings.application.accent.title"]()}
						value={$settings.accent ?? DEFAULT_ACCENT}
						options={ACCENTS.map((a) => ({
							value: a,
							label: ACCENT_LABELS[a](),
							colour: ACCENT_SWATCHES[a],
						}))}
						onchange={(v) => settings.instantSet({ accent: parseAccent(v) })}
					/>
				</div>

				<div class="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
					<div>
						<div class="text-[13px] font-medium text-gray-800 dark:text-gray-200">
							{m["settings.application.neutral.title"]()}
						</div>
						<p class="text-[12px] text-gray-500 dark:text-gray-400">
							{m["settings.application.neutral.description"]()}
						</p>
					</div>
					<SwatchGroup
						label={m["settings.application.neutral.title"]()}
						value={parseNeutral($settings.neutral) ?? DEFAULT_NEUTRAL}
						options={NEUTRALS.map((n) => ({
							value: n,
							label: NEUTRAL_LABELS[n](),
							colour: NEUTRAL_SWATCHES[n],
						}))}
						onchange={(v) => settings.instantSet({ neutral: parseNeutral(v) })}
					/>
				</div>

				<div class="flex items-start justify-between gap-3 py-3">
					<div>
						<label
							for="language-select"
							class="text-[13px] font-medium text-gray-800 dark:text-gray-200"
						>
							{m["settings.application.language.title"]()}
						</label>
						<p class="text-[12px] text-gray-500 dark:text-gray-400">
							{m["settings.application.language.description"]()}
						</p>
					</div>
					<select
						id="language-select"
						name="locale"
						class="rounded-md border border-gray-300 bg-white px-1 py-1 text-xs text-gray-800 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200"
						value={language}
						onchange={(e) => chooseLanguage(e.currentTarget.value)}
					>
						{#each languages as tag (tag)}
							<option value={tag}>{languageName(tag)}</option>
						{/each}
					</select>
				</div>
			</div>
		</section>

		<LocationSettings
			mode={parseLocationMode($settings.locationMode)}
			place={$settings.locationPlace ?? ""}
			onchange={(next) =>
				settings.update((s) => ({
					...s,
					...(next.mode !== undefined && { locationMode: next.mode }),
					...(next.place !== undefined && { locationPlace: next.place }),
				}))}
		/>

		<div
			class="rounded-xl border border-gray-200 bg-white px-3 shadow-xs dark:border-gray-700 dark:bg-gray-800"
		>
			<div class="divide-y divide-gray-200 dark:divide-gray-700">
				<div class="flex items-start justify-between py-3">
					<div>
						<div class="text-[13px] font-medium text-gray-800 dark:text-gray-200">
							{m["settings.application.streaming.title"]()}
						</div>
						<p class="text-[12px] text-gray-500 dark:text-gray-400">
							{m["settings.application.streaming.description"]()}
						</p>
					</div>
					<select
						class="rounded-md border border-gray-300 bg-white px-1 py-1 text-xs text-gray-800 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200"
						value={getStreamingMode()}
						onchange={(e) => setStreamingMode(e.currentTarget.value as StreamingMode)}
					>
						<option value="smooth">{m["settings.application.streaming.option.smooth"]()}</option>
						<option value="raw">{m["settings.application.streaming.option.raw"]()}</option>
					</select>
				</div>

				<div class="flex items-start justify-between py-3">
					<div>
						<div class="text-[13px] font-medium text-gray-800 dark:text-gray-200">
							{m["settings.application.paste.title"]()}
						</div>
						<p class="text-[12px] text-gray-500 dark:text-gray-400">
							{m["settings.application.paste.description"]()}
						</p>
					</div>
					<Switch name="directPaste" bind:checked={getDirectPaste, setDirectPaste} />
				</div>

				{#if supportsHaptics()}
					<div class="flex items-start justify-between py-3">
						<div>
							<div class="text-[13px] font-medium text-gray-800 dark:text-gray-200">
								{m["settings.application.haptics.title"]()}
							</div>
							<p class="text-[12px] text-gray-500 dark:text-gray-400">
								{m["settings.application.haptics.description"]()}
							</p>
						</div>
						<Switch name="hapticsEnabled" bind:checked={getHapticsEnabled, setHapticsEnabled} />
					</div>
				{/if}

				<div class="flex items-start justify-between py-3">
					<div>
						<div class="text-[13px] font-medium text-gray-800 dark:text-gray-200">
							{m["settings.application.web_search.title"]()}
						</div>
						<p class="text-[12px] text-gray-500 dark:text-gray-400">
							{m["settings.application.web_search.description"]()}
						</p>
						{#if webSearchUnavailable}
							<p class="text-[12px] text-amber-700 dark:text-amber-400">{webSearchUnavailable}</p>
						{/if}
					</div>
					<Switch
						name="webSearchEnabled"
						disabled={!!webSearchUnavailable}
						bind:checked={getWebSearchDefault, setWebSearchDefault}
					/>
				</div>

				<div class="flex flex-col gap-2 py-3 sm:flex-row sm:items-start sm:justify-between">
					<div>
						<div class="text-[13px] font-medium text-gray-800 dark:text-gray-200">
							{m["settings.application.tool_approvals.title"]()}
						</div>
						<p class="text-[12px] text-gray-500 dark:text-gray-400">
							{m["settings.application.tool_approvals.description"]()}
						</p>
					</div>
					<select
						class="max-w-full self-start rounded-md border border-gray-300 bg-white px-1 py-1 text-xs text-gray-800 sm:self-auto dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200"
						value={getToolApprovalPolicy()}
						onchange={(e) => setToolApprovalPolicy(e.currentTarget.value)}
					>
						<option value="manual"
							>{m["settings.application.tool_approvals.option.manual"]()}</option
						>
						<option value="always-allow"
							>{m["settings.application.tool_approvals.option.always_allow"]()}</option
						>
					</select>
				</div>

				<div class="flex items-start justify-between py-3">
					<div>
						<div class="text-[13px] font-medium text-gray-800 dark:text-gray-200">
							{m["settings.application.pypi.title"]()}
						</div>
						<p class="text-[12px] text-gray-500 dark:text-gray-400">
							{#if page.data.pyodidePyPiInstallAllowed}
								{m["settings.application.pypi.description_allowed"]()}
							{:else}
								{m["settings.application.pypi.description_disabled"]()}
							{/if}
						</p>
					</div>
					<Switch
						name="pyodidePyPiInstallEnabled"
						disabled={!page.data.pyodidePyPiInstallAllowed}
						bind:checked={getPyodidePyPiInstallEnabled, setPyodidePyPiInstallEnabled}
					/>
				</div>

				{#if taskModelId}
					{@render taskModelRow()}
				{/if}
			</div>
		</div>

		<div class="mt-6 flex flex-col gap-2 self-start text-[13px]">
			<button
				onclick={(e) => {
					e.preventDefault();
					deleteAllOpen = true;
				}}
				type="button"
				class="flex items-center underline decoration-red-200 underline-offset-2 hover:decoration-red-500 dark:decoration-red-900 dark:hover:decoration-red-700"
				><CarbonTrashCan class="mr-2 inline text-sm text-red-500" />{m[
					"settings.application.delete_all.button"
				]()}</button
			>
		</div>
	</div>
</div>

<DeleteAllConversationsModal
	open={deleteAllOpen}
	onclose={() => (deleteAllOpen = false)}
	ondelete={deleteAllConversations}
/>
