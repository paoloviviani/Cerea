/**
 * Which accounts this person may bill, for the settings dropdown.
 *
 * Re-pointed from HuggingFace's `/oauth/userinfo` at the gateway's
 * `GET /v1/billing/groups` (ADR 0061). The **response shape is unchanged** on
 * purpose: `settings/(nav)/application/+page.svelte`, the stored
 * `billingOrganization` and `App.Locals` all keep HuggingFace's vocabulary, so
 * this file is the only one that knows which gateway is on the other end. That
 * is what keeps the application viable against something else.
 *
 * The mapping worth knowing: `preferred_username` carries the group **name**,
 * because that is what gets stored and then sent back as `x-bill-to`. `sub` is
 * the group id, which nothing sends anywhere and is kept only because the
 * shape has the field.
 */

import { error, type RequestHandler } from "@sveltejs/kit";
import { superjsonResponse } from "$lib/server/api/utils/superjsonResponse";
import { config } from "$lib/server/config";
import { collections } from "$lib/server/database";
import { authCondition } from "$lib/server/auth";
import { logger } from "$lib/server/logger";

interface GatewayGroup {
	id: string;
	name: string;
	description?: string | null;
	is_default: boolean;
}

export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) {
		error(401, "Login required");
	}
	if (!locals.token) {
		error(401, "OAuth token not available. Please log out and log back in.");
	}
	if (!config.OPENAI_BASE_URL) {
		error(404, "Not available");
	}

	try {
		const base = config.OPENAI_BASE_URL.replace(/\/$/, "");
		const response = await fetch(`${base}/billing/groups`, {
			headers: { Authorization: `Bearer ${locals.token}` },
		});

		if (!response.ok) {
			// A 404 means the gateway predates ADR 0061, which is not worth a
			// 502: the dropdown simply has nothing to offer and every request
			// bills the default.
			if (response.status === 404) {
				return superjsonResponse({
					userCanPay: false,
					organizations: [],
					currentBillingOrg: undefined,
				});
			}
			logger.error(`Failed to fetch billable groups: ${response.status}`);
			error(502, "Failed to fetch billing information");
		}

		const body = (await response.json()) as { data?: GatewayGroup[] };
		const groups = body.data ?? [];

		// `preferred_username` is the group name — what gets stored and sent back
		// as `x-bill-to`, and what the dropdown shows. `name` carries the
		// description, which the dropdown renders as a tooltip: overloading
		// `name` with the description put "Created by `gateway seed`" on screen
		// where a group name belonged.
		const organizations = groups.map((group) => ({
			sub: group.id,
			name: group.description || group.name,
			preferred_username: group.name,
		}));

		const settings = await collections.settings.findOne(authCondition(locals));
		const stored = settings?.billingOrganization;
		const isStoredValid = !!stored && groups.some((group) => group.name === stored);

		// A stored choice the person can no longer bill is cleared rather than
		// left to fail on their next message: the gateway refuses a group they
		// have left, and a 403 from a chat box explains nothing.
		if (stored && !isStoredValid) {
			logger.info(`Clearing invalid billingOrganization '${stored}' for user ${locals.user._id}`);
			await collections.settings.updateOne(authCondition(locals), {
				$unset: { billingOrganization: "" },
				$set: { updatedAt: new Date() },
			});
		}

		// With no valid stored choice, prefer the gateway's own default and
		// otherwise take the first group — an arbitrary pick, deliberately made
		// here rather than in the gateway.
		//
		// The gateway sets a default only for a user with exactly one group, so
		// somebody in two has none and their first message would be refused with
		// "no billing group is set". An arbitrary choice recorded in a ledger is a
		// billing decision nobody made; the same choice offered in a dropdown is a
		// default they can see and change. So the arbitrariness lives in the
		// interface (ADR 0061).
		const fallback = groups.find((group) => group.is_default)?.name ?? groups[0]?.name;

		return superjsonResponse({
			userCanPay: groups.length > 0,
			organizations,
			currentBillingOrg: isStoredValid ? stored : fallback,
		});
	} catch (err) {
		// Re-throw SvelteKit HttpErrors
		if (err && typeof err === "object" && "status" in err) {
			throw err;
		}
		logger.error(err, "Error fetching billable groups:");
		error(500, "Internal server error");
	}
};
