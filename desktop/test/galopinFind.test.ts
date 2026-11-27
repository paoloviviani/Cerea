import { chmodSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findGalopin, Galopin, galopinEnv } from "../src/main/galopin.ts";

describe("which galopin runs", () => {
	const dir = mkdtempSync(join(tmpdir(), "gal-"));
	const env = join(dir, "other-galopin");
	writeFileSync(env, "x");
	const res = join(dir, "res");
	mkdirSync(join(res, "galopin"), { recursive: true });
	writeFileSync(join(res, "galopin", "galopin"), "x");

	it("takes GALOPIN_BIN only in a development run", () => {
		expect(findGalopin({ devRoot: dir, env: { GALOPIN_BIN: env }, packaged: false })).toBe(env);
		expect(
			findGalopin({ resources: res, devRoot: dir, env: { GALOPIN_BIN: env }, packaged: true })
		).toBe(join(res, "galopin", "galopin"));
		expect(
			findGalopin({ devRoot: dir, env: { GALOPIN_BIN: env }, packaged: true })
		).toBeUndefined();
	});

	it("sees an installed service and waits for a stopped galopin", async () => {
		const home = mkdtempSync(join(tmpdir(), "home-"));
		const g = new Galopin(undefined, () => {}, { HOME: home });
		expect(g.serviceInstalled(home, "")).toBe(false);
		mkdirSync(join(home, ".config", "systemd", "user"), { recursive: true });
		writeFileSync(join(home, ".config", "systemd", "user", "galopin.service"), "");
		expect(g.serviceInstalled(home, "")).toBe(true);
		await expect(g.stop()).resolves.toBeUndefined();
		// XDG_CONFIG_HOME moves the unit
		const xdg = mkdtempSync(join(tmpdir(), "xdg-"));
		const h2 = mkdtempSync(join(tmpdir(), "home2-"));
		expect(g.serviceInstalled(h2, xdg)).toBe(false);
		mkdirSync(join(xdg, "systemd", "user"), { recursive: true });
		writeFileSync(join(xdg, "systemd", "user", "galopin.service"), "");
		expect(g.serviceInstalled(h2, xdg)).toBe(true);
	});

	it("marks every galopin it runs as the desktop app's (CEREA_DESKTOP_APP=1)", async () => {
		const env = galopinEnv({ PATH: "/usr/bin:/bin", HOME: "/h" }, "/shims");
		expect(env).toMatchObject({
			CEREA_DESKTOP_APP: "1",
			GALOPIN_INSTALL_DIR: "/shims",
			HOME: "/h",
		});
		// A fake galopin that prints what galopin's detectUpgrade reads.
		const bin = join(dir, "fake-galopin");
		writeFileSync(bin, '#!/bin/sh\necho "desktop=$CEREA_DESKTOP_APP"\n');
		chmodSync(bin, 0o755);
		const g = new Galopin(bin, () => {}, env);
		const res = await g.exec(["version"], { quiet: true });
		expect(res.output.trim()).toBe("desktop=1");
	});
});
