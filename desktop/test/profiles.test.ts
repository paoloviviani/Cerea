import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
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
	migratePartitions,
	newProfileId,
	panelPartition,
	profileGalopinDir,
	removeProfile,
	setPanelWidth,
	renameProfile,
	saveStore,
	lacksIdentity,
	withIdentity,
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

	it("saves the migration at once: two loads in a row give the same id, and the second does not write", () => {
		const ud = dir();
		writeFileSync(
			join(ud, "config.json"),
			JSON.stringify({ server: { address: "https://c.example.org/chat", name: "Acme" } })
		);
		const first = loadStore(ud);
		expect(JSON.parse(readFileSync(join(ud, "config.json"), "utf8")).version).toBe(2);
		const mtime = statSync(join(ud, "config.json")).mtimeMs;
		const second = loadStore(ud);
		expect(second.profiles[0].id).toBe(first.profiles[0].id);
		expect(second.active).toBe(first.active);
		expect(statSync(join(ud, "config.json")).mtimeMs).toBe(mtime); // no second save
		expect(loadStore(ud).profiles[0].id).toBe(first.profiles[0].id);
	});

	it("moves the earlier sessions to the profile's own, so the user stays signed in", () => {
		const ud = dir();
		mkdirSync(join(ud, "Partitions", "cerea"), { recursive: true });
		mkdirSync(join(ud, "Partitions", "cerea-browser"), { recursive: true });
		writeFileSync(join(ud, "Partitions", "cerea", "Cookies"), "login");
		writeFileSync(
			join(ud, "config.json"),
			JSON.stringify({ server: { address: "https://c.example.org/chat", name: "Acme" } })
		);
		const id = loadStore(ud).profiles[0].id;
		expect(existsSync(join(ud, "Partitions", "cerea"))).toBe(false);
		expect(existsSync(join(ud, "Partitions", "cerea-browser"))).toBe(false);
		expect(readFileSync(join(ud, "Partitions", `cerea-${id}`, "Cookies"), "utf8")).toBe("login");
		expect(existsSync(join(ud, "Partitions", `panel-${id}`))).toBe(true);
		// a bad id is refused
		expect(() => migratePartitions(ud, "../x")).toThrow();
	});

	it("sweeps leftovers at every start: moved when the profile has none yet, removed when it has", () => {
		const ud = dir();
		const id = newProfileId();
		const server = { address: "https://c.example.org/chat", name: "Acme" };
		// a v2 store, as after the save but before a crash lost the rename
		writeFileSync(
			join(ud, "config.json"),
			JSON.stringify({
				version: 2,
				active: id,
				profiles: [{ id, name: "Acme", server, defaultGalopin: true }],
			})
		);
		mkdirSync(join(ud, "Partitions", "cerea"), { recursive: true });
		writeFileSync(join(ud, "Partitions", "cerea", "Cookies"), "login");
		mkdirSync(join(ud, "Partitions", "cerea-browser"), { recursive: true });
		loadStore(ud);
		expect(existsSync(join(ud, "Partitions", "cerea"))).toBe(false);
		expect(readFileSync(join(ud, "Partitions", `cerea-${id}`, "Cookies"), "utf8")).toBe("login");
		expect(existsSync(join(ud, "Partitions", `panel-${id}`))).toBe(true);
		// the profile's sessions exist now: leftovers that turn up again are stale and removed, never merged in
		mkdirSync(join(ud, "Partitions", "cerea"), { recursive: true });
		writeFileSync(join(ud, "Partitions", "cerea", "Cookies"), "stale");
		loadStore(ud);
		expect(existsSync(join(ud, "Partitions", "cerea"))).toBe(false);
		expect(readFileSync(join(ud, "Partitions", `cerea-${id}`, "Cookies"), "utf8")).toBe("login");
	});

	it("does not touch the earlier sessions when there is nothing to migrate", () => {
		const ud = dir();
		mkdirSync(join(ud, "Partitions", "cerea"), { recursive: true });
		expect(loadStore(ud)).toEqual(empty);
		expect(existsSync(join(ud, "Partitions", "cerea"))).toBe(true);
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

	it("remembers the tool panel's width per profile, and cleans what it reads", () => {
		const ud = dir();
		const a = addProfile(addProfile(empty, srv("work.example.org")).store, srv("home.example.org"));
		let s = setPanelWidth(a.store, a.profile.id, 612.4);
		saveStore(ud, s);
		const back = loadStore(ud);
		expect(back.profiles[0].panelWidth).toBeUndefined(); // the other profile's is its own
		expect(back.profiles[1].panelWidth).toBe(612);
		s = { ...back, profiles: back.profiles.map((p) => ({ ...p, panelWidth: p.panelWidth })) };
		writeFileSync(
			join(ud, "config.json"),
			JSON.stringify({
				version: 2,
				active: back.profiles[0].id,
				profiles: [
					{ ...back.profiles[0], panelWidth: "wide" },
					{ ...back.profiles[1], panelWidth: 999999 },
				],
			})
		);
		const cleaned = loadStore(ud);
		expect(cleaned.profiles[0].panelWidth).toBeUndefined();
		expect(cleaned.profiles[1].panelWidth).toBe(4000);
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
			startGalopin: (p) => void log.push(`start:${p.name}`),
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

describe("profile operations are serialised", () => {
	it("runs two concurrent switches one after the other, each stopping the galopin that is current when it runs", async () => {
		const { Mutex } = await import("../src/main/mutex.ts");
		const ops = new Mutex();
		const first = addProfile(empty, srv("a.example.org"));
		const second = addProfile(first.store, srv("b.example.org"));
		const third = addProfile(second.store, srv("c.example.org"));
		let store = third.store; // active: a
		let running = "a"; // the galopin running now
		const log: string[] = [];
		const steps = (label: string): SwitchSteps => ({
			stopGalopin: async () => {
				log.push(`${label}:stop(${running})`);
				await new Promise((r) => setTimeout(r, 15));
				running = "";
				log.push(`${label}:stopped`);
			},
			detachRuntime: () => log.push(`${label}:detach`),
			closePanel: () => log.push(`${label}:close`),
			loadProfile: () => log.push(`${label}:load`),
			save: () => {},
			startGalopin: (p) => {
				running = p.server.origin.includes("b.") ? "b" : "c";
				log.push(`${label}:start(${running})`);
			},
		});
		const toB = ops.run(async () => (store = await switchTo(store, second.profile.id, steps("1"))));
		const toC = ops.run(async () => (store = await switchTo(store, third.profile.id, steps("2"))));
		await Promise.all([toB, toC]);
		expect(log).toEqual([
			"1:stop(a)",
			"1:stopped",
			"1:detach",
			"1:close",
			"1:load",
			"1:start(b)",
			"2:stop(b)",
			"2:stopped",
			"2:detach",
			"2:close",
			"2:load",
			"2:start(c)",
		]);
		expect(store.active).toBe(third.profile.id);
		expect(running).toBe("c");
	});

	it("keeps going after an operation fails", async () => {
		const { Mutex } = await import("../src/main/mutex.ts");
		const ops = new Mutex();
		const out: string[] = [];
		const bad = ops.run(async () => {
			throw new Error("boom");
		});
		const good = ops.run(async () => out.push("ran"));
		await expect(bad).rejects.toThrow("boom");
		await good;
		expect(out).toEqual(["ran"]);
	});
});

describe("galopin actions go through the same queue as switches", () => {
	it("a start queued during a switch runs after it, on the new profile's galopin", async () => {
		const { Mutex, serialize } = await import("../src/main/mutex.ts");
		const ops = new Mutex();
		let current = "a";
		const log: string[] = [];
		const handlers: Record<string, (arg: never) => unknown> = {
			"galopin:start": async () => void log.push(`start on ${current}`),
			"galopin:pair": async () => void log.push(`pair on ${current}`),
			"galopin:service": async () => void log.push(`service on ${current}`),
			"galopin:browser-setup": async () => void log.push(`browser-setup on ${current}`),
			"galopin:stop": async () => void log.push(`stop on ${current}`),
			"galopin:status": async () => void log.push(`status on ${current}`),
		};
		serialize(ops, handlers, [
			"galopin:start",
			"galopin:pair",
			"galopin:service",
			"galopin:browser-setup",
			"galopin:stop",
		] as const);
		// a switch from a to b that takes a while
		const sw = ops.run(async () => {
			log.push("switch begins");
			await new Promise((r) => setTimeout(r, 30));
			current = "b";
			log.push("switch done");
		});
		const results = [
			handlers["galopin:start"](undefined as never),
			handlers["galopin:pair"](undefined as never),
			handlers["galopin:service"](undefined as never),
			handlers["galopin:browser-setup"](undefined as never),
			handlers["galopin:stop"](undefined as never),
			handlers["galopin:status"](undefined as never), // not serialised: a read
		];
		await Promise.all([sw, ...results]);
		const afterSwitch = log.slice(log.indexOf("switch done") + 1);
		expect(afterSwitch).toEqual([
			"start on b",
			"pair on b",
			"service on b",
			"browser-setup on b",
			"stop on b",
		]);
		expect(log).not.toContain("start on a");
		expect(log).toContain("status on a");
	});
});

describe("the exact issuer and client id of a profile", () => {
	it("are kept through a save and a load, and cleaned", () => {
		const ud = mkdtempSync(join(tmpdir(), "prof-"));
		const a = addProfile(empty, {
			...srv("work.example.org"),
			issuer: "https://login.example.com/t1",
			clientId: "cid-1",
		});
		saveStore(ud, a.store);
		expect(loadStore(ud).profiles[0].server).toMatchObject({
			issuer: "https://login.example.com/t1",
			clientId: "cid-1",
		});
		const f = join(ud, "config.json");
		const raw = JSON.parse(readFileSync(f, "utf8"));
		raw.profiles[0].server.issuer = "javascript:alert(1)";
		raw.profiles[0].server.clientId = "a b; rm -rf";
		writeFileSync(f, JSON.stringify(raw));
		const cleaned = loadStore(ud).profiles[0].server;
		expect(cleaned.issuer).toBeUndefined();
		expect(cleaned.clientId).toBeUndefined();
	});

	it("are added by a re-probe only for the same server", () => {
		const a = addProfile(empty, srv("work.example.org"));
		const p = a.profile;
		expect(lacksIdentity(p)).toBe(true);
		const probed = {
			...srv("work.example.org"),
			issuer: "https://auth.work.example.org/x",
			clientId: "cid",
		};
		const next = withIdentity(a.store, p.id, probed);
		expect(next.profiles[0].server).toMatchObject({
			issuer: "https://auth.work.example.org/x",
			clientId: "cid",
		});
		expect(lacksIdentity(next.profiles[0])).toBe(false);
		// another origin, or another provider, or a probe without them: nothing changes
		expect(withIdentity(a.store, p.id, { ...probed, origin: "https://evil.example" })).toBe(
			a.store
		);
		expect(withIdentity(a.store, p.id, { ...probed, idp: "https://other-idp.example" })).toBe(
			a.store
		);
		expect(withIdentity(a.store, p.id, srv("work.example.org"))).toBe(a.store);
	});
});
