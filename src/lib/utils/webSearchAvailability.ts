import { m } from "$lib/paraglide/messages";
/**
 * Whether the web-search switches should be offered as working, from the
 * root layout's data (`webSearchAvailable`, computed per caller on the server:
 * at least one search backend granted). Only an explicit `false` means
 * unavailable, so a page without the field (tests, a failed load) keeps the
 * switch. A model that cannot call tools cannot use search either (it is only
 * offered as a function call), so `modelSupportsTools: false` also reads as
 * unavailable, with its own reason.
 */
export function webSearchUnavailableReason(data: {
	webSearchAvailable?: boolean;
	gatewayIsAdmin?: boolean;
	modelSupportsTools?: boolean;
}): string | null {
	if (data.webSearchAvailable === false) {
		return data.gatewayIsAdmin
			? m["app.web_search.unavailable_admin"]()
			: m["app.web_search.unavailable"]();
	}
	if (data.modelSupportsTools === false) return m["app.web_search.needs_tools"]();
	return null;
}
