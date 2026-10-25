import { m } from "$lib/paraglide/messages";
import { writable } from "svelte/store";

// Getters, so the words are looked up in the language of the moment they are
// used (the server answers in the caller's language, a page after a switch).
export const ERROR_MESSAGES = {
	get default() {
		return m["app.errors.default"]();
	},
	get authOnly() {
		return m["app.errors.auth_only"]();
	},
	get rateLimited() {
		return m["app.errors.rate_limited"]();
	},
};

export const error = writable<string | undefined>(undefined);
