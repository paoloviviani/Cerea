// Builds galopin from agent/ into resources/galopin/galopin with the flags of its own release build
// (agent/packaging/build-dist.sh): static, trimmed, and its version set to the Cerea version, so the
// computer is not shown as outdated. GOOS and GOARCH pass through for a cross build.
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { cereaVersion } from "./cerea-version.mjs";

const root = join(import.meta.dirname, "..");
const version = cereaVersion();
const res = spawnSync(
	"go",
	[
		"build",
		"-trimpath",
		`-ldflags=-s -w -X main.agentVersion=${version}`,
		"-o",
		join(root, "resources", "galopin", "galopin"),
		".",
	],
	{ cwd: join(root, "..", "agent"), stdio: "inherit", env: { CGO_ENABLED: "0", ...process.env } }
);
if (res.status !== 0) process.exit(res.status ?? 1);
console.log(`built galopin ${version} -> resources/galopin/galopin`);
