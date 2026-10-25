import { AsyncLocalStorage } from "node:async_hooks";
import {
	getServerAsyncLocalStorage,
	overwriteServerAsyncLocalStorage,
} from "$lib/paraglide/runtime.js";
import type { Locale } from "$lib/paraglide/runtime.js";

/**
 * Run `fn` (a request's whole render) with `locale` as Paraglide's answer.
 *
 * Paraglide's own `paraglideMiddleware` does this too, but it is built around
 * URL-localized routing (redirects, de-localized request URLs) that this app
 * does not use; the locale policy is `$lib/i18n/resolve`, decided in
 * `hooks.server.ts`. What is borrowed is only its mechanism: `getLocale()`
 * reads the store on the server, so every message in the render, however many
 * requests are in flight, answers in that request's language and no other's.
 *
 * The store is created on first use (Paraglide creates it lazily inside its
 * middleware, which is not called here).
 */
export function runWithLocale<T>(locale: Locale, origin: string, fn: () => T): T {
	let store = getServerAsyncLocalStorage();
	if (!store) {
		store = new AsyncLocalStorage();
		overwriteServerAsyncLocalStorage(store);
	}
	return store.run({ locale, origin, messageCalls: new Set<string>() }, fn);
}
