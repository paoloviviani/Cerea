import { describe, expect, it } from "vitest";
import {
	UPGRADE_OLD_HELLO_GRACE_MS,
	UPGRADE_TIMEOUT_MS,
	buildUpgradeCommand,
	galopinNeedsUpgrade,
	galopinUnsupported,
	resolveUpgradeOnHello,
	upgradeInstructions,
	upgradeRunView,
	versionAtLeast,
	type UpgradeRun,
} from "./galopinUpgrade";

describe("galopinNeedsUpgrade", () => {
	it("is true only for a parseable older version", () => {
		expect(galopinNeedsUpgrade("0.1.0", "0.52.2")).toBe(true);
		expect(galopinNeedsUpgrade("0.52.1", "0.52.2")).toBe(true);
		expect(galopinNeedsUpgrade("0.9.0", "0.52.2")).toBe(true);
		expect(galopinNeedsUpgrade("0.52.2", "0.52.2")).toBe(false);
		expect(galopinNeedsUpgrade("0.53.0", "0.52.2")).toBe(false);
		expect(galopinNeedsUpgrade("1.0.0", "0.52.2")).toBe(false);
		expect(galopinNeedsUpgrade(undefined, "0.52.2")).toBe(false);
		expect(galopinNeedsUpgrade("dev", "0.52.2")).toBe(false);
	});
});

describe("buildUpgradeCommand", () => {
	it("is the install line with --upgrade", () => {
		expect(buildUpgradeCommand("https://c.example/chat")).toBe(
			"curl -fsSL 'https://c.example/chat/galopin/install.sh' | sh -s -- --upgrade"
		);
	});
});

describe("galopin changed-since logic", () => {
	it("does not flag a computer when Cerea moved on but galopin did not", () => {
		// Cerea 0.56.0, galopin last changed in 0.55.1: a 0.55.2 computer is current.
		expect(galopinNeedsUpgrade("0.55.2", "0.55.1")).toBe(false);
		expect(galopinNeedsUpgrade("0.55.1", "0.55.1")).toBe(false);
	});
	it("flags a galopin older than the last change", () => {
		expect(galopinNeedsUpgrade("0.55.0", "0.55.1")).toBe(true);
	});
	it("flags below the minimum as unsupported (the strong warning), and only then", () => {
		expect(galopinUnsupported("0.30.0", "0.40.0")).toBe(true);
		expect(galopinUnsupported("0.40.0", "0.40.0")).toBe(false);
		expect(galopinUnsupported("0.45.0", "0.40.0")).toBe(false);
		expect(galopinUnsupported(undefined, "0.40.0")).toBe(false);
	});
});

describe("upgradeInstructions", () => {
	const cap = (inPlace: boolean, reason: string) => ({ inPlace, reason });
	it("offers the button only for an online computer that reported inPlace", () => {
		expect(upgradeInstructions({ online: true, agentUpgrade: cap(true, "systemd") })).toBe(
			"button"
		);
		expect(upgradeInstructions({ online: false, agentUpgrade: cap(true, "systemd") })).toBe("curl");
	});
	it("never offers it in any other case, and says what fits", () => {
		expect(upgradeInstructions({ online: true, agentUpgrade: cap(false, "mac_app") })).toBe(
			"mac_app"
		);
		expect(upgradeInstructions({ online: true, agentUpgrade: cap(false, "docker") })).toBe(
			"docker"
		);
		expect(upgradeInstructions({ online: true, agentContainer: true })).toBe("docker");
		expect(upgradeInstructions({ online: true, agentUpgrade: cap(false, "foreground") })).toBe(
			"foreground"
		);
		expect(upgradeInstructions({ online: true, agentUpgrade: cap(false, "disabled") })).toBe(
			"curl"
		);
		expect(upgradeInstructions({ online: true, agentUpgrade: cap(false, "newthing") })).toBe(
			"curl"
		);
		// an old galopin reports nothing
		expect(upgradeInstructions({ online: true })).toBe("curl");
		expect(upgradeInstructions({ online: true, agentUpgrade: null })).toBe("curl");
	});
});

describe("upgrade run", () => {
	const start = new Date("2026-11-22T10:00:00Z");
	const run = (): UpgradeRun => ({
		startedAt: start,
		fromVersion: "0.60.0",
		targetVersion: "0.61.0",
		state: "running",
	});
	const after = (ms: number) => new Date(start.getTime() + ms);

	it("compares versions", () => {
		expect(versionAtLeast("0.61.0", "0.61.0")).toBe(true);
		expect(versionAtLeast("0.62.1", "0.61.0")).toBe(true);
		expect(versionAtLeast("0.60.9", "0.61.0")).toBe(false);
		expect(versionAtLeast("dev", "0.61.0")).toBe(false);
	});
	it("is done when the computer comes back at or above the target", () => {
		const done = resolveUpgradeOnHello(run(), "0.61.0", after(60_000));
		expect(done.state).toBe("done");
		expect(done.version).toBe("0.61.0");
	});
	it("ignores an old-version hello inside the grace, fails one after it", () => {
		expect(resolveUpgradeOnHello(run(), "0.60.0", after(30_000)).state).toBe("running");
		const failed = resolveUpgradeOnHello(run(), "0.60.0", after(UPGRADE_OLD_HELLO_GRACE_MS));
		expect(failed.state).toBe("failed");
		expect(failed.version).toBe("0.60.0");
	});
	it("leaves a finished run alone", () => {
		const done = { ...run(), state: "done" as const };
		expect(resolveUpgradeOnHello(done, "0.1.0", after(600_000))).toBe(done);
	});
	it("shows a run that did not return in time as failed", () => {
		expect(upgradeRunView(run(), after(UPGRADE_TIMEOUT_MS - 1))?.state).toBe("running");
		expect(upgradeRunView(run(), after(UPGRADE_TIMEOUT_MS))?.state).toBe("failed");
		expect(upgradeRunView(undefined, start)).toBeNull();
	});
});
