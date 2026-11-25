import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	activeProfile,
	addProfile,
	ceraePartition,
	cleanName,
	isProfileId,
	loadStore,
	newProfileId,
	panelPartition,
	profileGalopinDir,
	removeProfile,
	renameProfile,
	saveStore,
	switchTo,
	type Profile,
	type Store,
	type SwitchSteps,
} from "../src/main/profiles.ts";
import type { ServerInfo } from "../src/shared/ipc.ts";

const srv = (host: string, path = ""): ServerInfo => ({
	address: `https://${host}${path}`,
	origin: `https://${host}`,
	idp: `https://auth.${host}`,
	name: host,
});
const empty: Store = { active: null, profiles: [] };

describe("profile ids and partitions", () => {
	it("are generated, and only generated ids name a partition or a directory", () => {
		const id = newProfileId();
		expect(isProfileId(id)).toBe(true);
		expect(ceraePartition(id)).toBe(`persist:cerea-${id}`);
		expect(panelPartition(id)).toBe(`persist:panel-${id}`);
		expect(ceraePartition(id)).not.toBe(panelPartition(id));
		for (const bad of [
			"",
			"../x",
			"work",
			"ABCDEF012345",
			"abcdef01234",
			"abcdef0123456",
			"abc/def/01234",
			"a b",
		]) {
			expect(() => ceraePartition(bad), bad).toThrow();
			expect(() => profileGalopinDir("/ud", { id: bad, defaultGalopin: false }), bad).toThrow();
		}
		expect(newProfileId()).not.toBe(newProfileId());
	});

	it("gives two profiles different partitions and directories, and the first the default galopin directory", () => {
		const a = addProfile(empty, srv("work.example.org"));
		const b = addProfile(a.store, srv("home.example.org"));
		expect(a.profile.defaultGalopin).toBe(true);
		expect(b.profile.defaultGalopin).toBe(false);
		expect(profileGalopinDir("/ud", a.profile)).toBeUndefined();
		expect(profileGalopinDir("/ud", b.profile)).toBe(`/ud/profiles/${b.profile.id}/galopin`);
		expect(ceraePartition(a.profile.id)).not.toBe(ceraePartition(b.profile.id));
		expect(panelPartition(a.profile.id)).not.toBe(panelPartition(b.profile.id));
	});
});

describe("profile CRUD", () => {
	it("adds, renames, removes; the first profile becomes active; a server is added once", () => {
		const a = addProfile(empty, srv("work.example.org"), "  Work\n ");
		expect(a.profile.name).toBe("Work");
		expect(a.store.active).toBe(a.profile.id);
		const b = addProfile(a.store, srv("home.example.org"));
		expect(b.store.active).toBe(a.profile.id); // adding does not switch
		expect(() => addProfile(b.store, srv("home.example.org"))).toThrow(/already/);
		const renamed = renameProfile(b.store, b.profile.id, "Home");
		expect(renamed.profiles[1].name).toBe("Home");
		expect(() => renameProfile(renamed, "nope", "x")).toThrow();
		const removed = removeProfile(renamed, a.profile.id);
		expect(removed.profiles.map((p) => p.name)).toEqual(["Home"]);
		expect(removed.active).toBe(b.profile.id); // the active one left: the next takes over
		expect(removeProfile(removed, b.profile.id)).toEqual({ active: null, profiles: [] });
		expect(() => removeProfile(removed, "nope")).toThrow();
	});

	it("does not give galopin's default directory to a profile when its owner is removed", () => {
		const a = addProfile(empty, srv("work.example.org"));
		const b = addProfile(a.store, srv("home.example.org"));
		const left = removeProfile(b.store, a.profile.id);
		expect(left.profiles[0].defaultGalopin).toBe(false);
	});

	it("caps the number of profiles and cleans names", () => {
		let s = empty;
		for (let i = 0; i < 9; i++) s = addProfile(s, srv(`s${i}.example.org`)).store;
		expect(() => addProfile(s, srv("tenth.example.org"))).toThrow(/At most/);
		expect(cleanName("a\u0000b\u007fc   d", "x")).toBe("a b c d");
		expect(cleanName("", "fallback")).toBe("fallback");
		expect(cleanName("x".repeat(100), "f")).toHaveLength(40);
		expect(cleanName(5, "f")).toBe("f");
	});
});

describe("storage and migration", () => {
	const dir = () => mkdtempSync(join(tmpdir(), "prof-"));

	it("turns the earlier single-server file into profile 1, owning galopin's default directory", () => {
		const ud = dir();
		writeFileSync(
			join(ud, "config.json"),
			JSON.stringify({
				server: {
					address: "https://c.example.org/chat",
					name: "Acme",
					idp: "https://idp.example.org",
				},
			})
		);
		const s = loadStore(ud);
		expect(s.profiles).toHaveLength(1);
		expect(s.profiles[0]).toMatchObject({ name: "Acme", defaultGalopin: true });
		expect(s.profiles[0].server).toMatchObject({
			address: "https://c.example.org/chat",
			origin: "https://c.example.org",
			idp: "https://idp.example.org",
		});
		expect(isProfileId(s.profiles[0].id)).toBe(true);
		expect(s.active).toBe(s.profiles[0].id);
	});

	it("round-trips, with a 0600 file", () => {
		const ud = dir();
		const a = addProfile(addProfile(empty, srv("work.example.org")).store, srv("home.example.org"));
		saveStore(ud, { ...a.store, active: a.profile.id });
		expect(statSync(join(ud, "config.json")).mode & 0o777).toBe(0o600);
		expect(JSON.parse(readFileSync(join(ud, "config.json"), "utf8")).version).toBe(2);
		const back = loadStore(ud);
		expect(back.profiles.map((p) => p.server.address)).toEqual([
			"https://work.example.org",
			"https://home.example.org",
		]);
		expect(back.active).toBe(a.profile.id);
	});

	it("re-checks what it reads: bad ids, duplicates, hostile addresses and a second default owner are dropped", () => {
		const ud = dir();
		const ok = newProfileId();
		const server = { address: "https://ok.example.org", name: "ok" };
		writeFileSync(
			join(ud, "config.json"),
			JSON.stringify({
				version: 2,
				active: "../../etc",
				profiles: [
					{ id: "../../etc", name: "bad id", server },
					{ id: ok, name: "ok", server, defaultGalopin: true },
					{ id: ok, name: "dup", server },
					{
						id: newProfileId(),
						name: "plain http",
						server: { address: "http://evil.example.org" },
					},
					{
						id: newProfileId(),
						name: "second owner",
						server: { address: "https://b.example.org" },
						defaultGalopin: true,
					},
				],
			})
		);
		const s = loadStore(ud);
		expect(s.profiles.map((p) => p.name)).toEqual(["ok", "second owner"]);
		expect(s.profiles.filter((p) => p.defaultGalopin)).toHaveLength(1);
		expect(s.active).toBe(ok);
	});

	it("starts empty for a missing or damaged file", () => {
		const ud = dir();
		expect(loadStore(ud)).toEqual(empty);
		writeFileSync(join(ud, "config.json"), "{not json");
		expect(loadStore(ud)).toEqual(empty);
	});
});

describe("switching", () => {
	function rig() {
		const log: string[] = [];
		let a: Profile, b: Profile, store: Store;
		const first = addProfile(empty, srv("work.example.org"));
		const second = addProfile(first.store, srv("home.example.org"));
		a = first.profile;
		b = second.profile;
		store = second.store;
		const steps: SwitchSteps = {
			stopGalopin: async () => {
				log.push("stop-start");
				await new Promise((r) => setTimeout(r, 20));
				log.push("stop-exited");
			},
			detachRuntime: () => log.push("detach-runtime"),
			closePanel: () => log.push("close-panel"),
			loadProfile: (p) => log.push(`load:${p.name}`),
			startGalopin: (p) => log.push(`start:${p.name}`),
			save: (s) => log.push(`save:${s.active === b.id ? "home" : "work"}`),
		};
		return { log, a, b, store, steps };
	}

	it("stops the old galopin and waits for its exit before anything of the new profile starts", async () => {
		const { log, b, store, steps } = rig();
		const next = await switchTo(store, b.id, steps);
		expect(next.active).toBe(b.id);
		expect(log).toEqual([
			"stop-start",
			"stop-exited",
			"detach-runtime",
			"close-panel",
			"load:home.example.org",
			"save:home",
			"start:home.example.org",
		]);
	});

	it("does nothing when the profile is already active, and refuses an unknown one", async () => {
		const { log, a, store, steps } = rig();
		expect(await switchTo(store, a.id, steps)).toBe(store);
		expect(log).toEqual([]);
		await expect(switchTo(store, "nope", steps)).rejects.toThrow();
		expect(log).toEqual([]);
	});

	it("finds the active profile", () => {
		const { a, store } = rig();
		expect(activeProfile(store)?.id).toBe(a.id);
	});
});
