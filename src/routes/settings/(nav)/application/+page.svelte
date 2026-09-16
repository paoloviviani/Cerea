<script lang="ts">
	import CarbonTrashCan from "~icons/carbon/trash-can";
	import CarbonArrowUpRight from "~icons/carbon/arrow-up-right";
	import CarbonLogoGithub from "~icons/carbon/logo-github";

	import { useSettingsStore } from "$lib/stores/settings";
	import type { StreamingMode } from "$lib/types/Settings";
	import Switch from "$lib/components/Switch.svelte";

	import { goto } from "$app/navigation";
	import { error } from "$lib/stores/errors";
	import { base } from "$app/paths";
	import { page } from "$app/state";
	import { usePublicConfig } from "$lib/utils/PublicConfig.svelte";
	import { useAPIClient, handleResponse } from "$lib/APIClient";
	import { onMount } from "svelte";
	import { browser } from "$app/environment";
	import { getThemePreference, setTheme, type ThemePreference } from "$lib/switchTheme";
	import { supportsHaptics } from "$lib/utils/haptics";
	import DeleteAllConversationsModal from "$lib/components/DeleteAllConversationsModal.svelte";

	const publicConfig = usePublicConfig();
	let settings = useSettingsStore();

	// Functional bindings for store fields (Svelte 5): avoid mutating $settings directly
	function getShareWithAuthors() {
		return $settings.shareConversationsWithModelAuthors;
	}
	function setShareWithAuthors(v: boolean) {
		settings.update((s) => ({ ...s, shareConversationsWithModelAuthors: v }));
	}
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
	function getWebSearchDefault() {
		return $settings.webSearchEnabled === true;
	}
	function setWebSearchDefault(v: boolean) {
		settings.update((s) => ({ ...s, webSearchEnabled: v }));
	}

	const client = useAPIClient();

	let OPENAI_BASE_URL = $state<string | null>(null);

	// Billing organization state
	type BillingOrg = { sub: string; name: string; preferred_username: string };
	let billingOrgs = $state<BillingOrg[]>([]);
	let billingOrgsLoading = $state(false);
	let billingOrgsError = $state<string | null>(null);

	function getBillingOrganization() {
		return $settings.billingOrganization ?? "";
	}
	function setBillingOrganization(v: string) {
		settings.update((s) => ({ ...s, billingOrganization: v }));
	}

	onMount(async () => {
		// Fetch debug config
		try {
			const cfg = await client.debug.config.get().then(handleResponse);
			OPENAI_BASE_URL = (cfg as { OPENAI_BASE_URL?: string }).OPENAI_BASE_URL || null;
		} catch (e) {
			// ignore if debug endpoint is unavailable
		}

		// Which group pays (ADR 0061). No `isHuggingChat` gate: the gateway
		// answers this for every deployment, and the endpoint reports an empty
		// list when it cannot, so the section below hides itself.
		if (page.data.user) {
			billingOrgsLoading = true;
			try {
				const data = (await client.user["billing-orgs"].get().then(handleResponse)) as {
					userCanPay: boolean;
					organizations: BillingOrg[];
					currentBillingOrg?: string;
				};
				billingOrgs = data.organizations ?? [];
				// Update settings if current billing org was cleared by server
				if (data.currentBillingOrg !== getBillingOrganization()) {
					setBillingOrganization(data.currentBillingOrg ?? "");
				}
			} catch {
				billingOrgsError = "Failed to load billing options";
			} finally {
				billingOrgsLoading = false;
			}
		}
	});

	let themePref = $state<ThemePreference>(browser ? getThemePreference() : "system");

	const taskModelId = $derived((page.data as { taskModelId?: string | null }).taskModelId ?? null);
	const showTaskModelInBilling = $derived(publicConfig.isHuggingChat && !!page.data.user);

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

{#snippet taskModelRow()}
	<div class="flex flex-col gap-2 py-3 sm:flex-row sm:items-start sm:justify-between">
		<div>
			<div class="text-[13px] font-medium text-gray-800 dark:text-gray-200">Task model</div>
			<p class="text-[12px] text-gray-500 dark:text-gray-400">
				{#if publicConfig.isHuggingChat}
					Generates conversation titles. Extremely cheap.
				{:else}
					Generates conversation titles. Set via <code class="font-mono">TASK_MODEL</code>.
				{/if}
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
			<span class="font-medium">API Base URL:</span>
			<code class="ml-1 font-mono text-[12px] break-all text-gray-800 dark:text-gray-100"
				>{OPENAI_BASE_URL}</code
			>
		</div>
	{/if}
	{#if !!publicConfig.PUBLIC_COMMIT_SHA}
		<div
			class="flex flex-col items-start justify-between text-xl font-semibold text-gray-800 dark:text-gray-200"
		>
			<a
				href={`https://github.com/huggingface/chat-ui/commit/${publicConfig.PUBLIC_COMMIT_SHA}`}
				target="_blank"
				rel="noreferrer"
				class="text-sm font-light text-gray-500 dark:text-gray-400"
			>
				Latest deployment <span class="gap-2 font-mono"
					>{publicConfig.PUBLIC_COMMIT_SHA.slice(0, 7)}</span
				>
			</a>
		</div>
	{/if}
	{#if page.data.isAdmin}
		<div class="flex items-center gap-2">
			<p
				class="rounded-md bg-red-50 px-2 py-1 text-xs font-medium text-red-700 dark:bg-red-500/10 dark:text-red-300"
			>
				Admin mode
			</p>
		</div>
	{/if}
	<div class="flex h-full flex-col gap-4 max-sm:pt-0">
		<div
			class="rounded-xl border border-gray-200 bg-white px-3 shadow-xs dark:border-gray-700 dark:bg-gray-800"
		>
			<div class="divide-y divide-gray-200 dark:divide-gray-700">
				{#if publicConfig.PUBLIC_APP_DATA_SHARING === "1"}
					<div class="flex items-start justify-between py-3">
						<div>
							<div class="text-[13px] font-medium text-gray-800 dark:text-gray-200">
								Share with model authors
							</div>
							<p class="text-[12px] text-gray-500 dark:text-gray-400">
								Sharing your data helps improve open models over time.
							</p>
						</div>
						<Switch
							name="shareConversationsWithModelAuthors"
							bind:checked={getShareWithAuthors, setShareWithAuthors}
						/>
					</div>
				{/if}

				<div class="flex items-start justify-between py-3">
					<div>
						<div class="text-[13px] font-medium text-gray-800 dark:text-gray-200">
							Streaming mode
						</div>
						<p class="text-[12px] text-gray-500 dark:text-gray-400">
							Choose how assistant text appears while generating.
						</p>
					</div>
					<select
						class="rounded-md border border-gray-300 bg-white px-1 py-1 text-xs text-gray-800 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200"
						value={getStreamingMode()}
						onchange={(e) => setStreamingMode(e.currentTarget.value as StreamingMode)}
					>
						<option value="smooth">Smooth stream</option>
						<option value="raw">Raw stream</option>
					</select>
				</div>

				<div class="flex items-start justify-between py-3">
					<div>
						<div class="text-[13px] font-medium text-gray-800 dark:text-gray-200">
							Paste text directly
						</div>
						<p class="text-[12px] text-gray-500 dark:text-gray-400">
							Paste long text directly into chat instead of a file.
						</p>
					</div>
					<Switch name="directPaste" bind:checked={getDirectPaste, setDirectPaste} />
				</div>

				{#if supportsHaptics()}
					<div class="flex items-start justify-between py-3">
						<div>
							<div class="text-[13px] font-medium text-gray-800 dark:text-gray-200">
								Haptic feedback
							</div>
							<p class="text-[12px] text-gray-500 dark:text-gray-400">
								Vibrate on taps and actions on supported devices.
							</p>
						</div>
						<Switch name="hapticsEnabled" bind:checked={getHapticsEnabled, setHapticsEnabled} />
					</div>
				{/if}

				<div class="flex items-start justify-between py-3">
					<div>
						<div class="text-[13px] font-medium text-gray-800 dark:text-gray-200">
							Web search on by default
						</div>
						<p class="text-[12px] text-gray-500 dark:text-gray-400">
							New chats start with web search on. Toggling it in a chat changes only that chat.
						</p>
					</div>
					<Switch name="webSearchEnabled" bind:checked={getWebSearchDefault, setWebSearchDefault} />
				</div>

				<!-- Theme selector -->
				<div class="flex items-start justify-between py-3">
					<div>
						<div class="text-[13px] font-medium text-gray-800 dark:text-gray-200">Theme</div>
						<p class="text-[12px] text-gray-500 dark:text-gray-400">
							Choose light, dark, or follow system.
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
						<option value="system">System</option>
						<option value="light">Light</option>
						<option value="dark">Dark</option>
					</select>
				</div>

				{#if taskModelId && !showTaskModelInBilling}
					{@render taskModelRow()}
				{/if}
			</div>
		</div>

		<!-- Which group pays (ADR 0061). Shown once the gateway names at least
		     one billable group, so a deployment that does not answer shows
		     nothing rather than an empty control. -->
		{#if page.data.user && billingOrgs.length > 0}
			<div
				class="rounded-xl border border-gray-200 bg-white px-3 shadow-xs dark:border-gray-700 dark:bg-gray-800"
			>
				<div class="divide-y divide-gray-200 dark:divide-gray-700">
					<!-- Bill usage to -->
					<div class="flex items-start justify-between py-3">
						<div>
							<div class="text-[13px] font-medium text-gray-800 dark:text-gray-200">
								Billing group
							</div>
							<p class="text-[12px] text-gray-500 dark:text-gray-400">
								Which group your usage is charged to. You can only choose groups you belong to.
							</p>
						</div>
						<div class="flex items-center">
							{#if billingOrgsLoading}
								<span class="text-xs text-gray-500 dark:text-gray-400">Loading...</span>
							{:else if billingOrgsError}
								<span class="text-xs text-red-500">{billingOrgsError}</span>
							{:else}
								<select
									class="rounded-md border border-gray-300 bg-white px-1 py-1 text-xs text-gray-800 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200"
									value={getBillingOrganization()}
									onchange={(e) => setBillingOrganization(e.currentTarget.value)}
								>
									{#each billingOrgs as org}
										<option value={org.preferred_username} title={org.name}
											>{org.preferred_username}</option
										>
									{/each}
								</select>
							{/if}
						</div>
					</div>
					{#if taskModelId}
						{@render taskModelRow()}
					{/if}
				</div>
			</div>
		{/if}

		<div class="mt-6 flex flex-col gap-2 self-start text-[13px]">
			{#if publicConfig.isHuggingChat}
				<a
					href="https://github.com/huggingface/chat-ui"
					target="_blank"
					class="flex items-center underline decoration-gray-300 underline-offset-2 hover:decoration-gray-700 dark:decoration-gray-700 dark:hover:decoration-gray-400"
					><CarbonLogoGithub class="mr-1.5 shrink-0 text-sm " /> Github repository</a
				>
				<a
					href="https://huggingface.co/spaces/huggingchat/chat-ui/discussions/764"
					target="_blank"
					rel="noreferrer"
					class="flex items-center underline decoration-gray-300 underline-offset-2 hover:decoration-gray-700 dark:decoration-gray-700 dark:hover:decoration-gray-400"
					><CarbonArrowUpRight class="mr-1.5 shrink-0 text-sm " /> Share your feedback on HuggingChat</a
				>
				<a
					href="https://huggingface.co/models/inference"
					target="_blank"
					rel="noreferrer"
					class="flex items-center underline decoration-gray-300 underline-offset-2 hover:decoration-gray-700 dark:decoration-gray-700 dark:hover:decoration-gray-400"
					><CarbonArrowUpRight class="mr-1.5 shrink-0 text-sm " /> Compare Inference Providers</a
				>
				<a
					href="{base}/privacy"
					class="flex items-center underline decoration-gray-300 underline-offset-2 hover:decoration-gray-700 dark:decoration-gray-700 dark:hover:decoration-gray-400"
					><CarbonArrowUpRight class="mr-1.5 shrink-0 text-sm " /> About & Privacy</a
				>
			{/if}
			<button
				onclick={(e) => {
					e.preventDefault();
					deleteAllOpen = true;
				}}
				type="button"
				class="flex items-center underline decoration-red-200 underline-offset-2 hover:decoration-red-500 dark:decoration-red-900 dark:hover:decoration-red-700"
				><CarbonTrashCan class="mr-2 inline text-sm text-red-500" />Delete all conversations</button
			>
		</div>
	</div>
</div>

<DeleteAllConversationsModal
	open={deleteAllOpen}
	onclose={() => (deleteAllOpen = false)}
	ondelete={deleteAllConversations}
/>
