import { describe, expect, it } from "vitest";
import {
	enrollArgs,
	galopinConfigDir,
	serviceArgs,
	setupArgs,
	terminalCommand,
	upgradeArgs,
} from "../src/main/galopinArgs.ts";

describe("galopin command lines", () => {
	const addr = "https://cerea.example.org/chat";
	it("pairs connectors-only by default, like the Mac connector app", () => {
		expect(enrollArgs(addr, { agent: false })).toEqual([
			"enroll",
			"--cerea",
			addr,
			"--connectors-only",
		]);
		expect(enrollArgs(addr, { agent: false, flow: "device" })).toContain("--device");
	});

	it("maps the Pair dialog's options for a coding-agent computer", () => {
		const a = enrollArgs(addr, {
			agent: true,
			engine: "goose",
			defaultGroup: true,
			noTerminal: true,
			allowFileWrite: true,
			workspaceRoots: ["/work/a"],
		});
		expect(a).toEqual([
			"enroll",
			"--cerea",
			addr,
			"--engine",
			"goose",
			"--default-group",
			"--no-terminal",
			"--allow-file-write",
			"--workspace-root",
			"/work/a",
		]);
		expect(enrollArgs(addr, { agent: true })).not.toContain("--connectors-only");
	});

	it("never passes --yes: galopin's own confirmations stay", () => {
		expect(enrollArgs(addr, { agent: true, defaultGroup: true })).not.toContain("--yes");
	});

	it("builds setup, upgrade and service commands", () => {
		expect(setupArgs("claude", true, false)).toEqual(["setup", "claude", "--remove"]);
		expect(setupArgs("claude", false, true)).toEqual(["setup", "claude", "--default"]);
		expect(upgradeArgs(true)).toEqual(["upgrade", "--show"]);
		expect(upgradeArgs(false)).toEqual(["upgrade", "--yes"]);
		expect(serviceArgs("install")).toEqual(["service", "install"]);
	});

	it("finds galopin's config directory like Go does", () => {
		expect(galopinConfigDir({ HOME: "/h" }, "linux", "/h")).toBe("/h/.config/galopin");
		expect(galopinConfigDir({ HOME: "/h", XDG_CONFIG_HOME: "/x" }, "linux", "/h")).toBe(
			"/x/galopin"
		);
		expect(galopinConfigDir({ HOME: "/h" }, "darwin", "/h")).toBe(
			"/h/Library/Application Support/galopin"
		);
	});

	it("quotes everything handed to a terminal", () => {
		const t = terminalCommand(
			"linux",
			["/opt/g'x/galopin", "launch", "claude"],
			"/my dir/$(x)",
			(b) => b === "xterm"
		)!;
		expect(t.command).toBe("xterm");
		const line = t.args.at(-1)!;
		expect(line).toContain("cd '/my dir/$(x)' && '/opt/g'\\''x/galopin' 'launch' 'claude'");
		expect(terminalCommand("linux", ["g"], "/", () => false)).toBeUndefined();
		const mac = terminalCommand(
			"darwin",
			["/Applications/Cerea.app/galopin", "launch", "claude"],
			"/Users/a b",
			() => true
		)!;
		expect(mac.command).toBe("osascript");
		expect(mac.args.join(" ")).toContain("do script");
	});
});
