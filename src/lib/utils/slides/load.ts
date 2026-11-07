/**
 * Lazy entry point for the slides renderer: reveal.js is only fetched when a
 * deck is shown. The code highlighter is the app's own (also lazy).
 */
import type { OrgSlideDefaults } from "./themes";

export interface LoadSlidesOptions {
	org?: OrgSlideDefaults;
	resolveLogo?: (name: string) => Promise<string | undefined>;
}

export async function loadSlidesSrcdoc(
	content: string,
	channel: string,
	{ org, resolveLogo }: LoadSlidesOptions = {}
): Promise<string> {
	const [srcdoc, deck, marked] = await Promise.all([
		import("./srcdoc"),
		import("./deck"),
		import("$lib/utils/marked").catch(() => undefined),
	]);
	const parsed = deck.parseDeck(content);
	let logoDataUrl: string | undefined;
	const logo = parsed.meta.logo;
	if (logo && !logo.startsWith("data:") && resolveLogo) {
		logoDataUrl = await resolveLogo(logo).catch(() => undefined);
	}
	return srcdoc.buildSlidesSrcdocFrom(parsed, channel, {
		org,
		logoDataUrl,
		highlight: marked?.highlightCode,
	});
}
