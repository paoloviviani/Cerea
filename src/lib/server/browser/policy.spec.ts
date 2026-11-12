import { describe, expect, it } from "vitest";
import type { Classification } from "./classifier";
import { ceilingOf, decide } from "./policy";
import { hostMatches, hostOf, matchesAny, parseSiteList } from "./siteRules";

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
