/**
 * The Services report: what every service in this deployment is doing.
 * Administrator only. Answers from a 30-second memory unless `?refresh=1`
 * (the Refresh button).
 */

import { json, type RequestHandler } from "@sveltejs/kit";
import { requireAdmin } from "$lib/server/admin";
import { servicesReport } from "$lib/server/services";

export const GET: RequestHandler = async ({ locals, url }) => {
	await requireAdmin(locals);
	const report = await servicesReport(locals.token, {
		refresh: url.searchParams.get("refresh") === "1",
	});
	return json(report, { headers: { "cache-control": "no-store" } });
};
