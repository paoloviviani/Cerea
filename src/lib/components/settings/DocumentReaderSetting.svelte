<!--
	A user's default document reader for chat uploads, in their settings. It
	starts as the administrator's default; the list is the gateway's OCR models
	this user may use. Saved as it is chosen (its own route validates it), shown
	only when the deployment offers a reader at all.
-->
<script lang="ts">
	import { onMount } from "svelte";
	import { base } from "$app/paths";
	import { m } from "$lib/paraglide/messages";
	import DocumentReaderPicker from "$lib/components/knowledge/DocumentReaderPicker.svelte";

	let models = $state<string[]>([]);
	let defaultReader = $state<string | null>(null);
	let value = $state("");
	let loaded = $state(false);
	let saving = $state(false);
	let failure = $state<string | null>(null);

	onMount(async () => {
		try {
			const response = await fetch(`${base}/api/v2/user/document-reader`);
			if (!response.ok) return;
			const body = (await response.json()) as {
				reader_model: string | null;
				reader_models: string[];
				reader_default: string | null;
			};
			models = body.reader_models;
			defaultReader = body.reader_default;
			value = body.reader_model ?? "";
			loaded = true;
		} catch {
			// Nothing to offer without the list; the row stays out.
		}
	});

	async function save(choice: string) {
		saving = true;
		failure = null;
		try {
			const response = await fetch(`${base}/api/v2/user/document-reader`, {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ reader_model: choice || null }),
			});
			if (!response.ok) {
				const body = (await response.json().catch(() => null)) as { message?: string } | null;
				failure = body?.message ?? m["settings.application.reader.failed"]();
			}
		} catch {
			failure = m["settings.application.reader.failed"]();
		} finally {
			saving = false;
		}
	}
</script>

{#if loaded && (models.length > 0 || defaultReader)}
	<div class="py-3" data-testid="document-reader-setting">
		<div class="text-[13px] font-medium text-gray-800 dark:text-gray-200">
			{m["settings.application.reader.title"]()}
		</div>
		<p class="mb-2 text-[12px] text-gray-500 dark:text-gray-400">
			{m["settings.application.reader.description"]()}
		</p>
		<div class="max-w-sm">
			<DocumentReaderPicker
				id="user-document-reader"
				{models}
				{defaultReader}
				bind:value
				disabled={saving}
				onchange={(choice) => void save(choice)}
			/>
		</div>
		{#if failure}
			<p class="mt-1 text-[12px] text-red-600 dark:text-red-400" role="alert">{failure}</p>
		{/if}
	</div>
{/if}
