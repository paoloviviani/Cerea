import { execFileSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	ensureStableGalopin,
	migrateGalopinPaths,
	repointGalopin,
} from "../src/main/stableGalopin.ts";

const sha = (f: string) => createHash("sha256").update(readFileSync(f)).digest("hex");
const bundledReal = join(import.meta.dirname, "..", "resources", "galopin", "galopin");
const haveGalopin = existsSync(bundledReal);

function fakeBundled(content: string) {
	const d = mkdtempSync(join(tmpdir(), "bundled-"));
	const f = join(d, "galopin");
	writeFileSync(f, content, { mode: 0o755 });
	return f;
}

describe("the stable copy of galopin", () => {
	it("is made in a 0700 directory as a 0700 file with the bundled binary's hash", () => {
		const ud = mkdtempSync(join(tmpdir(), "ud-"));
		const bundled = fakeBundled("#!/bin/sh\necho one\n");
		const p = ensureStableGalopin({ bundled, userData: ud });
		expect(p).toBe(join(ud, "bin", "galopin"));
		expect(statSync(join(ud, "bin")).mode & 0o777).toBe(0o700);
		expect(statSync(p).mode & 0o777).toBe(0o700);
		expect(sha(p)).toBe(sha(bundled));
	});

	it("is made again when the app's galopin changes, or when the copy was changed, and not otherwise", () => {
		const ud = mkdtempSync(join(tmpdir(), "ud-"));
		const bundled = fakeBundled("#!/bin/sh\necho one\n");
		const p = ensureStableGalopin({ bundled, userData: ud });
		const inode = statSync(p).ino;
		ensureStableGalopin({ bundled, userData: ud });
		expect(statSync(p).ino).toBe(inode); // untouched
		writeFileSync(bundled, "#!/bin/sh\necho two\n"); // a new app version
		ensureStableGalopin({ bundled, userData: ud });
		expect(sha(p)).toBe(sha(bundled));
		writeFileSync(p, "planted");
		ensureStableGalopin({ bundled, userData: ud });
		expect(sha(p)).toBe(sha(bundled));
		expect(readdirTmp(join(ud, "bin"))).toEqual(["galopin"]); // no temporary file left
	});

	it("refuses a directory that is a link, or open to other users it cannot close", () => {
		const ud = mkdtempSync(join(tmpdir(), "ud-"));
		const elsewhere = mkdtempSync(join(tmpdir(), "elsewhere-"));
		symlinkSync(elsewhere, join(ud, "bin"));
		expect(() => ensureStableGalopin({ bundled: fakeBundled("x"), userData: ud })).toThrow(
			/not a plain directory/
		);
		const ud2 = mkdtempSync(join(tmpdir(), "ud-"));
		expect(() =>
			ensureStableGalopin({
				bundled: fakeBundled("x"),
				userData: ud2,
				uid: (process.getuid?.() ?? 0) + 1,
			})
		).toThrow(/another user/);
		mkdirSync(join(ud2, "bin"), { recursive: true });
		chmodSync(join(ud2, "bin"), 0o777);
		const p = ensureStableGalopin({ bundled: fakeBundled("x"), userData: ud2 }); // ours: tightened
		expect(statSync(join(ud2, "bin")).mode & 0o777).toBe(0o700);
		expect(lstatSync(p).isFile()).toBe(true);
	});
});

function readdirTmp(d: string) {
	return readdirSync(d).sort();
}

describe("re-pointing what an AppImage run wrote", () => {
	const stable = "/home/u/.config/Cerea/bin/galopin";
	const mount = "/tmp/.mount_Cerea4kzQ1x/resources/galopin/galopin";

	it("rewrites a shim and a unit that name a mount path or the resources path, and nothing else", () => {
		const shim = `#!/bin/sh\n# galopin-setup claude\nexec '${mount}' launch claude -- "$@"\n`;
		expect(repointGalopin(shim, stable)).toBe(shim.replace(mount, stable));
		const unit = `[Service]\nExecStart=${mount} run --creds /x/credentials.json\n`;
		expect(repointGalopin(unit, stable)).toBe(unit.replace(mount, stable));
		const res = "/opt/Cerea/resources/galopin/galopin";
		expect(repointGalopin(`ExecStart=${res} run`, stable, res)).toBe(`ExecStart=${stable} run`);
		const plist = `<string>${mount}</string>`;
		expect(repointGalopin(plist, stable)).toBe(`<string>${stable}</string>`);
		// already stable, or someone else's galopin: untouched
		expect(repointGalopin(`ExecStart=${stable} run`, stable)).toBeUndefined();
		expect(repointGalopin(`ExecStart=/usr/local/bin/galopin run`, stable)).toBeUndefined();
		expect(repointGalopin(`exec '/home/u/.local/bin/galopin' launch`, stable, res)).toBeUndefined();
	});

	it("migrates a unit and the shims on disk", () => {
		const home = mkdtempSync(join(tmpdir(), "home-"));
		const install = mkdtempSync(join(tmpdir(), "install-"));
		mkdirSync(join(install, "galopin-shims"), { recursive: true });
		mkdirSync(join(home, ".config", "systemd", "user"), { recursive: true });
		const unit = join(home, ".config", "systemd", "user", "galopin.service");
		writeFileSync(unit, `[Service]\nExecStart=${mount} run\n`);
		writeFileSync(
			join(install, "claude-galopin"),
			`#!/bin/sh\nexec '${mount}' launch claude -- "$@"\n`,
			{ mode: 0o755 }
		);
		writeFileSync(
			join(install, "galopin-shims", "claude"),
			`#!/bin/sh\nexec '${mount}' launch claude -- "$@"\n`,
			{ mode: 0o755 }
		);
		writeFileSync(
			join(install, "galopin-shims", "goose"),
			`#!/bin/sh\nexec '/usr/bin/other' goose\n`
		);
		const changed = migrateGalopinPaths({ stable, installDirs: [install], home });
		expect(changed.sort()).toEqual(
			[unit, join(install, "claude-galopin"), join(install, "galopin-shims", "claude")].sort()
		);
		expect(readFileSync(unit, "utf8")).toContain(`ExecStart=${stable} run`);
		expect(readFileSync(unit, "utf8")).not.toContain(".mount_");
		expect(statSync(join(install, "claude-galopin")).mode & 0o111).not.toBe(0); // still executable
		expect(migrateGalopinPaths({ stable, installDirs: [install], home })).toEqual([]); // nothing left to do
	});
});

describe.skipIf(!haveGalopin)(
	"what the real galopin writes when it runs from the stable copy",
	() => {
		function env() {
			const root = mkdtempSync(join(tmpdir(), "h1-"));
			const home = join(root, "home");
			const ud = join(root, "ud");
			const fake = join(root, "fakebin");
			mkdirSync(home, { recursive: true });
			mkdirSync(fake, { recursive: true });
			for (const n of ["systemctl", "loginctl", "claude"])
				writeFileSync(join(fake, n), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
			const stable = ensureStableGalopin({ bundled: bundledReal, userData: ud });
			const e = {
				HOME: home,
				XDG_CONFIG_HOME: join(home, ".config"),
				PATH: `${fake}:/usr/bin:/bin`,
				GALOPIN_INSTALL_DIR: join(ud, "bin"),
			};
			return { root, home, ud, stable, e };
		}

		it("writes a shim that execs the stable copy", () => {
			const { ud, stable, e } = env();
			execFileSync(stable, ["setup", "claude", "--default"], { env: e });
			for (const f of [
				join(ud, "bin", "claude-galopin"),
				join(ud, "bin", "galopin-shims", "claude"),
			]) {
				const text = readFileSync(f, "utf8");
				expect(text).toContain(`exec '${join(ud, "bin", "galopin")}' launch claude`);
				expect(text).not.toContain(".mount_");
			}
		});

		it("writes a service unit whose ExecStart is the stable copy", () => {
			const { home, ud, stable, e } = env();
			execFileSync(stable, ["service", "install"], { env: e });
			const unit = readFileSync(
				join(home, ".config", "systemd", "user", "galopin.service"),
				"utf8"
			);
			expect(unit).toMatch(
				new RegExp(
					`ExecStart=${join(ud, "bin", "galopin").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} run`
				)
			);
		});

		it("re-points an old unit that ran from an AppImage mount", () => {
			const { home, ud, stable, e } = env();
			execFileSync(stable, ["service", "install"], { env: e });
			const unit = join(home, ".config", "systemd", "user", "galopin.service");
			writeFileSync(
				unit,
				readFileSync(unit, "utf8").replace(stable, "/tmp/.mount_Cereax/resources/galopin/galopin")
			);
			expect(readFileSync(unit, "utf8")).toContain(".mount_");
			migrateGalopinPaths({ stable, installDirs: [join(ud, "bin")], home });
			expect(readFileSync(unit, "utf8")).toContain(`ExecStart=${stable} run`);
		});
	}
);
