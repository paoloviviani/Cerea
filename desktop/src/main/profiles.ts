/**
 * Server profiles: a work server and a home server, switched with one click. A profile is a
 * server (address, origin, identity provider, icon) with its own web sessions and its own galopin
 * pairing; nothing crosses between profiles. Ids are generated here (12 hex characters), never
 * taken from user text, because they name session partitions and directories.
 *
 * The first profile uses galopin's default configuration directory (so a computer already paired
 * with the CLI, or by the earlier single-server version of this app, keeps that pairing and the
 * shims `galopin setup` made keep working); every later profile has its own directory under the
 * app's data and is addressed with `--creds`. Credentials are never moved between profiles.
 */
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ServerInfo } from "../shared/ipc.ts";
import { safeIcon, safeIdp } from "./config.ts";
import { normalizeAddress } from "./server.ts";

export interface Profile {
	id: string;
	name: string;
	server: ServerInfo;
	/** True for the profile that uses galopin's default configuration directory. */
	defaultGalopin: boolean;
}

export interface Store {
	active: string | null;
	profiles: Profile[];
}

export const MAX_PROFILES = 9;
const ID = /^[a-f0-9]{12}$/;

export const isProfileId = (v: unknown): v is string => typeof v === "string" && ID.test(v);
export const newProfileId = (): string => randomBytes(6).toString("hex");

/** Session partitions of a profile: never shared. */
export const ceraePartition = (id: string) => `persist:cerea-${assertId(id)}`;
export const panelPartition = (id: string) => `persist:panel-${assertId(id)}`;

export function assertId(id: string): string {
	if (!isProfileId(id)) throw new Error("Not a profile id.");
	return id;
}

/** The directory of a profile's own galopin (for any profile that is not the default one). */
export function profileGalopinDir(
	userData: string,
	p: Pick<Profile, "id" | "defaultGalopin">
): string | undefined {
	return p.defaultGalopin ? undefined : join(userData, "profiles", assertId(p.id), "galopin");
}

export function cleanName(v: unknown, fallback: string): string {
	if (typeof v !== "string") return fallback;
	// eslint-disable-next-line no-control-regex
	const t = v
		.replace(/[\u0000-\u001f\u007f]/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 40);
	return t || fallback;
}

function serverOf(s: Partial<ServerInfo> | undefined): ServerInfo | undefined {
	if (!s || typeof s.address !== "string") return undefined;
	try {
		const address = normalizeAddress(s.address);
		const origin = new URL(address).origin;
		return {
			address,
			origin,
			idp: safeIdp(s.idp) ?? origin,
			name: cleanName(s.name, new URL(address).host),
			...(typeof s.icon === "string" && safeIcon(s.icon) ? { icon: s.icon } : {}),
		};
	} catch {
		return undefined;
	}
}

/** Reads the store. The earlier single-server file `{server}` becomes profile 1; stored values are re-checked. */
export function loadStore(userData: string): Store {
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(join(userData, "config.json"), "utf8"));
	} catch {
		return { active: null, profiles: [] };
	}
	const o = raw as { profiles?: unknown; active?: unknown; server?: Partial<ServerInfo> };
	if (Array.isArray(o.profiles)) {
		const profiles: Profile[] = [];
		for (const p of o.profiles.slice(0, MAX_PROFILES)) {
			const q = p as {
				id?: unknown;
				name?: unknown;
				server?: Partial<ServerInfo>;
				defaultGalopin?: unknown;
			};
			const server = serverOf(q.server);
			if (!isProfileId(q.id) || !server || profiles.some((x) => x.id === q.id)) continue;
			profiles.push({
				id: q.id,
				name: cleanName(q.name, server.name),
				server,
				defaultGalopin: q.defaultGalopin === true,
			});
		}
		// At most one profile owns galopin's default directory: the first that says so.
		const owner = profiles.find((p) => p.defaultGalopin);
		for (const p of profiles) p.defaultGalopin = p === owner;
		const active =
			isProfileId(o.active) && profiles.some((p) => p.id === o.active)
				? (o.active as string)
				: (profiles[0]?.id ?? null);
		return { active, profiles };
	}
	const server = serverOf(o.server);
	if (!server) return { active: null, profiles: [] };
	const id = newProfileId();
	return { active: id, profiles: [{ id, name: server.name, server, defaultGalopin: true }] };
}

export function saveStore(userData: string, s: Store): void {
	const file = join(userData, "config.json");
	mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
	writeFileSync(file, JSON.stringify({ version: 2, ...s }, null, 2) + "\n", { mode: 0o600 });
	chmodSync(file, 0o600);
}

export const activeProfile = (s: Store): Profile | undefined =>
	s.profiles.find((p) => p.id === s.active);

/** A new profile for a server the user confirmed. Adding the same address twice is refused. */
export function addProfile(
	s: Store,
	server: ServerInfo,
	name?: string
): { store: Store; profile: Profile } {
	if (s.profiles.length >= MAX_PROFILES) throw new Error(`At most ${MAX_PROFILES} profiles.`);
	if (s.profiles.some((p) => p.server.address === server.address)) {
		throw new Error("That server is already one of your profiles.");
	}
	const profile: Profile = {
		id: newProfileId(),
		name: cleanName(name, server.name),
		server,
		defaultGalopin: s.profiles.length === 0,
	};
	return { store: { active: s.active ?? profile.id, profiles: [...s.profiles, profile] }, profile };
}

export function renameProfile(s: Store, id: string, name: string): Store {
	if (!s.profiles.some((p) => p.id === id)) throw new Error("No such profile.");
	return {
		...s,
		profiles: s.profiles.map((p) => (p.id === id ? { ...p, name: cleanName(name, p.name) } : p)),
	};
}

/**
 * Removing the active profile makes the first of the rest active (or none). Whoever owned galopin's
 * default directory leaves with it; no other profile inherits that pairing.
 */
export function removeProfile(s: Store, id: string): Store {
	const profiles = s.profiles.filter((p) => p.id !== id);
	if (profiles.length === s.profiles.length) throw new Error("No such profile.");
	return { active: s.active === id ? (profiles[0]?.id ?? null) : s.active, profiles };
}

/**
 * What a switch does, in order. Injected so the order is tested: the old galopin is gone before
 * anything of the new profile starts, and the runtime is cut off from the old panel before the
 * new one exists, so no command can reach a page of the profile that was left.
 */
export interface SwitchSteps {
	stopGalopin(): Promise<void>;
	detachRuntime(): void;
	closePanel(): void;
	loadProfile(p: Profile): void;
	startGalopin(p: Profile): void | Promise<void>;
	save(s: Store): void;
}

export async function switchTo(s: Store, id: string, steps: SwitchSteps): Promise<Store> {
	const next = s.profiles.find((p) => p.id === id);
	if (!next) throw new Error("No such profile.");
	if (s.active === id) return s;
	await steps.stopGalopin();
	steps.detachRuntime();
	steps.closePanel();
	const store = { ...s, active: id };
	steps.loadProfile(next);
	steps.save(store);
	await steps.startGalopin(next);
	return store;
}
