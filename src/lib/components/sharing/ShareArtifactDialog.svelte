<!--
	Share link… (ADR 0120): make, change and revoke the public link to one artifact.

	A link shows a frozen copy of one version; the dialog says so, and says in
	plain words who will see it. The token is shown once, when the link is made
	(or replaced): only its hash is stored, so a reopened dialog manages the link
	but cannot show it again.
-->

<script lang="ts" module>
	import type { ShareExpiry, ShareLink as Link } from "$lib/utils/shareLinks";

	export type SharedArtifact =
		| {
				kind: "text";
				identifier: string;
				title: string;
				type: string;
				version: number;
				/** The newest version the chat has, to say when the link is behind it. */
				latestVersion: number;
				content: string;
		  }
		| { kind: "file"; name: string; sha256: string; mime: string; size: number };

	const ghost =
		"inline-flex items-center rounded-xl border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-900 shadow-sm outline-hidden hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700 dark:bg-gray-700 dark:text-gray-100 dark:hover:bg-gray-600";
	const primary =
		"inline-flex items-center rounded-xl border border-gray-900 bg-gray-900 px-3 py-1.5 text-sm font-semibold text-white hover:bg-black disabled:opacity-50 dark:border-gray-100 dark:bg-gray-100 dark:text-gray-900 dark:hover:bg-white";

	/** The dropdown's value for a link: the nearest offered period still ahead, or never. */
	function currentExpiryDays(link: Link): ShareExpiry {
		if (!link.expiresAt) return null;
		const left = (new Date(link.expiresAt).getTime() - Date.now()) / 86_400_000;
		if (left <= 7) return 7;
		if (left <= 30) return 30;
		return 90;
	}
</script>

<script lang="ts">
	import { onMount } from "svelte";
	import { m } from "$lib/paraglide/messages";
	import { formatDate } from "$lib/i18n/format";
	import Modal from "$lib/components/Modal.svelte";
	import CopyToClipBoardBtn from "$lib/components/CopyToClipBoardBtn.svelte";
	import CarbonClose from "~icons/carbon/close";
	import {
		createShare,
		listShares,
		revokeShare,
		updateShare,
		type ShareLink,
	} from "$lib/utils/shareLinks";

	interface Props {
		conversationId: string;
		artifact: SharedArtifact;
		onclose?: () => void;
	}

	let { conversationId, artifact, onclose }: Props = $props();

	const artifactId = $derived(artifact.kind === "text" ? artifact.identifier : artifact.name);
	const heading = $derived(artifact.kind === "text" ? artifact.title : artifact.name);

	let loading = $state(true);
	let existing = $state<ShareLink | null>(null);
	let url = $state<string | null>(null);
	let audience = $state<"signed_in" | "anyone">("signed_in");
	let expiry = $state<ShareExpiry>(30);
	let busy = $state(false);
	let failure = $state<string | null>(null);
	let note = $state<string | null>(null);

	const EXPIRIES: Array<{ value: ShareExpiry; label: () => string }> = [
		{ value: 7, label: () => m["share.dialog.expiry_days"]({ days: 7 }) },
		{ value: 30, label: () => m["share.dialog.expiry_days"]({ days: 30 }) },
		{ value: 90, label: () => m["share.dialog.expiry_days"]({ days: 90 }) },
		{ value: null, label: () => m["share.dialog.expiry_never"]() },
	];

	onMount(async () => {
		try {
			const { data } = await listShares();
			existing =
				data.find(
					(link) =>
						link.status === "active" &&
						link.conversationId === conversationId &&
						link.artifactId === artifactId
				) ?? null;
			if (existing) audience = existing.audience;
		} catch {
			failure = m["share.dialog.error"]();
		} finally {
			loading = false;
		}
	});

	async function run(action: () => Promise<void>) {
		busy = true;
		failure = null;
		note = null;
		try {
			await action();
		} catch (err) {
			failure = err instanceof Error && err.message ? err.message : m["share.dialog.error"]();
		} finally {
			busy = false;
		}
	}

	const create = () =>
		run(async () => {
			const common = { conversationId, audience, expiryDays: expiry };
			const made = await createShare(
				artifact.kind === "text"
					? { ...common, kind: "text", identifier: artifact.identifier, version: artifact.version }
					: { ...common, kind: "file", name: artifact.name, sha256: artifact.sha256 }
			);
			existing = made.share;
			url = made.url;
		});

	const change = (changes: Parameters<typeof updateShare>[1], message?: string) =>
		run(async () => {
			if (!existing) return;
			const done = await updateShare(existing.id, changes);
			existing = done.share;
			if (done.url) url = done.url;
			if (message) note = message;
		});

	const revoke = () =>
		run(async () => {
			if (!existing) return;
			await revokeShare(existing.id);
			existing = null;
			url = null;
			note = m["share.dialog.revoked"]();
		});

	const shownAudience = $derived(existing ? existing.audience : audience);
	const behind = $derived(
		existing && artifact.kind === "text" && existing.version !== undefined
			? existing.version < artifact.latestVersion
			: artifact.kind === "file"
	);
	const excerpt = $derived(artifact.kind === "text" ? artifact.content.slice(0, 280) : "");
</script>

<Modal onclose={() => onclose?.()} width="w-[92dvw] md:w-[520px]" labelledBy="share-dialog-title">
	<div class="flex w-full flex-col gap-4 p-6" data-testid="share-dialog">
		<div class="flex items-start justify-between gap-3">
			<h2 id="share-dialog-title" class="text-xl font-semibold text-gray-800 dark:text-gray-200">
				{m["share.dialog.title"]()}
			</h2>
			<button
				type="button"
				class="group outline-hidden"
				onclick={() => onclose?.()}
				aria-label={m["app.close"]()}
			>
				<CarbonClose class="size-5 text-gray-700 group-hover:text-gray-500 dark:text-gray-300" />
			</button>
		</div>

		<!-- The preview: what the link will show, as it stands now. -->
		<section
			class="rounded-xl border border-gray-200 bg-gray-50 p-3 text-sm dark:border-gray-700 dark:bg-gray-900"
			aria-label={m["share.dialog.preview"]()}
			data-testid="share-preview"
		>
			<p class="font-medium text-gray-800 dark:text-gray-200">{heading}</p>
			<p class="text-xs text-gray-500 dark:text-gray-400">
				{#if artifact.kind === "text"}
					{m["share.dialog.preview_text"]({ type: artifact.type, version: artifact.version })}
				{:else}
					{m["share.dialog.preview_file"]({ type: artifact.mime })}
				{/if}
			</p>
			{#if excerpt}
				<pre
					class="mt-2 max-h-24 overflow-hidden text-xs break-words whitespace-pre-wrap text-gray-600 dark:text-gray-400">{excerpt}</pre>
			{/if}
		</section>

		{#if loading}
			<p class="text-sm text-gray-500">{m["share.dialog.loading"]()}</p>
		{:else}
			<fieldset class="flex flex-col gap-2" disabled={busy}>
				<legend class="mb-1 text-sm font-medium text-gray-700 dark:text-gray-300">
					{m["share.dialog.audience"]()}
				</legend>
				{#each [{ value: "signed_in", label: m["share.dialog.audience_signed_in"]() }, { value: "anyone", label: m["share.dialog.audience_anyone"]() }] as option (option.value)}
					<label class="flex items-center gap-2 text-sm text-gray-800 dark:text-gray-200">
						<input
							type="radio"
							name="share-audience"
							value={option.value}
							checked={shownAudience === option.value}
							onchange={() => {
								audience = option.value as "signed_in" | "anyone";
								if (existing) void change({ audience });
							}}
						/>
						{option.label}
					</label>
				{/each}
			</fieldset>

			<label class="flex flex-col gap-1 text-sm font-medium text-gray-700 dark:text-gray-300">
				{m["share.dialog.expiry"]()}
				<select
					class="rounded-lg border border-gray-300 bg-white px-2 py-1.5 text-sm font-normal text-gray-900 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100"
					disabled={busy}
					value={String(existing ? currentExpiryDays(existing) : expiry)}
					onchange={(event) => {
						const raw = event.currentTarget.value;
						expiry = raw === "null" ? null : (Number(raw) as ShareExpiry);
						if (existing) void change({ expiryDays: expiry });
					}}
				>
					{#each EXPIRIES as option (String(option.value))}
						<option value={String(option.value)}>{option.label()}</option>
					{/each}
				</select>
				{#if existing?.expiresAt}
					<span class="text-xs font-normal text-gray-500">
						{m["share.dialog.expires_on"]({ date: formatDate(existing.expiresAt) })}
					</span>
				{/if}
			</label>

			<p
				class="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100"
				data-testid="share-notice"
			>
				{shownAudience === "anyone"
					? m["share.dialog.notice_anyone"]()
					: m["share.dialog.notice_signed_in"]()}
				{m["share.dialog.notice_frozen"]()}
			</p>

			{#if url}
				<div class="flex flex-col gap-1">
					<label for="share-url" class="text-sm font-medium text-gray-700 dark:text-gray-300">
						{m["share.dialog.link"]()}
					</label>
					<div class="flex items-center gap-2">
						<input
							id="share-url"
							readonly
							value={url}
							class="min-w-0 flex-1 rounded-lg border border-gray-300 bg-white px-2 py-1.5 font-mono text-xs text-gray-900 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100"
							onfocus={(event) => event.currentTarget.select()}
						/>
						<CopyToClipBoardBtn
							value={url}
							classNames="btn rounded-lg border border-gray-300 px-2.5 py-1.5 text-sm dark:border-gray-700"
						>
							<span data-testid="share-copy">{m["share.dialog.copy"]()}</span>
						</CopyToClipBoardBtn>
					</div>
					<p class="text-xs text-gray-500">{m["share.dialog.link_once"]()}</p>
				</div>
			{:else if existing}
				<p class="text-xs text-gray-500">
					{m["share.dialog.existing"]({
						date: formatDate(existing.createdAt),
						views: existing.views,
					})}
				</p>
			{/if}

			{#if failure}
				<p class="text-sm text-red-600 dark:text-red-400" role="alert">{failure}</p>
			{/if}
			{#if note}
				<p class="text-sm text-gray-600 dark:text-gray-300" role="status">{note}</p>
			{/if}

			<div class="flex flex-wrap items-center justify-end gap-2">
				{#if existing}
					<button type="button" class={ghost} disabled={busy} onclick={revoke}>
						{m["share.dialog.revoke"]()}
					</button>
					<button
						type="button"
						class={ghost}
						disabled={busy}
						onclick={() => change({ rotate: true }, m["share.dialog.replaced"]())}
					>
						{m["share.dialog.replace"]()}
					</button>
					<button
						type="button"
						class={ghost}
						disabled={busy || !behind}
						onclick={() => change({ toLatest: true }, m["share.dialog.updated"]())}
					>
						{m["share.dialog.update_latest"]()}
					</button>
				{:else}
					<button type="button" class={primary} disabled={busy} onclick={create}>
						{m["share.dialog.create"]()}
					</button>
				{/if}
			</div>
		{/if}
	</div>
</Modal>
