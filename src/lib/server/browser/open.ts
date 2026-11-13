/**
 * "Open browser" (ADR 0116, C109): open a page on one of the user's computers with no task.
 *
 * Used by the composer's menu, a computer's Connectors card and the `browse` tool's `open_only`.
 * With a conversation, the page is tied to it exactly like the page a browse task leaves open:
 * its resume token is kept per device, user and conversation (`kept.ts`), so the next `browse` in
 * that chat continues on it with no `use_tab` approval. Without one, the page is the user's own
 * tab (a `use_tab` approval for the agent, as for any tab they opened).
 *
 * Never while a task holds the machine's browser (one task per machine, `lease.ts`): that is
 * "busy". The address must be http(s); a site on the deny list is refused before and, by the
 * runtime, after redirects.
 */

import { randomUUID } from "node:crypto";
import type { ObjectId } from "mongodb";
import type { BrowseMachine } from "./availability";
import { BrowserRuntimeError, type BrowserRuntime } from "./contract";
import { mongoKeptStore, type KeptStore } from "./kept";
import { mongoLeaseStore, type LeaseStore } from "./lease";
import { rememberConversationDevice, type ChoiceStore } from "./machineChoice";
import { McpBrowserRuntime, mcpRuntimeCall, mcpRuntimeKeepAlive } from "./runtimeClient";
import { browserSettings, type BrowserSettings } from "./settings";
import { hostOf, matchesAny } from "./siteRules";

export type OpenResult =
	| { ok: true; machine: string; title: string; url: string; tied: boolean }
	| {
			ok: false;
			code: "busy" | "denied" | "bad_url" | "runtime";
			status: number;
			message: string;
	  };

export interface OpenDeps {
	leases?: LeaseStore;
	keptStore?: KeptStore;
	choiceStore?: ChoiceStore;
	rules?: BrowserSettings["rules"];
	runtimeFor?: (machine: BrowseMachine) => BrowserRuntime;
	/** Remembers the conversation's computer; default: the conversation's `browserDeviceId`. */
	remember?: (userId: ObjectId, conversationId: string, deviceId: string) => Promise<void>;
}

/** A start address from a user or a model: empty is a blank page, otherwise http(s) only. */
export function parseOpenUrl(raw: unknown): { url?: string } | { error: string } {
	if (raw === undefined || raw === null || raw === "") return {};
	if (typeof raw !== "string") return { error: "The address must be text." };
	const text = raw.trim();
	if (!text) return {};
	// A bare host is what a user types; a scheme that is not http(s) is never added to.
	const candidate = /^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`;
	try {
		const url = new URL(candidate);
		if (url.protocol !== "https:" && url.protocol !== "http:") {
			return { error: "Only http and https addresses can be opened." };
		}
		return { url: url.toString() };
	} catch {
		return { error: "That is not an address that can be opened." };
	}
}

export async function openBrowserPage(options: {
	userId: ObjectId;
	machine: BrowseMachine;
	url?: string;
	conversationId?: string;
	deps?: OpenDeps;
}): Promise<OpenResult> {
	const { userId, machine, conversationId } = options;
	const deps = options.deps ?? {};
	const rules = deps.rules ?? browserSettings().rules;
	if (options.url) {
		const host = hostOf(options.url);
		if (host && matchesAny(host, rules.deny)) {
			return {
				ok: false,
				code: "denied",
				status: 403,
				message: `${host} is on this deployment's list of sites the browser may not use.`,
			};
		}
	}
	const lease = await (deps.leases ?? mongoLeaseStore)
		.acquire(machine.id, userId, `open:${randomUUID()}`)
		.catch(() => null);
	if (!lease) {
		return {
			ok: false,
			code: "busy",
			status: 409,
			message: `The browser on ${machine.name} is busy with a task. Try again when it finishes.`,
		};
	}
	try {
		const runtime =
			deps.runtimeFor?.(machine) ??
			new McpBrowserRuntime(
				mcpRuntimeCall({ userId: userId.toString(), deviceId: machine.id }),
				mcpRuntimeKeepAlive({ userId: userId.toString(), deviceId: machine.id })
			);
		let page;
		try {
			page = await runtime.open({
				...(options.url ? { url: options.url } : {}),
				// Always sent, even empty: the runtime then forgets a list it was given before.
				deny: rules.deny,
			});
		} catch (err) {
			const message =
				err instanceof BrowserRuntimeError && err.kind === "unavailable"
					? `${machine.name} did not answer.`
					: err instanceof Error
						? err.message.replace(/^The browser runtime reported an error in open: /, "")
						: "The browser could not open the page.";
			const old = /unknown tool/i.test(message);
			return {
				ok: false,
				code: "runtime",
				status: 502,
				message: old
					? `The browser on ${machine.name} is too old to open pages: update galopin there and run "galopin browser setup" again.`
					: message,
			};
		}
		if (conversationId) {
			const store = deps.keptStore ?? mongoKeptStore;
			// An explicit "Open browser" moves the chat to this computer: the page kept on any other
			// one is forgotten (one write), so there is one kept page per conversation.
			await store.clearOthers(userId, conversationId, machine.id).catch(() => undefined);
			await store.set(machine.id, userId, conversationId, page);
			await (deps.remember ?? rememberConversationDevice)(userId, conversationId, machine.id);
		}
		return {
			ok: true,
			machine: machine.name,
			title: page.title,
			url: page.url,
			tied: Boolean(conversationId),
		};
	} finally {
		await lease.release();
	}
}
