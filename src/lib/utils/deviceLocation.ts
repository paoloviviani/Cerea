/**
 * The browser's location, for the "From this device" setting. Held only in
 * memory here and sent with each turn; the server never stores coordinates.
 * The permission prompt appears only when `requestDeviceLocation` is called,
 * which the app does only while that setting is on.
 */
import { roundCoordinate, type DeviceLocation } from "$lib/utils/location";

export type DeviceLocationResult =
	{ ok: true; location: DeviceLocation } | { ok: false; reason: "denied" | "unavailable" };

let latest: DeviceLocation | undefined;

/** The last reading, or undefined (never read, denied, or sharing off). */
export function currentDeviceLocation(): DeviceLocation | undefined {
	return latest;
}

export function clearDeviceLocation(): void {
	latest = undefined;
}

/** Asks the browser (and so the person, the first time) for a fresh reading, rounded to about 1 km. */
export function requestDeviceLocation(): Promise<DeviceLocationResult> {
	if (typeof navigator === "undefined" || !navigator.geolocation) {
		latest = undefined;
		return Promise.resolve({ ok: false, reason: "unavailable" });
	}
	return new Promise((resolve) => {
		navigator.geolocation.getCurrentPosition(
			(position) => {
				latest = {
					lat: roundCoordinate(position.coords.latitude),
					lon: roundCoordinate(position.coords.longitude),
					accuracy: Math.round(position.coords.accuracy),
				};
				resolve({ ok: true, location: latest });
			},
			(err) => {
				latest = undefined;
				// code 1 is PERMISSION_DENIED; position unavailable and timeout read as unavailable
				resolve({ ok: false, reason: err.code === 1 ? "denied" : "unavailable" });
			},
			{ maximumAge: 10 * 60 * 1000, timeout: 10_000 }
		);
	});
}
