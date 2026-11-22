/** Whether the browser runs on macOS, where xterm's mouse-tracking bypass is
 * Option+drag rather than Shift+drag. iPadOS/iOS report their own platforms
 * and have no such modifier on a touch screen, so they count as not-Mac. */
export function isMacPlatform(
	nav: Pick<Navigator, "platform" | "userAgent"> & { userAgentData?: { platform?: string } }
): boolean {
	const platform = nav.userAgentData?.platform || nav.platform || "";
	if (/iphone|ipad|ipod/i.test(nav.userAgent)) return false;
	return /^mac/i.test(platform);
}
