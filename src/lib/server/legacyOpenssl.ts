import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { cpuHasAvx } from "./mongoMemoryVersion.ts";

const DEB = "libssl1.1_1.1.1f-1ubuntu2.24_amd64.deb";
const DEB_URL = `https://security.ubuntu.com/ubuntu/pool/main/o/openssl/${DEB}`;
/**
 * The package's SHA-256, as published in Ubuntu's signed focal-security index
 * (dists/focal-security/main/binary-amd64/Packages). The library is loaded into
 * every test worker, so a download that does not match is refused, never used.
 */
const DEB_SHA256 = "7cf39d70a639017d1dd7c8d36daa2258063608688e449fddf40ffdd46f992a78";
const SYSTEM_DIRS = [
	"/usr/lib/x86_64-linux-gnu",
	"/lib/x86_64-linux-gnu",
	"/usr/lib64",
	"/usr/lib",
];

/**
 * mongod 4.4 (the newest build that runs without AVX) links OpenSSL 1.1, which
 * current distributions no longer ship. On a no-AVX machine that lacks it, fetch
 * the library once into the user cache and put it on LD_LIBRARY_PATH, so a plain
 * `npx vitest run` works there without root and without any environment setup.
 * No-op on AVX machines and wherever libssl 1.1 is already installed.
 */
export function ensureLegacyOpenssl(): void {
	if (cpuHasAvx() || process.platform !== "linux") return;
	if (SYSTEM_DIRS.some((d) => existsSync(join(d, "libcrypto.so.1.1")))) return;

	const root = join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "cerea-libssl1.1");
	const lib = join(root, "usr/lib/x86_64-linux-gnu");
	if (!existsSync(join(lib, "libcrypto.so.1.1"))) {
		// Extract into a private directory and rename, so concurrent workers never see half a tree.
		mkdirSync(root, { recursive: true });
		const work = join(root, `.tmp-${process.pid}`);
		mkdirSync(work, { recursive: true });
		try {
			const deb = join(work, DEB);
			const bytes = execFileSync("curl", ["-fsSL", "--max-time", "120", DEB_URL], {
				maxBuffer: 64 << 20,
			});
			const digest = createHash("sha256").update(bytes).digest("hex");
			if (digest !== DEB_SHA256) {
				throw new Error(`${DEB} has sha256 ${digest}, expected ${DEB_SHA256}`);
			}
			writeFileSync(deb, bytes);
			execFileSync("dpkg-deb", ["-x", deb, work]);
			if (!existsSync(join(lib, "libcrypto.so.1.1"))) {
				mkdirSync(join(root, "usr/lib"), { recursive: true });
				try {
					renameSync(join(work, "usr/lib/x86_64-linux-gnu"), lib);
				} catch {
					// another worker won the race; its copy is complete
				}
			}
		} catch (e) {
			throw new Error(
				`This CPU has no AVX, so the in-memory MongoDB must be 4.4, which needs libssl 1.1 (not installed), ` +
					`and fetching it failed: ${(e as Error).message}. Install libssl1.1, or point the tests at a ` +
					`running MongoDB with TEST_MONGODB_URL.`
			);
		} finally {
			try {
				execFileSync("rm", ["-rf", work]);
			} catch {
				/* best effort */
			}
		}
	}
	process.env.LD_LIBRARY_PATH = [lib, process.env.LD_LIBRARY_PATH].filter(Boolean).join(":");
}
