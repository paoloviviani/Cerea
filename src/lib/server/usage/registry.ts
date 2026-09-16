/**
 * Every `UsageProvider` this deployment may run, composed by
 * `routes/api/v2/usage/+server.ts` into one report.
 *
 * A future chat-stats provider (turns and tokens counted from this app's own
 * Mongo, no gateway) registers here too:
 *
 *   export const usageProviders: UsageProvider[] = [pystinoUsageProvider, chatStatsUsageProvider];
 *
 * It would need no change to `UsageProvider`, `UsageReport` or the endpoint —
 * only its own `getReport` returning stat-only entries (no `limit`).
 */

import type { UsageProvider } from "./types";
import { pystinoUsageProvider } from "./pystinoProvider";

export const usageProviders: UsageProvider[] = [pystinoUsageProvider];
