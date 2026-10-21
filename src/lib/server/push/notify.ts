/**
 * Telling a person something through their subscribed browsers.
 *
 * The one place a push is decided and sent. Callers say who, which event and
 * what to show; this checks the deployment has push switched on, that the
 * person turned that event on, that they are not being sent too much, and
 * then delivers to every browser they subscribed, forgetting the ones the
 * push service says are gone.
 *
 * **The payload is deliberately thin.** A title, a line of text and a path to
 * open. Never message content, tool arguments, file names, prompts or
 * commands: the push service relays it (encrypted, but through a third
 * party's servers), and a lock screen shows it to whoever holds the phone. A
 * person who wants the detail taps through to the app, which has it behind
 * the sign-in.
 */

import type { ObjectId } from "mongodb";
import { base } from "$app/paths";
import { collections } from "$lib/server/database";
import { config } from "$lib/server/config";
import { logger } from "$lib/server/logger";
import { pushEventEnabled, type PushEvent } from "$lib/utils/pushEvents";
import { pushFetch } from "./guard";
import { removeByEndpoint, listSubscriptions } from "./store";
import { vapidKeys } from "./vapid";
import { sendWebPush, type PushFetch, type PushUrgency, type SendOutcome } from "./webpush";

export interface PushMessage {
	title: string;
	body: string;
	/** A path inside the app, without the base (`/code?device=…`). */
	path: string;
	/** Notifications with the same tag replace one another on the device. */
	tag?: string;
}

/** What the service worker receives. Versioned so it can ignore a shape it does not know. */
export interface PushPayload {
	v: 1;
	title: string;
	body: string;
	/** Absolute path including the base: what a click opens. */
	url: string;
	tag?: string;
	/** The app icon, absolute path including the base. */
	icon: string;
	event: PushEvent | "test";
}

const TEXT_LIMITS = { title: 80, body: 140 };

function clip(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

export function buildPayload(
	event: PushEvent | "test",
	message: PushMessage,
	appBase: string = base,
	assetDir: string = config.PUBLIC_APP_ASSETS || "chatui"
): PushPayload {
	// A path, never a URL: a click cannot be made to open somewhere else.
	const path = message.path.startsWith("/") && !message.path.startsWith("//") ? message.path : "/";
	return {
		v: 1,
		title: clip(message.title, TEXT_LIMITS.title),
		body: clip(message.body, TEXT_LIMITS.body),
		url: `${appBase}${path}`,
		icon: `${appBase}/${assetDir}/icon-192x192.png`,
		...(message.tag ? { tag: message.tag.slice(0, 64) } : {}),
		event,
	};
}

/** How long and how loudly each event is delivered: an approval is waiting on a
 * person now and worth a day; a finished run is worth an hour. */
const DELIVERY: Record<PushEvent | "test", { ttl: number; urgency: PushUrgency }> = {
	permission: { ttl: 24 * 3600, urgency: "high" },
	agentTurn: { ttl: 3600, urgency: "normal" },
	scheduleRun: { ttl: 6 * 3600, urgency: "normal" },
	backgroundTask: { ttl: 6 * 3600, urgency: "normal" },
	chatTurn: { ttl: 1800, urgency: "low" },
	test: { ttl: 60, urgency: "high" },
};

// -- the per-person rate limit ----------------------------------------------------

const WINDOW_MS = 5 * 60_000;
export const MAX_PUSHES_PER_WINDOW = 12;
const recent = new Map<string, number[]>();

/** Records an attempt and says whether it may go: at most 12 in five minutes
 * per person, so a runaway loop of approvals cannot flood a phone. */
export function allowPush(userId: ObjectId, now: number = Date.now()): boolean {
	const key = userId.toString();
	const times = (recent.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
	if (times.length >= MAX_PUSHES_PER_WINDOW) {
		recent.set(key, times);
		return false;
	}
	times.push(now);
	recent.set(key, times);
	if (recent.size > 5000) {
		for (const [k, v] of recent) if (v.every((t) => now - t >= WINDOW_MS)) recent.delete(k);
	}
	return true;
}

export function _resetPushRateLimit(): void {
	recent.clear();
}

// -- sending ----------------------------------------------------------------------

export interface NotifyDeps {
	fetch?: PushFetch;
	now?: () => number;
}

export interface NotifyResult {
	/** Why nothing was sent, when nothing was. */
	skipped?: "off" | "no-devices" | "event-disabled" | "rate-limited";
	accepted: number;
	gone: number;
	failed: number;
}

const NOTHING: NotifyResult = { accepted: 0, gone: 0, failed: 0 };

async function deliver(
	userId: ObjectId,
	event: PushEvent | "test",
	message: PushMessage,
	deps: NotifyDeps
): Promise<NotifyResult> {
	const keys = vapidKeys();
	if (!keys) return { ...NOTHING, skipped: "off" };
	const devices = await listSubscriptions(userId);
	if (devices.length === 0) return { ...NOTHING, skipped: "no-devices" };
	if (!allowPush(userId, deps.now?.())) return { ...NOTHING, skipped: "rate-limited" };

	const payload = JSON.stringify(buildPayload(event, message));
	const { ttl, urgency } = DELIVERY[event];
	const fetchImpl = deps.fetch ?? pushFetch;
	const result: NotifyResult = { accepted: 0, gone: 0, failed: 0 };

	await Promise.all(
		devices.map(async (device) => {
			let outcome: SendOutcome;
			try {
				outcome = await sendWebPush(
					device,
					payload,
					keys,
					{ ttl, urgency, ...(message.tag ? { topic: message.tag } : {}) },
					fetchImpl
				);
			} catch (err) {
				// An address the SSRF guard refuses at connect time, or a key the
				// browser gave us that does not encrypt: this device cannot be
				// reached, and trying again will not change that.
				logger.warn({ err: String(err), host: hostOf(device.endpoint) }, "push: send failed");
				result.failed++;
				return;
			}
			if (outcome.kind === "accepted") {
				result.accepted++;
				await collections.pushSubscriptions
					.updateOne({ _id: device._id }, { $set: { lastPushAt: new Date() } })
					.catch(() => undefined);
			} else if (outcome.kind === "gone") {
				result.gone++;
				await removeByEndpoint(device.endpoint).catch(() => undefined);
			} else {
				result.failed++;
				// The host and the status, never the endpoint's path: that is the capability.
				logger.warn(
					{ host: hostOf(device.endpoint), status: outcome.status, outcome: outcome.kind },
					"push: the push service did not take a message"
				);
			}
		})
	);
	return result;
}

function hostOf(endpoint: string): string {
	try {
		return new URL(endpoint).host;
	} catch {
		return "invalid";
	}
}

/**
 * Notify one person of one event, if they asked to hear about it. Never
 * throws: a notification is never worth failing the thing it reports on.
 */
export async function notifyUser(
	userId: ObjectId,
	event: PushEvent,
	message: PushMessage,
	deps: NotifyDeps = {}
): Promise<NotifyResult> {
	try {
		if (!vapidKeys()) return { ...NOTHING, skipped: "off" };
		const settings = await collections.settings.findOne(
			{ userId },
			{ projection: { pushEvents: 1 } }
		);
		if (!pushEventEnabled(settings?.pushEvents, event)) {
			return { ...NOTHING, skipped: "event-disabled" };
		}
		return await deliver(userId, event, message, deps);
	} catch (err) {
		logger.warn({ err: String(err), event }, "push: notify failed");
		return { ...NOTHING, failed: 1 };
	}
}

/** The Settings screen's "send a test": ignores the per-event switches (the
 * person is asking), keeps the rate limit. */
export async function sendTestNotification(
	userId: ObjectId,
	deps: NotifyDeps = {}
): Promise<NotifyResult> {
	return deliver(
		userId,
		"test",
		{
			title: "Notifications are on",
			body: "This is a test. You will be told when something needs you.",
			path: "/settings/notifications",
			tag: "test",
		},
		deps
	);
}
