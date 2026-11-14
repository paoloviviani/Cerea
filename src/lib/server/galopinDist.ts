/**
 * galopin, the machine agent, served from this deployment itself: the Cerea
 * image builds the four binaries from `agent/` (Dockerfile) into
 * `GALOPIN_DIST_DIR` (default `/app/galopin-dist`), and `{base}/galopin/*`
 * hands them out without a session, so a machine can install with one line
 * and no public repository or release is needed:
 *
 *   curl -fsSL https://<origin><base>/galopin/install.sh | sh
 *
 * Only a fixed set of names is ever served, mapped by string equality, never
 * joined onto the directory from the request: nothing else under the
 * directory, no listing, and no path from the URL reaches the filesystem.
 */
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { config } from "$lib/server/config";
import { GALOPIN_IMAGE, OPENCODE_VERSION } from "$lib/codeEnrollCommand";
import { APP_VERSION } from "$lib/utils/appVersion";
import upgradeFunctions from "./galopinUpgrade.sh?raw";
import installBody from "./galopinInstall.sh?raw";
import { GOOSE_SHA256, GOOSE_VERSION } from "$lib/gooseVersion";
import { OPENCODE_SHA256 } from "$lib/opencodeVersion";

export const GALOPIN_TARGETS = [
	"linux-amd64",
	"linux-arm64",
	"darwin-amd64",
	"darwin-arm64",
] as const;

export const GALOPIN_BINARIES = GALOPIN_TARGETS.map((t) => `galopin-${t}`);

/** Every name `{base}/galopin/<name>` answers for. Anything else is a 404. */
export const GALOPIN_PUBLIC_NAMES = new Set<string>([
	...GALOPIN_BINARIES,
	"SHA256SUMS",
	"version",
	"install.sh",
	"enroll.json",
]);

export function galopinDistDir(): string {
	return config.GALOPIN_DIST_DIR || "/app/galopin-dist";
}

/** `sha256sum` output (`<hex>  <name>` per line) → name → hex. */
export function parseSha256Sums(text: string): Map<string, string> {
	const sums = new Map<string, string>();
	for (const line of text.split("\n")) {
		const match = /^([0-9a-f]{64})\s+\*?(\S+)$/.exec(line.trim());
		if (match) sums.set(match[2], match[1]);
	}
	return sums;
}

/** The origin a machine should talk back to: the public one when set,
 * else the request's, plus the base path. Same rule as the pairing dialog. */
export function galopinOrigin(requestOrigin: string, base: string): string {
	return (config.PUBLIC_ORIGIN || requestOrigin).replace(/\/+$/, "") + base;
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

/**
 * The installer, with this deployment's origin baked in. POSIX sh only: it
 * detects the target, downloads the binary and SHA256SUMS from the same
 * origin it was served from, refuses on a checksum mismatch, installs to
 * `${GALOPIN_INSTALL_DIR:-$HOME/.local/bin}`, and prints the enroll command
 * the pairing dialog shows.
 *
 * With `--engine goose` (or GALOPIN_ENGINE=goose) it also installs the pinned
 * goose release (ADR 0110) from goose's own GitHub release archive, verified
 * against the sha256 recorded in this repo (`gooseVersion.ts`), and the printed
 * enroll command carries `--engine goose`:
 *
 *   curl -fsSL https://<origin><base>/galopin/install.sh | sh -s -- --engine goose
 *
 * With `--with-opencode` (or GALOPIN_WITH_OPENCODE=1) it installs the pinned
 * opencode release (`OPENCODE_VERSION`) from opencode's own GitHub release
 * archive into $HOME/.opencode/bin, verified against the sha256 recorded in
 * this repo (`opencodeVersion.ts`), the same way.
 *
 * With `--upgrade` (or GALOPIN_UPGRADE=1) it upgrades an enrolled galopin in
 * place, keeping enrollment and settings (`galopinUpgrade.sh`): refuses without
 * an enrollment, stops the systemd user unit (or, with --stop, the user's own
 * foreground `galopin run`), backs up galopin's state and opencode's database,
 * installs the new binary (the old one stays as galopin.prev) and the pinned
 * opencode or goose when galopin's own copy differs, refreshes the browser
 * runtime, restarts the unit, and on a failure after the stop prints how to
 * roll back:
 *
 *   curl -fsSL https://<origin><base>/galopin/install.sh | sh -s -- --upgrade
 */
export function renderInstallScript(origin: string, opts: { enrollReady?: boolean } = {}): string {
	// Either the complete enroll command or none: `enroll` asks this Cerea for the issuer, the
	// gateway and the machine client id itself (enroll.json), so `--cerea` is all it needs. When
	// the deployment cannot say (no issuer set), no command is printed, only where to find it.
	const next = opts.enrollReady
		? `printf '\\nNext, pair this machine with %s.\\n\\nA coding agent computer:\\n\\n  galopin enroll --cerea %s%s\\n  galopin run\\n\\n' "$origin" "$origin" "$engineflag"
printf 'A computer that only serves local connectors (no agent):\\n\\n  galopin enroll --connectors-only --cerea %s\\n  galopin run\\n\\n' "$origin"
printf 'Then confirm it: an agent computer in the /code panel, a connectors computer under Workspace, Connectors, On your computers.\\n'`
		: `printf '\\nNext: open %s and follow "Pair a computer" (agents, in /code) or "Use the browser on your computer" / "On your computers" (connectors only, in Workspace, Connectors). Cerea shows the exact command for your account.\\n' "$origin"`;
	const gooseSums = Object.entries(GOOSE_SHA256)
		.map(([name, sum]) => `\t\t${name}) want=${sum} ;;`)
		.join("\n");
	const opencodeSums = Object.entries(OPENCODE_SHA256)
		.map(([name, sum]) => `\t\t${name}) want=${sum} ;;`)
		.join("\n");
	const fill = (text: string, values: Record<string, string>) =>
		text
			.replace(/^[ \t]*#.*\n/gm, "")
			.replace(/@([A-Z_]+)@/g, (all, key: string) => values[key] ?? all)
			.trimEnd();
	const versions = { OPENCODE_VERSION, GOOSE_VERSION };
	const upgradeScript = fill(upgradeFunctions, {
		...versions,
		DOCKER_IMAGE: `${GALOPIN_IMAGE}:${APP_VERSION}`,
	});
	const installFlow = fill(installBody, {
		...versions,
		OPENCODE_SUMS: opencodeSums,
		GOOSE_SUMS: gooseSums,
		NEXT: `if [ -z "$upgrade" ]; then\n${next}\nfi`,
	});
	return `#!/bin/sh
# galopin, the Cerea machine agent: installer served by ${origin}
set -eu

# Everything is inside main, called on the last line: a download cut short does nothing.
main() {
origin=${shellQuote(origin)}
dir="\${GALOPIN_INSTALL_DIR:-$HOME/.local/bin}"
engine="\${GALOPIN_ENGINE:-opencode}"
withopencode="\${GALOPIN_WITH_OPENCODE:-}"
upgrade="\${GALOPIN_UPGRADE:-}"
creds="\${GALOPIN_CREDS:-}"
stopfg=""
dogoose=1
engine_set=""
if [ -n "\${GALOPIN_ENGINE:-}" ]; then engine_set=1; fi
while [ $# -gt 0 ]; do
	case "$1" in
		--engine) [ $# -ge 2 ] || { echo "galopin install: --engine needs opencode or goose" >&2; exit 1; }; engine=$2; engine_set=1; shift 2 ;;
		--with-opencode) withopencode=1; shift ;;
		--engine=*) engine=\${1#--engine=}; engine_set=1; shift ;;
		--upgrade) upgrade=1; shift ;;
		--stop) stopfg=1; shift ;;
		--creds) [ $# -ge 2 ] || { echo "galopin install: --creds needs a file" >&2; exit 1; }; creds=$2; shift 2 ;;
		--creds=*) creds=\${1#--creds=}; shift ;;
		*) echo "galopin install: unknown option $1" >&2; exit 1 ;;
	esac
done
case "$engine" in opencode | goose) ;; *) echo "galopin install: --engine must be opencode or goose" >&2; exit 1 ;; esac

fail() { printf 'galopin install: %s\\n' "$1" >&2; exit 1; }

case "$(uname -s)" in
	Linux) os=linux ;;
	Darwin) os=darwin ;;
	*) fail "unsupported OS $(uname -s): galopin runs on Linux and macOS" ;;
esac
case "$(uname -m)" in
	x86_64 | amd64) arch=amd64 ;;
	aarch64 | arm64) arch=arm64 ;;
	*) fail "unsupported CPU $(uname -m): galopin runs on amd64 and arm64" ;;
esac
name="galopin-$os-$arch"

fetch() {
	if command -v curl >/dev/null 2>&1; then
		curl -fsSL -o "$2" "$1"
	elif command -v wget >/dev/null 2>&1; then
		wget -q -O "$2" "$1"
	else
		fail "needs curl or wget"
	fi
}

sha256() {
	if command -v sha256sum >/dev/null 2>&1; then
		sha256sum "$1" | cut -d ' ' -f 1
	elif command -v shasum >/dev/null 2>&1; then
		shasum -a 256 "$1" | cut -d ' ' -f 1
	else
		fail "needs sha256sum or shasum to verify the download"
	fi
}

tmp=$(mktemp -d)
${upgradeScript}
${installFlow}
}
main "$@"
`;
}

/** The body of `enroll.json`: the three public values `galopin enroll` needs. Nothing else is
 * ever added here; null when the deployment has no issuer to give. */
export function enrollFacts(input: {
	issuer?: string;
	gateway?: string;
	clientId?: string;
	flow?: string;
}): { issuer: string; gateway: string; clientId: string; flow?: "device" | "loopback" } | null {
	const issuer = input.issuer?.trim() ?? "";
	if (!issuer) return null;
	return {
		issuer,
		gateway: input.gateway?.trim() ?? "",
		clientId: input.clientId?.trim() ?? "",
		// Only when the deployment fixes it: `auto` leaves the choice to the machine.
		...(input.flow === "device" || input.flow === "loopback" ? { flow: input.flow } : {}),
	};
}

export type DistResponse = {
	status: number;
	headers: Record<string, string>;
	body: BodyInit | null;
};

const notFound = (message: string): DistResponse => ({
	status: 404,
	headers: { "content-type": "text/plain; charset=utf-8" },
	body: message,
});

/**
 * One public request → a response. `name` is the raw route parameter; it is
 * compared against the allowlist and never used as a path fragment unless it
 * matched exactly.
 */
export async function serveGalopinFile(
	name: string,
	{
		origin,
		ifNoneMatch,
		issuer,
		clientId,
		gateway,
		flow,
	}: {
		origin: string;
		ifNoneMatch?: string | null;
		issuer?: string;
		clientId?: string;
		gateway?: string;
		flow?: string;
	}
): Promise<DistResponse> {
	if (!GALOPIN_PUBLIC_NAMES.has(name)) return notFound("Not found.");

	if (name === "enroll.json") {
		// Public facts only: what `galopin enroll --cerea` would otherwise prompt for. No secret,
		// no session, no per-user value.
		const facts = enrollFacts({ issuer, gateway, clientId, flow });
		if (!facts) return notFound("Not found.");
		return {
			status: 200,
			headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-cache" },
			body: JSON.stringify(facts),
		};
	}

	if (name === "install.sh") {
		return {
			status: 200,
			headers: {
				"content-type": "text/x-shellscript; charset=utf-8",
				"cache-control": "no-cache",
			},
			body: renderInstallScript(origin, { enrollReady: Boolean(issuer?.trim()) }),
		};
	}

	const dir = galopinDistDir();
	let sums: Map<string, string>;
	try {
		sums = parseSha256Sums(await readFile(join(dir, "SHA256SUMS"), "utf8"));
	} catch {
		return notFound("galopin downloads are not available on this deployment.");
	}

	if (name === "SHA256SUMS" || name === "version") {
		const file = name === "SHA256SUMS" ? "SHA256SUMS" : "REVISION";
		try {
			const body = await readFile(join(dir, file), "utf8");
			return {
				status: 200,
				headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-cache" },
				body,
			};
		} catch {
			return notFound("Not found.");
		}
	}

	const sum = sums.get(name);
	if (!sum) return notFound("Not found.");
	const etag = `"${sum}"`;
	// The name is fixed across releases, so a cache must revalidate on every
	// use (a 304 when unchanged): a stale binary against a fresh SHA256SUMS
	// would fail the installer's check after an upgrade.
	const cacheHeaders = { etag, "cache-control": "public, no-cache" };
	if (ifNoneMatch && ifNoneMatch.split(",").some((tag) => tag.trim() === etag)) {
		return { status: 304, headers: cacheHeaders, body: null };
	}
	const path = join(dir, name);
	let size: number;
	try {
		size = (await stat(path)).size;
	} catch {
		return notFound("Not found.");
	}
	return {
		status: 200,
		headers: {
			...cacheHeaders,
			"content-type": "application/octet-stream",
			"content-disposition": `attachment; filename="${name}"`,
			"content-length": String(size),
			"x-content-type-options": "nosniff",
		},
		// node:stream/web's ReadableStream and the DOM global's are one type to the runtime, two to tsc.
		body: Readable.toWeb(createReadStream(path)) as unknown as ReadableStream,
	};
}
