/**
 * Web Push for the signed-in person: what the Settings → Notifications screen
 * reads and writes. Owner-only and user-only (no anonymous sessions: a push
 * needs somebody to be told). The device list never carries an endpoint or a
 * key, only a label and dates, because those two are the capability to push
 * to that browser.
 */

import { error, json, type RequestHandler } from "@sveltejs/kit";
import { z } from "zod";
import { collections } from "$lib/server/database";
import { requireJsonBody } from "$lib/server/schedules/api";
import {
	deviceView,
	listSubscriptions,
	saveSubscription,
	SubscriptionError,
} from "$lib/server/push/store";
import { pushPublicKey } from "$lib/server/push/vapid";
import { PUSH_EVENTS, resolvePushEventPrefs } from "$lib/utils/pushEvents";

function requireUser(locals: App.Locals) {
	if (!locals.user) error(401, "Login required");
	return locals.user;
}

export const GET: RequestHandler = async ({ locals }) => {
	const user = requireUser(locals);
	const publicKey = pushPublicKey();
	const [devices, settings] = await Promise.all([
		publicKey ? listSubscriptions(user._id) : Promise.resolve([]),
		collections.settings.findOne({ userId: user._id }, { projection: { pushEvents: 1 } }),
	]);
	return json({
		data: {
			configured: publicKey !== null,
			publicKey,
			events: resolvePushEventPrefs(settings?.pushEvents),
			devices: devices.map(deviceView),
		},
	});
};

const subscribeBody = z.object({
	endpoint: z.string().max(2048),
	keys: z.object({ p256dh: z.string().max(200), auth: z.string().max(100) }),
});

export const POST: RequestHandler = async ({ locals, request }) => {
	const user = requireUser(locals);
	if (!pushPublicKey()) error(404, "Push notifications are not set up on this deployment.");
	requireJsonBody(request);
	const parsed = subscribeBody.safeParse(await request.json().catch(() => null));
	if (!parsed.success) error(400, "That is not a push subscription.");
	try {
		const row = await saveSubscription(user._id, {
			endpoint: parsed.data.endpoint,
			p256dh: parsed.data.keys.p256dh,
			auth: parsed.data.keys.auth,
			userAgent: request.headers.get("user-agent"),
		});
		return json({ data: { device: deviceView(row) } }, { status: 201 });
	} catch (err) {
		if (err instanceof SubscriptionError) error(400, err.message);
		throw err;
	}
};

const patchBody = z.object({
	events: z.object(Object.fromEntries(PUSH_EVENTS.map((e) => [e, z.boolean().optional()]))),
});

/** Switch events on or off; only the named ones change. */
export const PATCH: RequestHandler = async ({ locals, request }) => {
	const user = requireUser(locals);
	requireJsonBody(request);
	const parsed = patchBody.safeParse(await request.json().catch(() => null));
	if (!parsed.success) error(400, "That is not a notification setting.");
	const set: Record<string, boolean> = {};
	for (const [event, on] of Object.entries(parsed.data.events)) {
		if (typeof on === "boolean") set[`pushEvents.${event}`] = on;
	}
	if (Object.keys(set).length > 0) {
		await collections.settings.updateOne(
			{ userId: user._id },
			{ $set: { ...set, updatedAt: new Date() }, $setOnInsert: { createdAt: new Date() } },
			{ upsert: true }
		);
	}
	const settings = await collections.settings.findOne(
		{ userId: user._id },
		{ projection: { pushEvents: 1 } }
	);
	return json({ data: { events: resolvePushEventPrefs(settings?.pushEvents) } });
};
