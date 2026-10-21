<script lang="ts">
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

	const options: { value: LocationMode; label: string }[] = [
		{ value: "off", label: "Off" },
		{ value: "place", label: "A place I type" },
		{ value: "device", label: "From this device" },
	];
</script>

<section
	aria-labelledby="location-heading"
	class="rounded-xl border border-gray-200 bg-white px-3 pb-3 shadow-xs dark:border-gray-700 dark:bg-gray-800"
>
	<h2 id="location-heading" class="pt-3 text-[13px] font-semibold text-gray-800 dark:text-gray-200">
		Location
	</h2>
	<p class="mt-1 text-[12px] text-gray-500 dark:text-gray-400">
		Share where you are so answers about weather, local time and nearby places fit. While sharing is
		on, your location is sent to the model provider with every message. Off by default.
	</p>

	<div role="radiogroup" aria-label="Share my location" class="mt-3 flex flex-col gap-2">
		{#each options as option (option.value)}
			<label class="flex items-center gap-2 text-[13px] text-gray-800 dark:text-gray-200">
				<input
					type="radio"
					name="locationMode"
					value={option.value}
					checked={mode === option.value}
					onchange={() => choose(option.value)}
				/>
				{option.label}
			</label>
		{/each}
	</div>

	{#if mode === "place"}
		<label class="mt-3 block">
			<span class="text-[12px] text-gray-500 dark:text-gray-400">Place</span>
			<input
				type="text"
				name="locationPlace"
				maxlength={LOCATION_PLACE_MAX}
				placeholder="Torino, Italy"
				value={place}
				oninput={(e) => onchange({ place: e.currentTarget.value })}
				class="mt-1 block w-full rounded-md border border-gray-300 bg-white px-2 py-1 text-[13px] text-gray-800 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200"
			/>
		</label>
	{:else if mode === "device"}
		<p class="mt-3 text-[12px] text-gray-500 dark:text-gray-400" data-testid="location-device-note">
			Uses your browser's location permission. Coordinates are rounded to about 1 km, read when you
			open a chat, and not stored on the server.
		</p>
		{#if deviceState === "checking"}
			<p class="mt-1 text-[12px] text-gray-500 dark:text-gray-400">Asking your browser...</p>
		{:else if deviceState === "ok"}
			<p class="mt-1 text-[12px] text-gray-500 dark:text-gray-400">Location available.</p>
		{:else if deviceState === "denied"}
			<p class="mt-1 text-[12px] text-amber-700 dark:text-amber-400" role="alert">
				Location permission was denied in this browser, so nothing is shared. Allow it in the
				browser's site settings and choose this option again.
			</p>
		{:else if deviceState === "unavailable"}
			<p class="mt-1 text-[12px] text-amber-700 dark:text-amber-400" role="alert">
				This device's location is unavailable, so nothing is shared.
			</p>
		{/if}
	{/if}
</section>
