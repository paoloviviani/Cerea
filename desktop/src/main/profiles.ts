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
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { ServerInfo } from "../shared/ipc.ts";
import { safeIcon, safeIdp } from "./config.ts";
import { pairingFor, type Creds } from "./pairing.ts";
import { normalizeAddress } from "./server.ts";

export interface Profile {
	id: string;
	name: string;
	server: ServerInfo;
	/** True for the profile that uses galopin's default configuration directory. */
	defaultGalopin: boolean;
	/** The tool panel's width the user dragged to, remembered per profile (whether it is open is not). */
	panelWidth?: number;
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

/**
 * Reads the store. The earlier single-server file `{server}` becomes profile 1 and is **saved at
 * once** (so its generated id is the same at the next start), and the earlier sessions
 * (`persist:cerea`, `persist:cerea-browser`, stored under `Partitions/cerea` and
 * `Partitions/cerea-browser`) are moved to the profile's own, keeping the user signed in; where a
 * directory cannot be moved it is removed rather than left behind. Stored values are re-checked.
 */
export function loadStore(userData: string): Store {
	const { store, migrated } = readStore(userData);
	if (migrated && store.profiles[0]) saveStore(userData, store);
	// At every start, not only after a migration: a crash between the save and the move leaves the
	// earlier directories behind, and they must not stay (nor sign anyone in to the wrong profile).
	if (store.profiles[0]) migratePartitions(userData, store.profiles[0].id);
	return store;
}

/**
 * Moves the earlier app's two session directories to profile `id`'s (done before any session is
 * opened); if that profile's directory already exists, the leftovers are removed instead.
 */
export function migratePartitions(userData: string, id: string): void {
	assertId(id);
	for (const [from, to] of [
		["cerea", `cerea-${id}`],
		["cerea-browser", `panel-${id}`],
	]) {
		const src = join(userData, "Partitions", from);
		const dst = join(userData, "Partitions", to);
		if (!existsSync(src)) continue;
		// The profile's own sessions already exist: what is left is stale, and goes.
		if (existsSync(dst)) {
			rmSync(src, { recursive: true, force: true });
			continue;
		}
		try {
			renameSync(src, dst);
		} catch {
			rmSync(src, { recursive: true, force: true });
		}
	}
}

export function readStore(userData: string): { store: Store; migrated: boolean } {
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(join(userData, "config.json"), "utf8"));
	} catch {
		return { store: { active: null, profiles: [] }, migrated: false };
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
				panelWidth?: unknown;
			};
			const server = serverOf(q.server);
			if (!isProfileId(q.id) || !server || profiles.some((x) => x.id === q.id)) continue;
			profiles.push({
				id: q.id,
				name: cleanName(q.name, server.name),
				server,
				defaultGalopin: q.defaultGalopin === true,
				...(typeof q.panelWidth === "number" && Number.isFinite(q.panelWidth)
					? { panelWidth: Math.min(4000, Math.max(0, Math.round(q.panelWidth))) }
					: {}),
			});
		}
		// At most one profile owns galopin's default directory: the first that says so.
		const owner = profiles.find((p) => p.defaultGalopin);
		for (const p of profiles) p.defaultGalopin = p === owner;
		const active =
			isProfileId(o.active) && profiles.some((p) => p.id === o.active)
				? (o.active as string)
				: (profiles[0]?.id ?? null);
		return { store: { active, profiles }, migrated: false };
	}
	const server = serverOf(o.server);
	if (!server) return { store: { active: null, profiles: [] }, migrated: false };
	const id = newProfileId();
	return {
		store: { active: id, profiles: [{ id, name: server.name, server, defaultGalopin: true }] },
		migrated: true,
	};
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

/** Remembers the tool panel's width for a profile (clamped when used, against the window). */
export function setPanelWidth(s: Store, id: string, width: number): Store {
	return {
		...s,
		profiles: s.profiles.map((p) => (p.id === id ? { ...p, panelWidth: Math.round(width) } : p)),
	};
}

/**
 * A profile that owns galopin's default directory must really own it: when that directory holds a
 * pairing for another server (made by the CLI, or for another profile), the profile gives the
 * default directory up and gets one of its own, so the other pairing is neither used nor overwritten.
 */
export function reconcileDefault(s: Store, defaultCreds: Creds | undefined): Store {
	if (!defaultCreds) return s;
	let changed = false;
	const profiles = s.profiles.map((p) => {
		if (!p.defaultGalopin) return p;
		if (pairingFor(defaultCreds, p.server).state === "ok") return p;
		changed = true;
		return { ...p, defaultGalopin: false };
	});
	return changed ? { ...s, profiles } : s;
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
