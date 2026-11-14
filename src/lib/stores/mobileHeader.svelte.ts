import type { Snippet } from "svelte";

/**
 * Header content a page lends to the phone top bar. The agent screen puts its
 * session name, status dot and Panels button here so a phone shows one bar
 * instead of two; MobileNav renders whatever is set in place of the chat
 * title. Only one page owns the slot at a time, and a page clears it only if
 * it is still the owner (a fast route change mounts the next page before the
 * old one is destroyed).
 */
export const mobileHeader = $state<{ content: Snippet | null }>({ content: null });

export function setMobileHeader(content: Snippet): () => void {
	mobileHeader.content = content;
	return () => {
		if (mobileHeader.content === content) mobileHeader.content = null;
	};
}
