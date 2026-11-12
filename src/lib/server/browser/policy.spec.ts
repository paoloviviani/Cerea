import { describe, expect, it } from "vitest";
import type { Classification } from "./classifier";
import { ceilingOf, decide } from "./policy";
import { hostMatches, hostOf, isPublicSuffix, matchesAny, parseSiteList } from "./siteRules";

const none = { allow: [], deny: [] };
const read: Classification = { class: "read" };
const input: Classification = { class: "input" };
const commit: Classification = { class: "commit", reason: "submit" };
const leave: Classification = { class: "commit", reason: "new-domain", targetHost: "other.test" };

describe("decide (the Plan, Ask, Allow ceiling)", () => {
	it("allows reads and inputs, and asks about a commit, under Ask", () => {
		const run = (c: Classification) =>
			decide({ classification: c, currentHost: "shop.example.com", rules: none, ceiling: "ask" });
		expect(run(read).verdict).toBe("allow");
		expect(run(input).verdict).toBe("allow");
		expect(run(commit).verdict).toBe("ask");
	});

	it("still asks about a commit under Allow", () => {
		expect(
			decide({ classification: commit, currentHost: "a.test", rules: none, ceiling: "allow" })
				.verdict
		).toBe("ask");
	});

	it("lets Plan read and nothing else", () => {
		const run = (c: Classification) =>
			decide({ classification: c, currentHost: "a.test", rules: none, ceiling: "plan" });
		expect(run(read).verdict).toBe("allow");
		expect(run(input).verdict).toBe("deny");
		expect(run(commit).verdict).toBe("deny");
	});

	it("maps the chat's approval policy onto a ceiling", () => {
		expect(ceilingOf("manual")).toBe("ask");
		expect(ceilingOf("always-allow")).toBe("allow");
		expect(ceilingOf(undefined)).toBe("ask");
	});

	it("refuses everything on a denied site, even a read, and a move to one", () => {
		const rules = { allow: [], deny: ["bank.example.com"] };
		expect(
			decide({ classification: read, currentHost: "bank.example.com", rules, ceiling: "allow" })
				.verdict
		).toBe("deny");
		expect(
			decide({
				classification: { class: "commit", reason: "new-domain", targetHost: "bank.example.com" },
				currentHost: "a.test",
				rules,
				ceiling: "allow",
			}).verdict
		).toBe("deny");
	});

	it("lets a commit through on an allow-listed site, marking why", () => {
		const rules = { allow: ["shop.example.com"], deny: [] };
		const decision = decide({
			classification: commit,
			currentHost: "shop.example.com",
			rules,
			ceiling: "ask",
		});
		expect(decision).toMatchObject({ verdict: "allow", viaSiteRule: true });
	});

	it("does not let an allowed site cover a commit that leaves it for an unlisted one", () => {
		const rules = { allow: ["shop.example.com"], deny: [] };
		expect(
			decide({ classification: leave, currentHost: "shop.example.com", rules, ceiling: "ask" })
				.verdict
		).toBe("ask");
	});

	it("wins for the deny list over the allow list", () => {
		const rules = { allow: ["example.com"], deny: ["shop.example.com"] };
		expect(
			decide({ classification: commit, currentHost: "shop.example.com", rules, ceiling: "ask" })
				.verdict
		).toBe("deny");
	});

	it("refuses a commit nobody can be asked about, unless the site is allowed", () => {
		expect(
			decide({
				classification: commit,
				currentHost: "a.test",
				rules: none,
				ceiling: "allow",
				unattended: true,
			}).verdict
		).toBe("deny");
		expect(
			decide({
				classification: commit,
				currentHost: "a.test",
				rules: { allow: ["a.test"], deny: [] },
				ceiling: "ask",
				unattended: true,
			}).verdict
		).toBe("allow");
	});
});

describe("H2: addresses that are not web pages", () => {
	const badUrl: Classification = { class: "commit", reason: "bad-url" };
	it("are denied, never asked, under every ceiling", () => {
		for (const ceiling of ["plan", "ask", "allow"] as const) {
			const d = decide({ classification: badUrl, currentHost: "a.test", rules: none, ceiling });
			expect(d.verdict).toBe("deny");
		}
	});
	it("are denied even when the site is on the allow list, and when nobody is there", () => {
		expect(
			decide({
				classification: badUrl,
				currentHost: "a.test",
				rules: { allow: ["a.test"], deny: [] },
				ceiling: "allow",
			}).verdict
		).toBe("deny");
		expect(
			decide({
				classification: badUrl,
				currentHost: "a.test",
				rules: none,
				ceiling: "ask",
				unattended: true,
			}).verdict
		).toBe("deny");
	});
});

describe("M2: hosts are compared in one normal form", () => {
	it("ignores case and a trailing dot on both sides", () => {
		expect(hostOf("https://Bank.Test./login")).toBe("bank.test");
		expect(matchesAny("bank.test.", ["bank.test"])).toBe(true);
		expect(matchesAny("BANK.test", ["bank.test"])).toBe(true);
		expect(parseSiteList("Bank.Test.")).toEqual(["bank.test"]);
	});
	it("denies a site under its dotted spelling", () => {
		expect(
			decide({
				classification: { class: "read" },
				currentHost: hostOf("https://bank.test./"),
				rules: { allow: [], deny: ["bank.test"] },
				ceiling: "ask",
			}).verdict
		).toBe("deny");
	});
});

describe("M3: IP literals and public suffixes", () => {
	it("matches an IP literal only exactly", () => {
		expect(hostMatches("10.0.0.5", "10.0.0.5")).toBe(true);
		expect(hostMatches("10.0.0.5", "0.0.5")).toBe(false);
		expect(hostMatches("10.0.0.50", "10.0.0.5")).toBe(false);
	});
	it("recognises a public suffix", () => {
		for (const suffix of ["com", "co.uk", "github.io", "com.br"]) {
			expect(isPublicSuffix(suffix)).toBe(true);
		}
		for (const site of ["example.com", "shop.example.co.uk", "alice.github.io"]) {
			expect(isPublicSuffix(site)).toBe(false);
		}
	});
});

describe("site lists", () => {
	it("reads hosts, wildcards and pasted URLs, one per line or comma", () => {
		expect(
			parseSiteList("Shop.Example.com\n*.example.org, https://bank.test/login?x=1\n# note\n\n")
		).toEqual(["shop.example.com", "*.example.org", "bank.test"]);
	});
	it("drops duplicates and junk", () => {
		expect(parseSiteList("a.test, a.test, ,")).toEqual(["a.test"]);
	});
	it("matches a bare domain and its subdomains, not lookalikes", () => {
		expect(hostMatches("shop.example.com", "example.com")).toBe(true);
		expect(hostMatches("example.com", "example.com")).toBe(true);
		expect(hostMatches("badexample.com", "example.com")).toBe(false);
		expect(hostMatches("example.com.evil.test", "example.com")).toBe(false);
	});
	it("matches a wildcard only below the domain", () => {
		expect(hostMatches("a.example.com", "*.example.com")).toBe(true);
		expect(hostMatches("example.com", "*.example.com")).toBe(false);
	});
	it("handles a missing host", () => {
		expect(matchesAny(undefined, ["a.test"])).toBe(false);
		expect(hostOf("")).toBeUndefined();
		expect(hostOf("https://A.Test:8080/x")).toBe("a.test");
	});
});
