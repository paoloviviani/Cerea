import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import superjson from "superjson";
import {
	applyCodeStatus,
	codeReauth,
	flagCodeReauth,
	flagCodeSignedOut,
	maybeRedirectSignedOut,
	onCodeReauth,
	resetCodeReauth,
	signOutRedirect,
} from "./codeReauth.svelte";
import { CodeApiError, loadCodeStatus, listDevices, mintTerminalTicket } from "$lib/codeApi";
import { TerminalReauthRequired } from "$lib/codeApi";
import { codeDeviceList, refreshCodeDevices } from "./codeDeviceList.svelte";

/**
 * The shared "your sign-in is too old for /code" flag. The server refuses
 * everything but `/status` while stale; this store is how every part of the
 * panel learns it, from whichever answer arrives first, and how a tab left
 * open learns it with no request at all.
 */
const REAUTH_PATH = "/login?reauth=1&next=/code";

function reauthResponse(): Response {
	return new Response(
		superjson.stringify({ code: "reauth_required", message: "Your sign-in is older than 7 days." }),
		{ status: 401, headers: { "content-type": "application/json" } }
	);
}

function statusResponse(body: Record<string, unknown>): Response {
	return new Response(superjson.stringify(body), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

beforeEach(() => {
	resetCodeReauth();
	codeDeviceList.devices = [];
	codeDeviceList.loading = true;
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	vi.useRealTimers();
	resetCodeReauth();
});

describe("codeReauth store", () => {
	it("starts unasked: neither stale nor checked", () => {
		expect(codeReauth.required).toBe(false);
		expect(codeReauth.checked).toBe(false);
	});

	it("a stale status flags it once, remembers where to sign in, and tells every listener", () => {
		const listener = vi.fn();
		const off = onCodeReauth(listener);
		applyCodeStatus({
			enabled: true,
			fresh: false,
			reauthPath: "/chat/login?reauth=1&next=/chat/code",
		});
		applyCodeStatus({
			enabled: true,
			fresh: false,
			reauthPath: "/chat/login?reauth=1&next=/chat/code",
		});
		expect(codeReauth.required).toBe(true);
		expect(codeReauth.checked).toBe(true);
		expect(codeReauth.reauthPath).toBe("/chat/login?reauth=1&next=/chat/code");
		expect(listener).toHaveBeenCalledTimes(1);
		off();
	});

	it("a fresh status clears it, and a returning sign-in gets the panel back", () => {
		flagCodeReauth();
		expect(codeReauth.required).toBe(true);
		applyCodeStatus({
			enabled: true,
			fresh: true,
			reauthPath: REAUTH_PATH,
			freshUntil: new Date(Date.now() + 3_600_000).toISOString(),
		});
		expect(codeReauth.required).toBe(false);
		expect(codeReauth.checked).toBe(true);
	});

	it("flips when freshUntil passes, with no request at all", async () => {
		vi.useFakeTimers();
		const fetchSpy = vi.fn();
		vi.stubGlobal("fetch", fetchSpy);
		applyCodeStatus({
			enabled: true,
			fresh: true,
			reauthPath: REAUTH_PATH,
			freshUntil: new Date(Date.now() + 5_000).toISOString(),
		});
		expect(codeReauth.required).toBe(false);
		await vi.advanceTimersByTimeAsync(4_900);
		expect(codeReauth.required).toBe(false);
		await vi.advanceTimersByTimeAsync(200);
		expect(codeReauth.required).toBe(true);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("treats a freshUntil already in the past as stale at once", () => {
		applyCodeStatus({
			enabled: true,
			fresh: true,
			reauthPath: REAUTH_PATH,
			freshUntil: new Date(Date.now() - 1).toISOString(),
		});
		expect(codeReauth.required).toBe(true);
	});

	it("a new status replaces the old timer rather than adding one", async () => {
		vi.useFakeTimers();
		applyCodeStatus({
			enabled: true,
			fresh: true,
			reauthPath: REAUTH_PATH,
			freshUntil: new Date(Date.now() + 1_000).toISOString(),
		});
		applyCodeStatus({
			enabled: true,
			fresh: true,
			reauthPath: REAUTH_PATH,
			freshUntil: new Date(Date.now() + 60_000).toISOString(),
		});
		await vi.advanceTimersByTimeAsync(2_000);
		expect(codeReauth.required).toBe(false);
	});
});

describe("codeApi and the flag", () => {
	it("any /code call that answers reauth_required flips the flag and rejects", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => reauthResponse())
		);
		await expect(listDevices()).rejects.toBeInstanceOf(CodeApiError);
		expect(codeReauth.required).toBe(true);
	});

	it("a 401 that is not the reauth shape does not", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("Login required", { status: 401 }))
		);
		await expect(listDevices()).rejects.toBeInstanceOf(CodeApiError);
		expect(codeReauth.required).toBe(false);
	});

	it("a terminal ticket's reauth_required flips it too, and is still the terminal's own error", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => reauthResponse())
		);
		await expect(mintTerminalTicket("d1", "t1")).rejects.toBeInstanceOf(TerminalReauthRequired);
		expect(codeReauth.required).toBe(true);
	});

	it("asks /status once, and folds the answer in", async () => {
		const fetchSpy = vi.fn(async (_input: RequestInfo | URL) =>
			statusResponse({
				enabled: true,
				fresh: false,
				reauthPath: REAUTH_PATH,
			})
		);
		vi.stubGlobal("fetch", fetchSpy);
		await loadCodeStatus(true);
		await loadCodeStatus();
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(String(fetchSpy.mock.calls[0][0])).toContain("/api/v2/code/status");
		expect(codeReauth.required).toBe(true);
	});

	it("proceeds, rather than blocking the panel, when /status cannot be asked", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Promise.reject(new TypeError("offline")))
		);
		await loadCodeStatus(true);
		expect(codeReauth.checked).toBe(true);
		expect(codeReauth.required).toBe(false);
	});
});

describe("signed out is not stale", () => {
	const SIGNIN_PATH = "/login?next=/code";

	beforeEach(() => {
		window.sessionStorage.removeItem("code-signedout-redirect-at");
		vi.restoreAllMocks();
	});

	it("a signed-out status flags signed-out (not stale) and leaves for the plain sign-in", () => {
		const go = vi.spyOn(signOutRedirect, "go").mockImplementation(() => {});
		const listener = vi.fn();
		const off = onCodeReauth(listener);
		applyCodeStatus({
			enabled: true,
			signedIn: false,
			fresh: false,
			reauthPath: REAUTH_PATH,
			signInPath: SIGNIN_PATH,
		});
		expect(codeReauth.required).toBe(true);
		expect(codeReauth.signedOut).toBe(true);
		expect(codeReauth.checked).toBe(true);
		expect(codeReauth.signInPath).toBe(SIGNIN_PATH);
		// The forced path is untouched: nothing here may send reauth=1.
		expect(codeReauth.reauthPath).toBe(REAUTH_PATH);
		expect(listener).toHaveBeenCalledTimes(1);
		expect(go).toHaveBeenCalledTimes(1);
		expect(go).toHaveBeenCalledWith(SIGNIN_PATH);
		off();
	});

	it("a signed-in stale status is still the stale flag, with no redirect", () => {
		const go = vi.spyOn(signOutRedirect, "go").mockImplementation(() => {});
		applyCodeStatus({
			enabled: true,
			signedIn: true,
			fresh: false,
			reauthPath: REAUTH_PATH,
			signInPath: SIGNIN_PATH,
		});
		expect(codeReauth.required).toBe(true);
		expect(codeReauth.signedOut).toBe(false);
		expect(go).not.toHaveBeenCalled();
	});

	it("a status without signedIn (an older server) keeps the old behaviour", () => {
		const go = vi.spyOn(signOutRedirect, "go").mockImplementation(() => {});
		applyCodeStatus({ enabled: true, fresh: false, reauthPath: REAUTH_PATH });
		expect(codeReauth.required).toBe(true);
		expect(codeReauth.signedOut).toBe(false);
		expect(go).not.toHaveBeenCalled();
	});

	it("a fresh status clears a signed-out panel, like a stale one", () => {
		flagCodeSignedOut(SIGNIN_PATH);
		expect(codeReauth.signedOut).toBe(true);
		applyCodeStatus({
			enabled: true,
			signedIn: true,
			fresh: true,
			reauthPath: REAUTH_PATH,
			signInPath: SIGNIN_PATH,
			freshUntil: new Date(Date.now() + 3_600_000).toISOString(),
		});
		expect(codeReauth.required).toBe(false);
		expect(codeReauth.signedOut).toBe(false);
	});

	it("a stale answer after signed-out is stale again, not signed out", () => {
		flagCodeSignedOut(SIGNIN_PATH);
		flagCodeReauth(REAUTH_PATH);
		expect(codeReauth.required).toBe(true);
		expect(codeReauth.signedOut).toBe(false);
	});

	it("does not redirect twice within a minute (a sign-in that is not working)", () => {
		const go = vi.spyOn(signOutRedirect, "go").mockImplementation(() => {});
		applyCodeStatus({
			enabled: true,
			signedIn: false,
			fresh: false,
			reauthPath: REAUTH_PATH,
			signInPath: SIGNIN_PATH,
		});
		expect(go).toHaveBeenCalledTimes(1);
		// The person is back (or never left): the card stays instead.
		applyCodeStatus({
			enabled: true,
			signedIn: false,
			fresh: false,
			reauthPath: REAUTH_PATH,
			signInPath: SIGNIN_PATH,
		});
		expect(go).toHaveBeenCalledTimes(1);
		expect(codeReauth.signedOut).toBe(true);
		expect(maybeRedirectSignedOut(Date.now() + 61_000)).toBe(true);
		expect(go).toHaveBeenCalledTimes(2);
	});

	it("flagCodeSignedOut notifies listeners once and is idempotent", () => {
		const listener = vi.fn();
		const off = onCodeReauth(listener);
		flagCodeSignedOut(SIGNIN_PATH);
		flagCodeSignedOut(SIGNIN_PATH);
		expect(codeReauth.required).toBe(true);
		expect(codeReauth.signedOut).toBe(true);
		expect(listener).toHaveBeenCalledTimes(1);
		off();
	});
});

describe("what the machines told us is dropped", () => {
	it("empties the device list on a stale sign-in, and the poll stops asking", async () => {
		const fetchSpy = vi.fn(async (_input: RequestInfo | URL) =>
			Response.json({ json: { devices: [{ id: "d1", name: "Box" }] } })
		);
		vi.stubGlobal("fetch", fetchSpy);
		codeDeviceList.devices = [{ id: "d1", name: "Box" } as never];
		flagCodeReauth();
		expect(codeDeviceList.devices).toEqual([]);
		expect(codeDeviceList.loading).toBe(false);
		await refreshCodeDevices();
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(codeDeviceList.devices).toEqual([]);
	});

	it("empties the device list on a signed-out status too", () => {
		codeDeviceList.devices = [{ id: "d1", name: "Box" } as never];
		flagCodeSignedOut();
		expect(codeDeviceList.devices).toEqual([]);
		expect(codeDeviceList.loading).toBe(false);
	});
});
