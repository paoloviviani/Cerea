import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findGalopin, Galopin } from "../src/main/galopin.ts";

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
		expect(g.serviceInstalled(home)).toBe(false);
		mkdirSync(join(home, ".config", "systemd", "user"), { recursive: true });
		writeFileSync(join(home, ".config", "systemd", "user", "galopin.service"), "");
		expect(g.serviceInstalled(home)).toBe(true);
		await expect(g.stop()).resolves.toBeUndefined();
	});
});
