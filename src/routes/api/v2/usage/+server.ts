/**
 * The Usage & billing tab's one endpoint: every enabled `UsageProvider`'s
 * report, composed.
 *
 * Empty `sections` rather than 404 when nothing is enabled — a deployment
 * with no usage provider at all is not an error, it is the ordinary shape of
 * "no Pystino here" that `billTo.ts` says this app must stay viable under,
 * and the tab itself is already hidden by `FeatureFlags.usageEnabled` for
 * that case. A provider whose *own* dependency fails after it started (the
 * gateway erroring mid-request) reports that as a section `error`, not as a
 * failed request — see `pystinoProvider.ts`.
 */

import type { RequestHandler } from "@sveltejs/kit";
import { superjsonResponse } from "$lib/server/api/utils/superjsonResponse";
import { requireAuth } from "$lib/server/api/utils/requireAuth";
import { logger } from "$lib/server/logger";
import { usageProviders } from "$lib/server/usage/registry";
import type { UsageContext, UsageReport, UsageSection } from "$lib/server/usage/types";

export const GET: RequestHandler = async ({ locals }) => {
	requireAuth(locals);

	const ctx: UsageContext = { locals };
	const sections: UsageSection[] = [];

	for (const provider of usageProviders) {
		if (provider.isEnabled && !provider.isEnabled(ctx)) continue;
		try {
			const report = await provider.getReport(ctx);
			sections.push(...report.sections);
		} catch (err) {
			// A provider is expected to catch its own failures (see
			// pystinoProvider.ts) and report them as a section `error`; this is
			// the backstop for one that does not, so one broken provider still
			// cannot take the rest of the tab down with it.
			logger.error({ err, provider: provider.id }, "usage provider threw");
			sections.push({
				title: provider.id,
				entries: [],
				error: "Usage is temporarily unavailable.",
			});
		}
	}

	return superjsonResponse({ sections } satisfies UsageReport);
};
