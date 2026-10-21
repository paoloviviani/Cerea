/**
 * The person's opt-in location (Settings, "Location"), shared by the settings
 * API, the turn route, the prompt and the settings page.
 *
 * Off by default. `place` is text the person typed; `device` is the browser's
 * Geolocation, which is held only in the browser and sent with each turn,
 * never stored server-side.
 */
import { z } from "zod";

export const LOCATION_MODES = ["off", "place", "device"] as const;
export type LocationMode = (typeof LOCATION_MODES)[number];

export const LOCATION_PLACE_MAX = 100;

/** Device coordinates, rounded to two decimals (about 1 km) before they leave the browser. */
export interface DeviceLocation {
	lat: number;
	lon: number;
	/** Metres, as reported by the browser. */
	accuracy?: number;
}

export function parseLocationMode(value: unknown): LocationMode {
	return LOCATION_MODES.includes(value as LocationMode) ? (value as LocationMode) : "off";
}

/**
 * A typed place as one plain line: control characters (newlines included)
 * become spaces, whitespace collapses, and the length is capped, so a place
 * can never add a line or an instruction of its own to the prompt.
 */
export function sanitizePlace(value: string): string {
	return (
		value
			// eslint-disable-next-line no-control-regex
			.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ")
			.replace(/\s+/g, " ")
			.trim()
			.slice(0, LOCATION_PLACE_MAX)
	);
}

export function roundCoordinate(value: number): number {
	return Math.round(value * 100) / 100;
}

/** The settings fields, for both settings routes. */
export const locationSettingsFields = {
	locationMode: z.enum(LOCATION_MODES).optional(),
	locationPlace: z.string().max(LOCATION_PLACE_MAX).transform(sanitizePlace).optional(),
};

/**
 * The turn's optional device location. A malformed one is dropped, not an
 * error: a bad reading must not fail the message it rides on.
 */
export const deviceLocationSchema = z
	.object({
		lat: z.number().min(-90).max(90),
		lon: z.number().min(-180).max(180),
		accuracy: z.number().min(0).max(1e7).optional(),
	})
	.transform(({ lat, lon, accuracy }): DeviceLocation => ({
		lat: roundCoordinate(lat),
		lon: roundCoordinate(lon),
		...(accuracy === undefined ? {} : { accuracy: Math.round(accuracy) }),
	}))
	.optional()
	.catch(undefined);

function validZone(zone: string | undefined): string | undefined {
	if (!zone) return undefined;
	try {
		new Intl.DateTimeFormat("en", { timeZone: zone });
		return zone;
	} catch {
		return undefined;
	}
}

/**
 * The one prompt line, or undefined when nothing is shared. The device
 * location counts only when the setting is `device`; a typed place only when
 * it is `place`. The timezone rides along in both modes when it is a real zone.
 */
export function locationLine({
	mode,
	place,
	device,
	timezone,
}: {
	mode?: unknown;
	place?: string;
	device?: DeviceLocation;
	timezone?: string;
}): string | undefined {
	const m = parseLocationMode(mode);
	let where: string | undefined;
	if (m === "place") {
		where = sanitizePlace(place ?? "") || undefined;
	} else if (m === "device" && device) {
		where = `approximately ${roundCoordinate(device.lat).toFixed(2)}, ${roundCoordinate(device.lon).toFixed(2)} (from their device)`;
	}
	if (!where) return undefined;
	const zone = validZone(timezone);
	return `The person's location (shared by them): ${where}${zone ? `, timezone ${zone}` : ""}.`;
}
