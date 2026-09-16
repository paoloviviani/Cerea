/**
 * The Usage & billing tab's provider interface.
 *
 * This application must stay viable without Pystino (see `billTo.ts`'s
 * header), so the tab is never a direct call to one gateway — it is a list of
 * providers, each contributing sections to one composed report. The first
 * provider is `pystinoProvider.ts`, reading the caller's quotas and spend off
 * the gateway. A second provider (a future "chat-stats" one, reading this
 * app's own Mongo — turns, tokens, no gateway involved) registers in
 * `registry.ts` beside it, returning stat-only entries (no `limit`) through
 * the exact same shape.
 *
 * `UsageEntry`/`UsageSection`/`UsageReport` themselves live in
 * `$lib/types/UsageReport.ts`, re-exported here, because the tab component
 * that renders them is client-side and cannot import from `$lib/server`.
 */

export type { UsageScope, UsageEntry, UsageSection, UsageReport } from "$lib/types/UsageReport";
import type { UsageReport } from "$lib/types/UsageReport";

export interface UsageContext {
	locals: App.Locals;
}

export interface UsageProvider {
	/** Stable id, used only for logging which provider failed. */
	id: string;
	/**
	 * Whether this provider applies at all for this deployment/request —
	 * gated on its own deployment flag and any dependency it needs (Pystino:
	 * `CHAT_USAGE_ENABLED` and a configured gateway). Omitted means always
	 * enabled, which is the right default for a provider with no external
	 * dependency to gate on.
	 */
	isEnabled?(ctx: UsageContext): boolean;
	getReport(ctx: UsageContext): Promise<UsageReport>;
}
