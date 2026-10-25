<script lang="ts">
	import { m } from "$lib/paraglide/messages";
	import { requestDeviceLocation } from "$lib/utils/deviceLocation";
	import { LOCATION_PLACE_MAX, type LocationMode } from "$lib/utils/location";

	interface Props {
		mode: LocationMode;
		place: string;
		onchange: (next: { mode?: LocationMode; place?: string }) => void;
	}

	let { mode, place, onchange }: Props = $props();

	// "unavailable" and "denied" keep the setting: nothing is shared until the
	// browser lets us read it.
	let deviceState = $state<"idle" | "checking" | "ok" | "denied" | "unavailable">("idle");

	async function choose(next: LocationMode) {
		onchange({ mode: next });
		if (next !== "device") {
			deviceState = "idle";
			return;
		}
		deviceState = "checking";
		const result = await requestDeviceLocation();
		deviceState = result.ok ? "ok" : result.reason;
	}

	const options: { value: LocationMode; label: () => string }[] = [
		{ value: "off", label: m["settings.location.option.off"] },
		{ value: "place", label: m["settings.location.option.place"] },
		{ value: "device", label: m["settings.location.option.device"] },
	];
</script>

<section
	aria-labelledby="location-heading"
	class="rounded-xl border border-gray-200 bg-white px-3 pb-3 shadow-xs dark:border-gray-700 dark:bg-gray-800"
>
	<h2 id="location-heading" class="pt-3 text-[13px] font-semibold text-gray-800 dark:text-gray-200">
		{m["settings.location.heading"]()}
	</h2>
	<p class="mt-1 text-[12px] text-gray-500 dark:text-gray-400">
		{m["settings.location.description"]()}
	</p>

	<div class="mt-3 flex items-start justify-between gap-3">
		<label for="location-mode" class="text-[13px] font-medium text-gray-800 dark:text-gray-200">
			{m["settings.location.mode_label"]()}
		</label>
		<select
			id="location-mode"
			name="locationMode"
			class="rounded-md border border-gray-300 bg-white px-1 py-1 text-xs text-gray-800 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200"
			value={mode}
			onchange={(e) => choose(e.currentTarget.value as LocationMode)}
		>
			{#each options as option (option.value)}
				<option value={option.value}>{option.label()}</option>
			{/each}
		</select>
	</div>

	{#if mode === "place"}
		<label class="mt-3 block">
			<span class="text-[12px] text-gray-500 dark:text-gray-400"
				>{m["settings.location.place_label"]()}</span
			>
			<input
				type="text"
				name="locationPlace"
				maxlength={LOCATION_PLACE_MAX}
				placeholder={m["settings.location.place_placeholder"]()}
				value={place}
				oninput={(e) => onchange({ place: e.currentTarget.value })}
				class="mt-1 block w-full rounded-md border border-gray-300 bg-white px-2 py-1 text-[13px] text-gray-800 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200"
			/>
		</label>
	{:else if mode === "device"}
		<p class="mt-3 text-[12px] text-gray-500 dark:text-gray-400" data-testid="location-device-note">
			{m["settings.location.device_note"]()}
		</p>
		{#if deviceState === "checking"}
			<p class="mt-1 text-[12px] text-gray-500 dark:text-gray-400">
				{m["settings.location.checking"]()}
			</p>
		{:else if deviceState === "ok"}
			<p class="mt-1 text-[12px] text-gray-500 dark:text-gray-400">
				{m["settings.location.available"]()}
			</p>
		{:else if deviceState === "denied"}
			<p class="mt-1 text-[12px] text-amber-700 dark:text-amber-400" role="alert">
				{m["settings.location.denied"]()}
			</p>
		{:else if deviceState === "unavailable"}
			<p class="mt-1 text-[12px] text-amber-700 dark:text-amber-400" role="alert">
				{m["settings.location.unavailable"]()}
			</p>
		{/if}
	{/if}
</section>
