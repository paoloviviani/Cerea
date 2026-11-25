import { describe, expect, it } from "vitest";
import { CHANNELS, validate, IpcError } from "../src/shared/ipc.ts";

describe("IPC validation", () => {
	it("has a validator for every channel and refuses unknown ones", () => {
		for (const c of CHANNELS) {
			expect(() => validate(c, { bogus: 1 })).toThrow(IpcError);
		}
		expect(() => validate("fs:read" as never, {})).toThrow(IpcError);
	});

	it("takes no argument where none is expected", () => {
		expect(validate("galopin:status", undefined)).toBeUndefined();
		expect(() => validate("galopin:status", { x: 1 })).toThrow(IpcError);
	});

	it("only allows the known tools and refuses flags smuggled in as values", () => {
		expect(validate("galopin:launch", { tool: "claude" })).toEqual({ tool: "claude" });
		expect(() => validate("galopin:launch", { tool: "bash" })).toThrow(IpcError);
		expect(() => validate("galopin:launch", { tool: "claude", dir: "relative" })).toThrow(IpcError);
		expect(() => validate("galopin:launch", { tool: "claude", dir: "/ok", extra: 1 })).toThrow(
			IpcError
		);
		expect(() => validate("galopin:pair", { agent: true, group: "--yes" })).toThrow(IpcError);
		expect(() => validate("galopin:pair", { agent: true, workspaceRoots: ["--x"] })).toThrow(
			IpcError
		);
		expect(() => validate("galopin:pair", { agent: true, workspaceRoots: ["relative"] })).toThrow(
			IpcError
		);
	});

	it("keeps connectors-only pairing free of agent options", () => {
		expect(validate("galopin:pair", { agent: false, flow: "device" })).toEqual({
			agent: false,
			flow: "device",
		});
		expect(() => validate("galopin:pair", { agent: false, noFiles: true })).toThrow(IpcError);
		expect(() => validate("galopin:pair", { agent: true, engine: "emacs" })).toThrow(IpcError);
	});

	it("needs an explicit confirmation to switch servers", () => {
		expect(() => validate("server:switch", { address: "https://x.example" })).toThrow(IpcError);
		expect(() =>
			validate("server:switch", { address: "https://x.example", confirm: false })
		).toThrow(IpcError);
		expect(validate("server:switch", { address: "https://x.example", confirm: true }).confirm).toBe(
			true
		);
	});

	it("checks the browser layout numbers and control modes", () => {
		expect(() =>
			validate("browser:layout", { x: -1, y: 0, width: 1, height: 1, visible: true, sideWidth: 0 })
		).toThrow(IpcError);
		expect(() =>
			validate("browser:layout", { x: NaN, y: 0, width: 1, height: 1, visible: true, sideWidth: 0 })
		).toThrow(IpcError);
		expect(
			validate("browser:layout", {
				x: 1.4,
				y: 0,
				width: 10,
				height: 10,
				visible: false,
				sideWidth: 5,
			}).x
		).toBe(1);
		expect(() => validate("browser:control", { mode: "root" })).toThrow(IpcError);
		expect(validate("browser:control", { mode: "user" }).mode).toBe("user");
	});

	it("rejects NUL bytes and oversized strings", () => {
		expect(() => validate("browser:open", { url: "https://a\0b" })).toThrow(IpcError);
		expect(() => validate("browser:open", { url: "x".repeat(5000) })).toThrow(IpcError);
	});
});
