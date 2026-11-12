<script lang="ts">
	import { m } from "$lib/paraglide/messages";
	import Modal from "../Modal.svelte";
	import { tick } from "svelte";
	import { BrowserApiError, openBrowser, type BrowserComputer } from "$lib/browserApi";
	import { useNotificationsStore } from "$lib/stores/notifications.svelte";

	/**
	 * "Open browser…" from the composer's + menu (ADR 0116, C109): an optional address and the list
	 * of the computers whose browser is ready, the default first. Choosing a computer opens the page
	 * there and, in a conversation, ties it to the chat as its kept page: the next browse continues
	 * on it with no approval. One computer: a single button, no question.
	 */
	interface Props {
		open?: boolean;
		computers: BrowserComputer[];
		/** The conversation the page is tied to; absent on the home page (the page is then just a tab). */
		conversationId?: string;
		onclose?: () => void;
	}

	let { open = $bindable(false), computers, conversationId, onclose }: Props = $props();
	const toasts = useNotificationsStore();

	let address = $state("");
	let opening = $state<string | null>(null);
	let errorMsg = $state("");
	let inputEl: HTMLInputElement | undefined = $state();

	$effect(() => {
		if (open) {
			address = "";
			errorMsg = "";
			opening = null;
			void tick().then(() => setTimeout(() => inputEl?.focus(), 0));
		}
	});

	function close() {
		open = false;
		onclose?.();
	}

	async function openOn(computer: BrowserComputer) {
		if (opening) return;
		opening = computer.id;
		errorMsg = "";
		try {
			await openBrowser({
				deviceId: computer.id,
				...(address.trim() ? { url: address.trim() } : {}),
				...(conversationId ? { conversationId } : {}),
			});
			toasts?.pushMessage(m["chat.browser_open.opened"]({ computer: computer.name }));
			close();
		} catch (err) {
			// i18n: server text (busy, offline, a refused address)
			errorMsg = err instanceof BrowserApiError ? err.message : m["chat.browser_open.failed"]();
		} finally {
			opening = null;
		}
	}
</script>

{#if open}
	<Modal onclose={close} width="w-[90dvh] md:w-[480px]">
		{#snippet children()}
			<form
				class="flex w-full flex-col gap-4 p-6"
				data-testid="open-browser-modal"
				onsubmit={(e) => {
					e.preventDefault();
					if (computers.length === 1) void openOn(computers[0]);
				}}
			>
				<h2 class="text-xl font-semibold text-gray-800 dark:text-gray-200">
					{m["chat.browser_open.title"]()}
				</h2>
				<div class="flex flex-col gap-2">
					<label class="text-sm text-gray-600 dark:text-gray-400" for="open-browser-address"
						>{m["chat.browser_open.address"]()}</label
					>
					<input
						id="open-browser-address"
						bind:this={inputEl}
						bind:value={address}
						type="text"
						inputmode="url"
						autocapitalize="off"
						autocomplete="off"
						spellcheck="false"
						placeholder={"example.com"}
						class="w-full rounded-xl border border-gray-200 bg-white px-3 py-2 text-[15px] text-gray-800 outline-hidden placeholder:text-ink-faint focus:ring-2 focus:ring-gray-200 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100 dark:focus:ring-gray-700"
					/>
				</div>

				{#if computers.length > 1}
					<p class="text-sm text-gray-600 dark:text-gray-400">{m["chat.browser_open.choose"]()}</p>
				{/if}
				<ul class="flex flex-col gap-2" data-testid="open-browser-computers">
					{#each computers as computer (computer.id)}
						<li>
							<button
								type="button"
								class="flex min-h-11 w-full items-center gap-2 rounded-xl border border-gray-300 bg-white px-3 py-2 text-left text-sm font-medium text-gray-900 shadow-sm hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-700 dark:bg-gray-700 dark:text-gray-100 dark:hover:bg-gray-600"
								disabled={opening !== null}
								data-testid="open-browser-computer"
								onclick={() => void openOn(computer)}
							>
								<span class="min-w-0 flex-1 truncate">
									{#if opening === computer.id}
										{m["chat.browser_open.opening"]()}
									{:else if computers.length === 1}
										{m["chat.browser_open.open_on"]({ computer: computer.name })}
									{:else}
										{computer.name}
									{/if}
								</span>
								{#if computer.default && computers.length > 1}
									<span
										class="shrink-0 rounded-full bg-blue-600/10 px-2 py-0.5 text-xs text-blue-600 dark:bg-blue-600/20 dark:text-blue-400"
										>{m["chat.browser_open.default_tag"]()}</span
									>
								{/if}
							</button>
						</li>
					{/each}
				</ul>

				{#if errorMsg}
					<p class="text-sm text-red-600 dark:text-red-400" role="alert">{errorMsg}</p>
				{/if}
				<p class="text-xs text-gray-500 dark:text-gray-400">
					{conversationId ? m["chat.browser_open.hint_chat"]() : m["chat.browser_open.hint_tab"]()}
				</p>
				<div class="flex items-center justify-end">
					<button
						type="button"
						class="inline-flex items-center rounded-xl border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-900 shadow-sm hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-700 dark:text-gray-100 dark:hover:bg-gray-600"
						onclick={close}
					>
						{m["app.cancel"]()}
					</button>
				</div>
			</form>
		{/snippet}
	</Modal>
{/if}
