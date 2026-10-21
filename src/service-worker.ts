/// <reference lib="webworker" />
/**
 * Web Push for the installed app and for browsers. See `$lib/pushWorker` for
 * the decisions; this file only connects them to the worker's events.
 *
 * Deliberately no `fetch` handler and no cache: registering this worker must
 * not change how a page or an asset loads, and the app's own update polling
 * (`kit.version`) stays the way a deploy reaches an open tab.
 */

import {
	notificationOptions,
	parsePayload,
	pickClient,
	safeTarget,
	shouldShow,
} from "$lib/pushWorker";

const sw = self as unknown as ServiceWorkerGlobalScope;

// A new worker takes over at once: it has nothing cached that an old one could
// be holding, and a tap on a notification needs a worker that controls the
// window it wants to reuse.
sw.addEventListener("install", () => void sw.skipWaiting());
sw.addEventListener("activate", (event) => event.waitUntil(sw.clients.claim()));

sw.addEventListener("push", (event) => {
	const payload = parsePayload(event.data?.text());
	// A push we cannot read still has to show something, or the browser shows
	// its own "this site has been updated in the background" notice.
	if (!payload) {
		event.waitUntil(sw.registration.showNotification("Something needs you", {}));
		return;
	}
	event.waitUntil(
		sw.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
			if (!shouldShow(payload, windows)) return;
			return sw.registration.showNotification(payload.title, notificationOptions(payload));
		})
	);
});

sw.addEventListener("notificationclick", (event) => {
	event.notification.close();
	const scopePath = new URL(sw.registration.scope).pathname;
	const target = safeTarget(event.notification.data?.url, sw.location.origin, scopePath);
	event.waitUntil(
		sw.clients.matchAll({ type: "window", includeUncontrolled: true }).then(async (windows) => {
			const client = pickClient(windows);
			if (client) {
				try {
					const navigated = (await client.navigate(target)) ?? client;
					await navigated.focus();
					return;
				} catch {
					// An uncontrolled or cross-origin client refuses navigation: open one.
				}
			}
			await sw.clients.openWindow(target);
		})
	);
});
