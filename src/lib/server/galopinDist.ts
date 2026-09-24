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
 */
export function renderInstallScript(origin: string): string {
	return `#!/bin/sh
# galopin, the Cerea machine agent: installer served by ${origin}
set -eu

origin=${shellQuote(origin)}
dir="\${GALOPIN_INSTALL_DIR:-$HOME/.local/bin}"

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
trap 'rm -rf "$tmp"' EXIT INT TERM

fetch "$origin/galopin/$name" "$tmp/$name" || fail "could not download $name from $origin"
fetch "$origin/galopin/SHA256SUMS" "$tmp/SHA256SUMS" || fail "could not download SHA256SUMS from $origin"

want=$(awk -v n="$name" '$2 == n || $2 == "*" n { print $1 }' "$tmp/SHA256SUMS")
[ -n "$want" ] || fail "SHA256SUMS lists no $name"
got=$(sha256 "$tmp/$name")
[ "$got" = "$want" ] || fail "checksum mismatch for $name (expected $want, got $got); nothing installed"

mkdir -p "$dir"
chmod 755 "$tmp/$name"
mv "$tmp/$name" "$dir/galopin"
if [ "$os" = darwin ] && command -v xattr >/dev/null 2>&1; then
	xattr -d com.apple.quarantine "$dir/galopin" 2>/dev/null || true
fi

printf 'Installed galopin to %s/galopin (checksum verified).\\n' "$dir"
case ":$PATH:" in
	*":$dir:"*) ;;
	*) printf 'Note: %s is not on your PATH; add it, or run %s/galopin directly.\\n' "$dir" "$dir" ;;
esac
printf '\\nNext, pair this machine with %s:\\n\\n  galopin enroll --cerea %s\\n  galopin run\\n\\n' "$origin" "$origin"
printf 'Then confirm it in the /code panel.\\n'
`;
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
	{ origin, ifNoneMatch }: { origin: string; ifNoneMatch?: string | null }
): Promise<DistResponse> {
	if (!GALOPIN_PUBLIC_NAMES.has(name)) return notFound("Not found.");

	if (name === "install.sh") {
		return {
			status: 200,
			headers: {
				"content-type": "text/x-shellscript; charset=utf-8",
				"cache-control": "no-cache",
			},
			body: renderInstallScript(origin),
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
		body: Readable.toWeb(createReadStream(path)) as unknown as ReadableStream,
	};
}
