import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	autostartEntry,
	autostartPath,
	execQuote,
	linuxLogin,
	linuxLoginEnabled,
	loginCommand,
} from "../src/main/login.ts";
import { validate, IpcError } from "../src/shared/ipc.ts";

describe("start at login", () => {
	it("writes a valid autostart entry and removes it again", () => {
		const home = mkdtempSync(join(tmpdir(), "login-"));
		const env = { HOME: home };
		expect(linuxLoginEnabled(env, home)).toBe(false);
		linuxLogin(true, { env, execPath: "/opt/Cerea/cerea", home });
		expect(linuxLoginEnabled(env, home)).toBe(true);
		const text = readFileSync(autostartPath(env, home), "utf8");
		expect(text).toContain("[Desktop Entry]");
		expect(text).toContain("Exec=/opt/Cerea/cerea\n");
		linuxLogin(false, { env, execPath: "/opt/Cerea/cerea", home });
		expect(linuxLoginEnabled(env, home)).toBe(false);
	});

	it("starts the AppImage itself, not the extracted binary", () => {
		expect(loginCommand({ APPIMAGE: "/home/a/Cerea.AppImage" }, "/tmp/.mount_x/cerea")).toEqual([
			"/home/a/Cerea.AppImage",
		]);
	});

	it("quotes an Exec line the way the Desktop Entry spec asks", () => {
		expect(execQuote("/opt/My App/cerea")).toBe('"/opt/My App/cerea"');
		expect(execQuote('/a/"b"$c')).toBe('"/a/\\\\"b\\\\"\\\\$c"');
		expect(execQuote("/a\\b")).toBe('"/a\\\\\\\\b"'); // a literal backslash is four in the file
		expect(() => execQuote("/a\nExec=evil")).toThrow(/line break/);
		expect(() => execQuote("/a\rb")).toThrow(/line break/);
		expect(execQuote("/a/100%")).toBe('"/a/100%%"');
		expect(autostartEntry(["/opt/My App/cerea"])).toContain('Exec="/opt/My App/cerea"');
	});

	it("is a plain boolean over IPC", () => {
		expect(validate("app:login", { enabled: true }).enabled).toBe(true);
		expect(() => validate("app:login", { enabled: "yes" })).toThrow(IpcError);
		expect(() => validate("app:login", {})).toThrow(IpcError);
	});
});
