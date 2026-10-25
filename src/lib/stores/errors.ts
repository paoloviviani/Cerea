import { writable } from "svelte/store";

export const ERROR_MESSAGES = {
	default: "Something went wrong. Try again.",
	authOnly: "Please sign in first.",
	rateLimited: "You are sending messages too fast. Try again in a moment.",
};

export const error = writable<string | undefined>(undefined);
