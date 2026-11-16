<script lang="ts">
	let { deviceId, workspaceId }: { deviceId: string; workspaceId: string } = $props();
</script>

<div data-testid="panel-stub">{deviceId} {workspaceId}</div>
