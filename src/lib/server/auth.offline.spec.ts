import { afterEach, describe, expect, it } from "vitest";
import { _resetOfflineAccessRefused, loginScopes, markOfflineAccessRefused } from "./auth";

const listed = ["openid", "profile", "email", "groups", "offline_access"];

afterEach(() => _resetOfflineAccessRefused());

describe("loginScopes", () => {
	it("adds offline_access when the issuer lists it, and says so", () => {
		const { scope, offline } = loginScopes(listed);
		expect(offline).toBe(true);
		expect(scope.split(" ")).toContain("offline_access");
	});

	it("never adds a scope the issuer does not list, or says nothing about", () => {
		expect(loginScopes(["openid", "profile"]).offline).toBe(false);
		expect(loginScopes(undefined).offline).toBe(false);
		expect(loginScopes(["openid", "profile"]).scope).not.toContain("offline_access");
	});

	it("skips it for a browser whose background access is settled, and asks again when told to force it", () => {
		expect(loginScopes(listed, "skip").offline).toBe(false);
		expect(loginScopes(listed, "force").offline).toBe(true);
	});

	it("stops asking once this process has seen the issuer refuse it, even when forced", () => {
		markOfflineAccessRefused();
		expect(loginScopes(listed).offline).toBe(false);
		expect(loginScopes(listed, "force").offline).toBe(false);
	});
});

describe("OPENID_OFFLINE_ACCESS=off", () => {
	it("never adds it", async () => {
		const { vi } = await import("vitest");
		vi.resetModules();
		vi.doMock("$lib/server/config", async (original) => {
			const actual = await original<typeof import("$lib/server/config")>();
			return {
				...actual,
				config: new Proxy(actual.config, {
					get(target, prop, receiver) {
						return prop === "OPENID_OFFLINE_ACCESS" ? "off" : Reflect.get(target, prop, receiver);
					},
				}),
			};
		});
		const fresh = await import("./auth");
		expect(fresh.loginScopes(listed, "force")).toEqual({
			scope: expect.not.stringContaining("offline_access"),
			offline: false,
		});
		vi.doUnmock("$lib/server/config");
		vi.resetModules();
	});
});
