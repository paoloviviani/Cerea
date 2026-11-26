import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Galopin } from "../src/main/galopin.ts";
import { pairingFor, readCreds } from "../src/main/pairing.ts";
import { loadStore, profileGalopinDir, reconcileDefault } from "../src/main/profiles.ts";

const mine = { origin: "https://cerea.mine.example", idp: "https://auth.mine.example" };
const creds = (cerea: string, issuer?: string) => ({
	cerea_origin: cerea,
	...(issuer ? { issuer } : {}),
});

describe("which server a pairing belongs to", () => {
	it("is this profile's only when the Cerea address and the sign-in provider both match", () => {
		expect(pairingFor(undefined, mine)).toEqual({ state: "none" });
		expect(
			pairingFor(
				{ cerea: "https://cerea.mine.example/chat", issuer: "https://auth.mine.example/authelia" },
				mine
			)
		).toEqual({ state: "ok" });
		expect(pairingFor({ cerea: "https://cerea.mine.example/chat" }, mine)).toEqual({ state: "ok" }); // no issuer recorded
		expect(
			pairingFor(
				{ cerea: "https://chat-dev.other.example/chat", issuer: "https://auth.mine.example" },
				mine
			)
		).toEqual({
			state: "other",
			address: "https://chat-dev.other.example/chat",
		});
		// same Cerea, another identity provider: not the same pairing
		expect(
			pairingFor(
				{ cerea: "https://cerea.mine.example/chat", issuer: "https://auth.other.example" },
				mine
			).state
		).toBe("other");
		// an older enrolment with no recorded address: this server's only if its sign-in provider is
		expect(pairingFor({ issuer: "https://auth.mine.example/authelia" }, mine)).toEqual({
			state: "ok",
		});
		expect(pairingFor({ issuer: "https://auth.other.example" }, mine).state).toBe("other");
		expect(pairingFor({}, mine).state).toBe("other");
		// a look-alike host
		expect(pairingFor({ cerea: "https://cerea.mine.example.evil.example/chat" }, mine).state).toBe(
			"other"
		);
	});
});

describe("a profile and galopin's default directory", () => {
	const dirs = () => {
		const ud = mkdtempSync(join(tmpdir(), "ud-"));
		const def = mkdtempSync(join(tmpdir(), "galdef-"));
		writeFileSync(
			join(ud, "config.json"),
			JSON.stringify({
				server: { address: "https://cerea.mine.example/chat", name: "Mine", idp: mine.idp },
			})
		);
		return { ud, def };
	};

	it("gives up the default directory when it holds another server's pairing, and leaves that pairing alone", () => {
		const { ud, def } = dirs();
		const file = join(def, "credentials.json");
		writeFileSync(
			file,
			JSON.stringify(creds("https://chat-dev.other.example/chat", "https://auth.other.example"))
		);
		const before = readFileSync(file, "utf8");
		const store = reconcileDefault(loadStore(ud), readCreds(file));
		expect(store.profiles[0].defaultGalopin).toBe(false);
		const own = profileGalopinDir(ud, store.profiles[0])!;
		expect(own).toBe(join(ud, "profiles", store.profiles[0].id, "galopin"));
		expect(readFileSync(file, "utf8")).toBe(before); // untouched
		// the profile, using its own directory, is not paired
		const g = new Galopin(
			undefined,
			() => {},
			{},
			() => {},
			join(own, "credentials.json"),
			mine
		);
		expect(g.pairing()).toEqual({ state: "none" });
		expect(g.paired()).toBe(false);
	});

	it("keeps the default directory when the pairing in it is its own, or when there is none", () => {
		const { ud, def } = dirs();
		const file = join(def, "credentials.json");
		writeFileSync(
			file,
			JSON.stringify(creds("https://cerea.mine.example/chat", "https://auth.mine.example"))
		);
		const store = loadStore(ud);
		expect(reconcileDefault(store, readCreds(file)).profiles[0].defaultGalopin).toBe(true);
		expect(reconcileDefault(store, undefined)).toBe(store);
	});

	it("shows a mismatched pairing as another server's, and refuses to start galopin on it", () => {
		const def = mkdtempSync(join(tmpdir(), "galdef-"));
		const file = join(def, "credentials.json");
		writeFileSync(file, JSON.stringify(creds("https://chat-dev.other.example/chat")));
		const lines: string[] = [];
		const g = new Galopin(
			"/bin/true",
			(l) => lines.push(l),
			{ XDG_CONFIG_HOME: join(def, "..") },
			() => {},
			file,
			mine
		);
		expect(g.pairing()).toEqual({ state: "other", address: "https://chat-dev.other.example/chat" });
		expect(g.paired()).toBe(false);
		g.start();
		expect(g.running).toBe(false);
		expect(lines.join("\n")).toMatch(
			/Not starting galopin: this computer is paired with https:\/\/chat-dev\.other\.example\/chat, not this profile's server/
		);
		// and the pairing is not set aside either: it is not this profile's to touch
		expect(g.unpairLocal()).toBeUndefined();
		expect(existsSync(file)).toBe(true);
	});

	it("treats an unreadable credential file as another server's, never as this one's", () => {
		const def = mkdtempSync(join(tmpdir(), "galdef-"));
		mkdirSync(def, { recursive: true });
		writeFileSync(join(def, "credentials.json"), "{not json");
		const g = new Galopin(
			undefined,
			() => {},
			{},
			() => {},
			join(def, "credentials.json"),
			mine
		);
		expect(g.paired()).toBe(false);
		expect(g.pairing().state).toBe("other");
	});
});
