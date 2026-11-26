import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { startBridgeServer } from "../src/main/bridgeServer.ts";
import { Galopin } from "../src/main/galopin.ts";
import { Mutex, serialize } from "../src/main/mutex.ts";
import { readCreds } from "../src/main/pairing.ts";
import { notPairedMessage, refreshProfile, type GuardDeps } from "../src/main/profileGuard.ts";
import {
	addProfile,
	profileGalopinDir,
	reconcileDefault,
	type Store,
} from "../src/main/profiles.ts";

const server = {
	address: "https://cerea.mine.example/chat",
	origin: "https://cerea.mine.example",
	idp: "https://auth.mine.example",
	name: "Mine",
};
const mineCreds = {
	cerea_origin: "https://cerea.mine.example/chat",
	issuer: "https://auth.mine.example",
};
const otherCreds = {
	cerea_origin: "https://chat-dev.other.example/chat",
	issuer: "https://auth.other.example",
};

describe("the pairing is checked again before every galopin action", () => {
	function rig() {
		const root = mkdtempSync(join(tmpdir(), "guard-"));
		const ud = join(root, "ud");
		const defDir = join(root, "default-galopin");
		mkdirSync(defDir, { recursive: true });
		const defCreds = join(defDir, "credentials.json");
		writeFileSync(defCreds, JSON.stringify(mineCreds));
		let store: Store = addProfile({ active: null, profiles: [] }, server).store;
		const profileId = store.profiles[0].id;
		const mkGalopin = () => {
			const p = store.profiles[0];
			const dir = profileGalopinDir(ud, p);
			const creds = dir ? join(dir, "credentials.json") : defCreds;
			return new Galopin(
				undefined,
				() => {},
				{},
				() => {},
				creds,
				{ origin: p.server.origin, idp: p.server.idp }
			);
		};
		let galopin = mkGalopin();
		const registered: string[] = [];
		const deps: GuardDeps = {
			getStore: () => store,
			setStore: (s) => (store = s),
			defaultCreds: () => readCreds(defCreds),
			stopGalopin: () => galopin.stop(),
			rebuild: () => {
				galopin = mkGalopin();
				registered.push(galopin.configDir());
			},
		};
		const ran: string[] = [];
		const handlers: Record<string, (arg: never) => unknown> = {};
		for (const k of [
			"galopin:pair",
			"galopin:start",
			"galopin:service",
			"galopin:signin",
			"galopin:browser-setup",
			"galopin:launch",
			"galopin:setup",
			"galopin:upgrade",
		]) {
			handlers[k] = () => void ran.push(`${k} in ${galopin.configDir()}`);
		}
		const needs = (k: string, arg: unknown) =>
			k !== "galopin:pair" &&
			!(k === "galopin:service" && (arg as { action: string }).action !== "install");
		serialize(new Mutex(), handlers, Object.keys(handlers), async (key, arg) => {
			await refreshProfile(deps);
			if (!needs(String(key), arg)) return;
			const m = notPairedMessage(galopin.pairing(), store.profiles[0].server.name);
			if (m) throw new Error(m);
		});
		return {
			ud,
			defDir,
			defCreds,
			handlers,
			ran,
			registered,
			get galopin() {
				return galopin;
			},
			get store() {
				return store;
			},
			profileId,
		};
	}

	it("lets everything through while the default directory holds this profile's pairing", async () => {
		const r = rig();
		for (const k of Object.keys(r.handlers))
			await r.handlers[k]({ action: "install", show: false } as never);
		expect(r.ran).toHaveLength(8);
		expect(r.store.profiles[0].defaultGalopin).toBe(true);
		expect(r.registered).toEqual([]);
	});

	it("after the default credentials change to another server, nothing uses or overwrites them and the profile moves to its own directory", async () => {
		const r = rig();
		const own = join(r.ud, "profiles", r.profileId, "galopin");
		writeFileSync(r.defCreds, JSON.stringify(otherCreds)); // the CLI enrols another server, mid-session
		const before = readFileSync(r.defCreds, "utf8");
		const arg = { action: "install", show: false } as never;
		for (const k of [
			"galopin:start",
			"galopin:service",
			"galopin:signin",
			"galopin:browser-setup",
			"galopin:launch",
			"galopin:setup",
			"galopin:upgrade",
		]) {
			await expect(r.handlers[k](arg), k).rejects.toThrow(/not paired with Mine\. Pair it first/);
		}
		// removing a service and showing the upgrade need no pairing; pair is allowed and lands in the profile's own directory
		await r.handlers["galopin:service"]({ action: "uninstall" } as never);
		await r.handlers["galopin:pair"](arg);
		expect(r.ran.every((x) => x.endsWith(own))).toBe(true);
		expect(r.ran.some((x) => x.includes(r.defDir))).toBe(false);
		expect(r.store.profiles[0].defaultGalopin).toBe(false);
		expect(r.galopin.credsPath).toBe(join(own, "credentials.json"));
		expect(r.registered).toEqual([own]); // one rebuild, with a new endpoint in the new directory
		expect(readFileSync(r.defCreds, "utf8")).toBe(before); // never overwritten
		expect(existsSync(join(r.defDir, "credentials.json.unpaired-0"))).toBe(false);
	});

	it("names the other server when a profile's own directory holds its pairing", () => {
		const g = new Galopin(
			undefined,
			() => {},
			{},
			() => {},
			join(mkdtempSync(join(tmpdir(), "own-")), "credentials.json"),
			{ origin: server.origin, idp: server.idp }
		);
		expect(notPairedMessage(g.pairing(), "Mine")).toMatch(/not paired with Mine/);
		expect(notPairedMessage({ state: "other", address: "https://x/chat" }, "Mine")).toMatch(
			/paired with https:\/\/x\/chat, not with Mine/
		);
		expect(notPairedMessage({ state: "ok" }, "Mine")).toBeUndefined();
	});
});

describe("an unowned default directory goes to the profile its pairing is for", () => {
	it("hands it over, and not to a profile it is not for", () => {
		let s: Store = addProfile(
			{ active: null, profiles: [] },
			{
				...server,
				address: "https://a.example/chat",
				origin: "https://a.example",
				idp: "https://auth.a.example",
				name: "A",
			}
		).store;
		s = addProfile(s, server).store; // Mine: not the default owner (second)
		s = { ...s, profiles: s.profiles.map((p) => ({ ...p, defaultGalopin: false })) }; // nobody owns it
		const next = reconcileDefault(s, {
			cerea: "https://cerea.mine.example/chat",
			issuer: "https://auth.mine.example",
		});
		expect(next.profiles.map((p) => p.defaultGalopin)).toEqual([false, true]);
		// a pairing for neither server is nobody's
		expect(reconcileDefault(s, { cerea: "https://nobody.example/chat" })).toBe(s);
	});
});

describe("the bridge endpoint of a profile that moves directory", () => {
	it("leaves no cdp-endpoint carrying its secret in the directory it gave up", async () => {
		const root = mkdtempSync(join(tmpdir(), "ep-"));
		const defDir = join(root, "default");
		const ownDir = join(root, "own");
		const s = await startBridgeServer(
			{ connect() {}, disconnect() {} },
			{ runDir: join(root, "run"), uid: process.getuid?.() ?? 0, active: () => "aaaaaaaaaaaa" }
		);
		try {
			const f1 = s.addProfile("aaaaaaaaaaaa", defDir);
			expect(existsSync(f1)).toBe(true);
			const f2 = s.addProfile("aaaaaaaaaaaa", ownDir);
			expect(existsSync(f1)).toBe(false);
			expect(readFileSync(f2, "utf8")).toContain("/cdp/");
		} finally {
			await s.close();
		}
	});
});
