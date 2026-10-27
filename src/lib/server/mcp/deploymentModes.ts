/**
 * How the deployment offers its own connectors, and each person's own
 * switches (ADR 0104).
 *
 * The deployment's connectors are the `.env` servers (`MCP_SERVERS`) and the
 * ones an administrator adds (`scope: "deployment"`). Each has a policy:
 *
 * - mode `on` (the default, so a row is only ever stored for something else):
 *   on for everyone, and a person may switch it off in Workspace;
 * - mode `locked`: on for everyone, and nobody may switch it off;
 * - mode `off`: offered to nobody;
 * - `alwaysLoaded`: its tools are loaded from the start of every turn instead
 *   of being a line the assistant loads when it needs them.
 *
 * A person's switches live in `connectorSwitches`, one row each: the
 * connectors they turned off that are on by default (the deployment's in mode
 * `on`, and their own), and the ones they turned on that are off by default
 * (the servers on their machines).
 *
 * The browser decides nothing. It used to send what it had selected, and its
 * stored selection could be weeks stale; now it sends nothing and every path
 * that builds a turn asks the server (`turnConnectors.ts`).
 *
 * Read from Mongo on each use, not cached, so a change takes effect on the
 * next turn without a restart or an invalidation to forget.
 */

import type { ObjectId } from "mongodb";
import { collections } from "$lib/server/database";
import { logger } from "$lib/server/logger";
import type { ConnectorMode } from "$lib/types/McpConnector";
import { CONNECTOR_MODES } from "$lib/types/McpConnector";
import type { McpServerConfig } from "./httpClient";
import { getMcpServers } from "./registry";

export interface ConnectorPolicy {
	mode: ConnectorMode;
	alwaysLoaded: boolean;
}

export const DEFAULT_POLICY: ConnectorPolicy = { mode: "on", alwaysLoaded: false };

export const baseKey = (name: string) => `base:${name}`;
export const connectorKey = (id: string) => `connector:${id}`;
export const isLocalKey = (key: string) => key.startsWith("local:");

export function isConnectorMode(value: unknown): value is ConnectorMode {
	return typeof value === "string" && (CONNECTOR_MODES as readonly string[]).includes(value);
}

/** Every stored policy, by key. A key that is not here is `on`, not always loaded. */
export async function loadPolicies(): Promise<Map<string, ConnectorPolicy>> {
	try {
		const rows = await collections.connectorModes.find({}).toArray();
		return new Map(
			rows
				.filter((r) => isConnectorMode(r.mode))
				.map((r) => [r.key, { mode: r.mode, alwaysLoaded: r.alwaysLoaded === true }])
		);
	} catch (err) {
		// A policy that cannot be read must not turn into "offer nothing" or "lock
		// everything" by accident; the default is the documented one.
		logger.warn({ err: String(err) }, "connector_modes_unreadable");
		return new Map();
	}
}

export function policyIn(policies: Map<string, ConnectorPolicy>, key: string): ConnectorPolicy {
	return policies.get(key) ?? DEFAULT_POLICY;
}

/** Change a connector's mode and/or its always-loaded flag. The default is stored as no row. */
export async function setPolicy(
	key: string,
	change: { mode?: ConnectorMode; alwaysLoaded?: boolean }
): Promise<ConnectorPolicy> {
	const current = policyIn(await loadPolicies(), key);
	const next: ConnectorPolicy = {
		mode: change.mode ?? current.mode,
		alwaysLoaded: change.alwaysLoaded ?? current.alwaysLoaded,
	};
	if (next.mode === DEFAULT_POLICY.mode && next.alwaysLoaded === DEFAULT_POLICY.alwaysLoaded) {
		await collections.connectorModes.deleteOne({ key });
		return next;
	}
	const now = new Date();
	await collections.connectorModes.updateOne(
		{ key },
		{
			$set: { mode: next.mode, alwaysLoaded: next.alwaysLoaded, updatedAt: now },
			$setOnInsert: { createdAt: now },
		},
		{ upsert: true }
	);
	return next;
}

export async function clearPolicy(key: string): Promise<void> {
	await collections.connectorModes.deleteOne({ key });
}

/** The `.env` servers that are not switched off by the administrator. */
export function callableEnvServers(policies: Map<string, ConnectorPolicy>): McpServerConfig[] {
	return getMcpServers().filter((s) => policyIn(policies, baseKey(s.name)).mode !== "off");
}

// --- a person's own switches ---------------------------------------------------------------

export interface Switches {
	off: Set<string>;
	on: Set<string>;
}

export async function loadSwitches(userId: ObjectId | undefined): Promise<Switches> {
	if (!userId) return { off: new Set(), on: new Set() };
	try {
		const row = await collections.connectorSwitches.findOne({ userId });
		return { off: new Set(row?.off ?? []), on: new Set(row?.on ?? []) };
	} catch (err) {
		logger.warn({ err: String(err) }, "connector_switches_unreadable");
		return { off: new Set(), on: new Set() };
	}
}

/**
 * Whether a connector is on for this person: its deployment mode first (`off`
 * never, `locked` always, whatever they did), then their own switch, then the
 * default: on, except for the servers on their machines.
 */
export function isEnabled(
	key: string,
	policy: ConnectorPolicy | undefined,
	switches: Switches
): boolean {
	if (policy?.mode === "off") return false;
	if (policy?.mode === "locked") return true;
	if (isLocalKey(key)) return switches.on.has(key);
	return !switches.off.has(key);
}

/** Record one switch. A switch equal to the default is stored as no entry at all. */
export async function setSwitch(userId: ObjectId, key: string, enabled: boolean): Promise<void> {
	const defaultOn = !isLocalKey(key);
	const now = new Date();
	// `off` holds a default-on connector turned off; `on` holds a default-off one turned on.
	const [add, remove] =
		enabled === defaultOn
			? [undefined, defaultOn ? "off" : "on"]
			: [defaultOn ? "off" : "on", defaultOn ? "on" : "off"];
	await collections.connectorSwitches.updateOne(
		{ userId },
		{
			$setOnInsert: { createdAt: now },
			$set: { updatedAt: now },
			$pull: { [remove]: key } as never,
		},
		{ upsert: true }
	);
	if (add) {
		await collections.connectorSwitches.updateOne({ userId }, { $addToSet: { [add]: key } });
	}
}
