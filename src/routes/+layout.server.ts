/**
 * The gateway's answer to "is this person an administrator", for the
 * sidebar's Admin link.
 *
 * Asked here, once per navigation, rather than remembered on the chat's own
 * user record: the chat's `user.isAdmin` comes from a HuggingFace
 * organisation claim and means nothing in this deployment — the admin panel's
 * gate is the gateway's answer (`GET /v1/me`, via `callerIdentity`), and the
 * link should open only for the people that same answer admits. Signed-out
 * visitors and sessions the gateway refuses both get `false`, which hides
 * the link and nothing else — the panel's own gate still decides.
 */
import { callerIdentity } from "$lib/server/admin";
import {
	codeAgentsAllowedFor,
	codeFilesEnabled,
	codeSchedulesEnabled,
	apiKeysAllowedFor,
	codeTerminalEnabled,
	localConnectorsAccessFor,
	localConnectorsEnabled,
} from "$lib/server/codeEnabled";
import { schedulesEnabled } from "$lib/server/schedules/limits";
import { isGotenbergEnabled } from "$lib/server/office/gotenberg";
import { resolveWebSearchFor } from "$lib/server/webSearch/config";
import { pseudoLocaleEnabled } from "$lib/server/localeSettings";
import { baseLocale } from "$lib/i18n/resolve";
import type { LayoutServerLoad } from "./$types";

export const load: LayoutServerLoad = async ({ locals }) => {
	const identity = await callerIdentity(locals);
	// Whether web search can work for *this* caller: at least one search
	// backend granted. Cached briefly per token; a gateway that cannot be asked
	// reads as unavailable, so the composer never offers a switch that does
	// nothing. Not asked for visitors without a token.
	const webSearchAvailable = locals.token
		? (await resolveWebSearchFor(locals.token).catch(() => null))?.available === true
		: false;
	// ADR 0096: the sidebar's /code row is per-person, not per-deployment —
	// a person without the capability never sees the switch, and the tab
	// switches below fold with it so nothing offered 404s on first click.
	// The decision awaits the session check itself (a cold cache fetches
	// rather than reads as "not allowed yet"), so a first page load decides
	// from the gateway's fresh answer, not from an empty cache — and a
	// gateway that cannot be asked rides the person's last valid answer for
	// five minutes before it hides the row.
	const codeAllowed = await codeAgentsAllowedFor(locals);
	return {
		// The language this request was rendered in (hooks.server.ts decided it): the
		// browser adopts it before its first render so hydration matches the HTML.
		locale: locals.locale ?? baseLocale,
		// Whether the pseudo-locale may be offered in the language selector.
		pseudoLocaleEnabled: pseudoLocaleEnabled(),
		webSearchAvailable,
		gatewayIsAdmin: identity?.isAdmin === true,
		// Threaded the same way `gatewayIsAdmin` is (see +layout.ts): the
		// sidebar's `/code` row reads it, and the route's guard re-checks it
		// server-side rather than trusting the prop.
		codeAgentsEnabled: codeAllowed,
		// The /code file explorer's deployment switch (the route 404s anyway).
		codeFilesEnabled: codeAllowed && codeFilesEnabled(),
		// The /code terminal's deployment switch (default off, ADR 0090 §6.1);
		// the Terminal tab reads it to hide entirely rather than show vetoed.
		codeTerminalEnabled: codeAllowed && codeTerminalEnabled(),
		// Scheduled actions (the kill switch is `CHAT_SCHEDULES_ENABLED=false`): the
		// sidebar's Schedules row reads it, and the API answers 404 when it is off.
		codeSchedulesEnabled: codeAllowed && codeSchedulesEnabled(),
		// Scheduled chats are for everyone signed in (the same kill switch): the sidebar's
		// Schedules row and a conversation's "Schedule…" read it.
		chatSchedulesEnabled: Boolean(locals.user) && schedulesEnabled(),
		// False only when the gateway says this person may not hold API keys, which a chat schedule runs on.
		chatSchedulesKeysAllowed: locals.user ? await apiKeysAllowedFor(locals) : true,
		// Local MCP connectors (ADR 0102): the workspace's Local connectors tab. A deployment
		// switch of its own, independent of the Agents panel's per-person one.
		localConnectorsEnabled: localConnectorsEnabled(),
		// Per person (Pystino's `local_connectors` capability): null when granted, else why not,
		// so the tab says so instead of showing a how-to that cannot work for them.
		localConnectorsDenied: await localConnectorsAccessFor(locals).then((a) =>
			a === "ok" ? null : a
		),
		// Office files preview as PDF through Gotenberg (the kit's `office` profile); off, a
		// PowerPoint deck previews in the browser and the rest keep today's behaviour.
		officePreviewEnabled: isGotenbergEnabled(),
	};
};
