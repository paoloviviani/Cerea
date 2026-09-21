<script lang="ts">
	import { usePublicConfig } from "$lib/utils/PublicConfig.svelte";

	const publicConfig = usePublicConfig();

	interface Props {
		classNames?: string;
	}

	let { classNames = "" }: Props = $props();
</script>

<!--
	The mark is the mountain silhouette over Turin — a wide 326×104 drawing,
	not a square badge, so callers size it by height and let the width
	follow. Two files, one per theme: the black ridge on a light background,
	the white one on a dark one, switched by the same class-based dark
	variant every color token uses (no `invert` filter — that would land the
	white variant at #e1e1e1, not the white it was drawn in). Both load as
	<img>, so filter/gradient ids stay inside their own documents. The
	outline predecessors of this mark stay archived under brand/.
-->
<img
	width="326"
	height="104"
	class="{classNames} dark:hidden"
	alt="{publicConfig.PUBLIC_APP_NAME} logo"
	src="{publicConfig.assetPath}/logo.svg"
/>
<img
	width="326"
	height="104"
	class="{classNames} hidden dark:block"
	alt=""
	aria-hidden="true"
	src="{publicConfig.assetPath}/logo-white.svg"
/>
