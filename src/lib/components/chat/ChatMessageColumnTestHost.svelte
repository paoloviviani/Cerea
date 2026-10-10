<!--
	Test-only host for ChatMessageColumn's history-paging surface: a fixed
	height the column can scroll in, with the required composer snippet and
	the page-prepend path the agent view drives. Not imported anywhere but
	its spec.
-->
<script lang="ts">
	import ChatMessageColumn from "./ChatMessageColumn.svelte";
	import type { Message } from "$lib/types/Message";

	interface Props {
		initial: Message[];
		page: Message[];
		onNearTop?: () => void;
	}

	let { initial, page, onNearTop }: Props = $props();

	// Seeded in an effect, not at declaration (reading the prop into
	// `$state` there trips `state_referenced_locally`): the host owns its
	// lifetime (one mount per test), and a live array is what the column
	// reads and the test prepends into.
	let messages = $state<Message[]>([]);
	$effect.pre(() => {
		messages = [...initial];
	});
	let column: ChatMessageColumn | undefined = $state();

	export function messageCount(): number {
		return messages.length;
	}

	export function prependPage(): void {
		column?.prependWithAnchor(() => messages.unshift(...page));
	}
</script>

<div style="display: flex; flex-direction: column; height: 320px;">
	<ChatMessageColumn
		{messages}
		onScrollNearTop={onNearTop}
		conversationKey="test-paging"
		bind:this={column}
	>
		{#snippet composer()}
			<div>composer</div>
		{/snippet}
	</ChatMessageColumn>
</div>
