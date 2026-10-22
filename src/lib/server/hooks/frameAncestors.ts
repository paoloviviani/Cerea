/**
 * The CSP header that decides who may frame the app. With `ALLOW_IFRAME=true` no header is
 * sent (any site may embed it); otherwise only this origin may, which is what the app's own
 * same-origin embeds need.
 */
export function frameAncestorsPolicy(allowIframe: string | undefined): string | null {
	return allowIframe === "true" ? null : "frame-ancestors 'self';";
}
