/**
 * The browser's half of Web Push: can this device do it, subscribe it, forget
 * it. Everything touching `navigator`, `Notification` or `PushManager` is
 * here, so the Settings component stays declarative and tests can stand in
 * for the browser by stubbing these globals.
 */

import { base } from "$app/paths";

export type PushSupport =
	| { ok: true }
	| {
			ok: false;
			reason: "insecure" | "unsupported" | "ios-install" | "denied";
			message: string;
	  };

export interface PushEnv {
	isSecureContext: boolean;
	userAgent: string;
	maxTouchPoints: number;
	standalone: boolean;
	hasServiceWorker: boolean;
	hasPushManager: boolean;
	hasNotification: boolean;
	permission: NotificationPermission | "unsupported";
}

export function readPushEnv(): PushEnv {
	const w = globalThis as unknown as Window & typeof globalThis;
	const nav = w.navigator as Navigator & { standalone?: boolean };
	return {
		isSecureContext: w.isSecureContext === true,
		userAgent: nav?.userAgent ?? "",
		maxTouchPoints: nav?.maxTouchPoints ?? 0,
		standalone:
			nav?.standalone === true ||
			(typeof w.matchMedia === "function" && w.matchMedia("(display-mode: standalone)").matches),
		hasServiceWorker: "serviceWorker" in (nav ?? {}),
		hasPushManager: "PushManager" in w,
		hasNotification: "Notification" in w,
		permission: "Notification" in w ? Notification.permission : "unsupported",
	};
}

/** iPhones, iPads, and iPads that call themselves Macs. */
export function isIos(env: Pick<PushEnv, "userAgent" | "maxTouchPoints">): boolean {
	return (
		/iPhone|iPad|iPod/.test(env.userAgent) ||
		(/Macintosh/.test(env.userAgent) && env.maxTouchPoints > 1)
	);
}

export const IOS_INSTALL_MESSAGE =
	"On an iPhone or iPad, notifications work only once the app is added to the Home Screen " +
	"(iOS 16.4 or later): tap Share, then Add to Home Screen, and open it from there.";

export function pushSupport(env: PushEnv = readPushEnv()): PushSupport {
	if (isIos(env) && !env.standalone) {
		return { ok: false, reason: "ios-install", message: IOS_INSTALL_MESSAGE };
	}
	if (!env.isSecureContext) {
		return {
			ok: false,
			reason: "insecure",
			message: "Notifications need a secure (https) connection.",
		};
	}
	if (!env.hasServiceWorker || !env.hasPushManager || !env.hasNotification) {
		return {
			ok: false,
			reason: "unsupported",
			message: "This browser does not support push notifications.",
		};
	}
	if (env.permission === "denied") {
		return {
			ok: false,
			reason: "denied",
			message:
				"Notifications are blocked for this site in the browser's settings. Allow them there, then come back.",
		};
	}
	return { ok: true };
}

export function urlBase64ToUint8Array(text: string): Uint8Array<ArrayBuffer> {
	const padded = text + "=".repeat((4 - (text.length % 4)) % 4);
	const raw = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
	const out = new Uint8Array(new ArrayBuffer(raw.length));
	for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
	return out;
}

/** The worker is registered by the app itself in a production build; a dev
 * server has none, so register it here when it is missing. */
async function workerRegistration(): Promise<ServiceWorkerRegistration> {
	const existing = await navigator.serviceWorker.getRegistration(`${base}/`);
	if (existing) return navigator.serviceWorker.ready;
	await navigator.serviceWorker.register(`${base}/service-worker.js`, { scope: `${base}/` });
	return navigator.serviceWorker.ready;
}

/** This browser's own push subscription, if it has one. */
export async function currentSubscription(): Promise<PushSubscription | null> {
	if (!pushSupport().ok && readPushEnv().permission !== "denied") return null;
	try {
		const registration = await navigator.serviceWorker.getRegistration(`${base}/`);
		return (await registration?.pushManager.getSubscription()) ?? null;
	} catch {
		return null;
	}
}

export async function fingerprintOf(endpoint: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(endpoint));
	return [...new Uint8Array(digest)]
		.slice(0, 8)
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

export class PushClientError extends Error {}

/**
 * Turn notifications on for this device. The permission prompt appears here,
 * and only here: this is called from a click, never on load.
 */
export async function enableThisDevice(publicKey: string): Promise<void> {
	const support = pushSupport();
	if (!support.ok) throw new PushClientError(support.message);
	const permission = await Notification.requestPermission();
	if (permission !== "granted") {
		throw new PushClientError(
			permission === "denied"
				? "Notifications are blocked for this site in the browser's settings."
				: "Notifications were not allowed."
		);
	}
	const registration = await workerRegistration();
	const subscription =
		(await registration.pushManager.getSubscription()) ??
		(await registration.pushManager.subscribe({
			userVisibleOnly: true,
			applicationServerKey: urlBase64ToUint8Array(publicKey),
		}));
	const json = subscription.toJSON();
	const response = await fetch(`${base}/api/v2/push`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ endpoint: json.endpoint, keys: json.keys }),
	});
	if (!response.ok) {
		await subscription.unsubscribe().catch(() => undefined);
		throw new PushClientError(await errorMessage(response, "Could not turn notifications on."));
	}
}

export async function errorMessage(response: Response, fallback: string): Promise<string> {
	try {
		const body = (await response.json()) as { message?: unknown };
		if (typeof body.message === "string" && body.message) return body.message;
	} catch {
		/* not JSON */
	}
	return fallback;
}
