<script lang="ts">
	// Test fixture for attachmentMounts.svelte.spec.ts: a page that registers its
	// conversation (as the chat page does) with a child that runs code as soon as it mounts.
	import type { MessageFile } from "$lib/types/Message";
	import { trackAttachmentSource } from "./attachmentMounts.svelte";
	import RunOnMountFixture from "./RunOnMountFixture.svelte";

	let { files, run }: { files: MessageFile[]; run: () => void } = $props();
	trackAttachmentSource(() => ({ conversationId: "c1", messages: [{ files }] }));
</script>

<RunOnMountFixture {run} />
