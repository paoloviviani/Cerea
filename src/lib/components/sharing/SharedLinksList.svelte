<!--
	A table of share links (ADR 0120), for Settings (your own) and Administration (all).
	Never shows a link's address: only its hash is stored.
-->
<script lang="ts">
	import { base } from "$app/paths";
	import { m } from "$lib/paraglide/messages";
	import { formatDate, formatNumber } from "$lib/i18n/format";
	import type { ShareLink } from "$lib/utils/shareLinks";

	interface Props {
		links: ShareLink[];
		/** Administration also shows who shared it. */
		showOwner?: boolean;
		busyId?: string | null;
		onrevoke: (link: ShareLink) => void;
	}

	let { links, showOwner = false, busyId = null, onrevoke }: Props = $props();

	const th = "px-3 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400";
	const td = "px-3 py-2 align-top text-sm text-gray-800 dark:text-gray-200";
</script>

<div
	class="overflow-x-auto rounded-xl border border-gray-200 bg-white shadow-xs dark:border-gray-700 dark:bg-gray-800"
>
	<table class="w-full min-w-[640px] border-collapse" data-testid="shared-links-table">
		<thead>
			<tr class="border-b border-gray-200 dark:border-gray-700">
				<th class={th}>{m["share.list.col_artifact"]()}</th>
				<th class={th}>{m["share.list.col_chat"]()}</th>
				{#if showOwner}<th class={th}>{m["share.list.col_owner"]()}</th>{/if}
				<th class={th}>{m["share.list.col_audience"]()}</th>
				<th class={th}>{m["share.list.col_expires"]()}</th>
				<th class={th}>{m["share.list.col_views"]()}</th>
				<th class={th}>{m["share.list.col_created"]()}</th>
				<th class={th}><span class="sr-only">{m["share.list.revoke"]()}</span></th>
			</tr>
		</thead>
		<tbody>
			{#each links as link (link.id)}
				<tr
					class="border-b border-gray-100 last:border-0 dark:border-gray-700"
					data-testid="shared-link-row"
				>
					<td class={td}>{link.title}</td>
					<td class={td}>
						<a
							class="text-blue-600 hover:underline dark:text-blue-400"
							href="{base}/conversation/{link.conversationId}"
						>
							{link.conversationTitle}
						</a>
					</td>
					{#if showOwner}<td class={td}>{link.ownerName}</td>{/if}
					<td class={td}>
						{link.audience === "anyone"
							? m["share.list.audience_anyone"]()
							: m["share.list.audience_signed_in"]()}
					</td>
					<td class={td}>
						{#if link.status === "revoked"}
							{m["share.list.status_revoked"]()}
						{:else if link.status === "expired"}
							{m["share.list.status_expired"]()}
						{:else if link.expiresAt}
							{formatDate(link.expiresAt)}
						{:else}
							{m["share.list.never"]()}
						{/if}
					</td>
					<td class={td}>{formatNumber(link.views)}</td>
					<td class={td}>{formatDate(link.createdAt)}</td>
					<td class="{td} text-right">
						{#if link.status !== "revoked"}
							<button
								type="button"
								class="rounded-lg border border-gray-300 px-2 py-1 text-xs font-medium hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:hover:bg-gray-700"
								disabled={busyId === link.id}
								aria-label={m["share.list.revoke_named"]({ title: link.title })}
								onclick={() => onrevoke(link)}
							>
								{m["share.list.revoke"]()}
							</button>
						{/if}
					</td>
				</tr>
			{/each}
		</tbody>
	</table>
</div>
