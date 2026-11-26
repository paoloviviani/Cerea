/**
 * Keeps a profile's pairing honest while the app runs. galopin's default directory can change
 * under it (the CLI enrols another server, another profile pairs): before every galopin action the
 * profile is checked again. A profile that held that directory gives it up when the pairing in it
 * is for another server, then gets its own directory, galopin and bridge endpoint; the other
 * pairing is not read, used or written.
 */
import type { Creds, Pairing } from "./pairing.ts";
import { reconcileDefault, type Profile, type Store } from "./profiles.ts";

export interface GuardDeps {
	getStore(): Store;
	setStore(s: Store): void;
	defaultCreds(): Creds | undefined;
	/** Stops the galopin that runs now (it may be using the directory being given up). */
	stopGalopin(): Promise<void>;
	/** A new galopin and a new bridge endpoint for the active profile, in its (new) directory. */
	rebuild(): void;
}

/** Returns true when the profile's directory changed. */
export async function refreshProfile(d: GuardDeps): Promise<boolean> {
	const before = d.getStore();
	const next = reconcileDefault(before, d.defaultCreds());
	if (next === before) return false;
	await d.stopGalopin();
	d.setStore(next);
	d.rebuild();
	return true;
}

/**
 * `galopin setup TOOL --default` writes shims that follow galopin's default directory, so only the
 * profile that owns that directory may change them (the UI shows the switches only there).
 */
export function setupRefusal(s: Store, p: Profile | undefined): string | undefined {
	if (!p) return "Choose a server first.";
	if (p.defaultGalopin) return undefined;
	const owner = s.profiles.find((x) => x.defaultGalopin)?.name;
	return `Coding tools started by default use the pairing of ${owner ?? "galopin's own setup"}, not ${p.name}'s. Switch to that profile to change them.`;
}

/** What a galopin action says when the profile is not paired for its own server. */
export function notPairedMessage(p: Pairing, serverName: string): string | undefined {
	if (p.state === "ok") return undefined;
	if (p.state === "other") {
		return `This computer is paired with ${p.address}, not with ${serverName}. Pair it for this profile first.`;
	}
	return `This computer is not paired with ${serverName}. Pair it first.`;
}
