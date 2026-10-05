/**
 * Whether the web-search switches should be offered as working, from the
 * root layout's data (`webSearchAvailable`, computed per caller on the server:
 * at least one search backend granted). Only an explicit `false` means
 * unavailable, so a page without the field (tests, a failed load) keeps the
 * switch.
 */
export function webSearchUnavailableReason(data: {
	webSearchAvailable?: boolean;
	gatewayIsAdmin?: boolean;
}): string | null {
	if (data.webSearchAvailable !== false) return null;
	return data.gatewayIsAdmin
		? "Web search isn't set up on this deployment. Set it up in Admin → Web search."
		: "Web search isn't set up on this deployment.";
}
