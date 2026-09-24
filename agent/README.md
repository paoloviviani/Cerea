# galopin

galopin — Torinese for a clerk or handyman — is the Cerea machine agent: the
one binary a coding-agent machine runs so the chat's `/code` panel can drive
opencode (or any ACP agent) on it. It authenticates a person to the Pystino
gateway, wires up opencode's config, and dials **out** to Cerea over WSS —
no relay, no daemon, and nothing capability-bearing stored in Cerea. The wire
protocol it speaks is `PROTOCOL.md`, in this same directory.

## Licensing

This directory is **first-party code under Cerea's EUPL-1.2 `LICENCE`** (the
one at the repository root), not the Apache-2.0 upstream chat-ui code that
`LICENSE` covers. It moved here from Pystino's own repository with its
history preserved (`git log -- agent/`), and its EUPL-1.2 origin travels
with it.

## Building

Go 1.24+, no other build dependency:

```sh
cd agent
go build -o galopin .              # this machine's OS/arch
GOOS=linux GOARCH=arm64 go build -o galopin-linux-arm64 .   # cross-compile
```

Deployments serve these binaries themselves: the Cerea image builds them
into `/app/galopin-dist` and `<base>/galopin/install.sh` installs one
(checksum-verified). See `docs/agent-machines.md`.

`packaging/build-dist.sh [OUT_DIR]` (default `./galopin-dist`) cross-builds
all four targets people run this on (`linux/amd64`, `linux/arm64`,
`darwin/amd64`, `darwin/arm64`) as static binaries (`CGO_ENABLED=0`), and
writes `REVISION` (the Cerea commit built from), `SHA256SUMS`, and copies in
`packaging/galopin.service` and `packaging/org.cerea.galopin.plist`.

## Running

```
galopin enroll   sign in, pick a billing group, write opencode.json,
                 store the refresh credential
galopin serve    the local refreshing proxy shim alone (opencode with no /code panel)
galopin run      serve, plus supervise opencode (or an ACP agent) and dial out to Cerea
```

```sh
galopin enroll --issuer https://llm.example.org/authelia \
  --gateway https://llm.example.org --cerea https://llm.example.org/chat \
  --output ~/.config/opencode/opencode.json
galopin run
```

Full flag reference, keeping it running as a systemd user unit or a
macOS LaunchAgent, revocation and re-enrollment: `docs/agent-machines.md` at
the Cerea repository root.

## State directory

Credentials and every other file galopin writes on its own behalf —
`credentials.json` (carries the shim secret), `machine-id`, `policy.json`,
`revoked`, `opencode-overlay.json`, `workspaces.json` and `status.json` —
live in `<config-dir>/galopin/` (`~/.config/galopin` on Linux,
`~/Library/Application Support/galopin` on macOS). opencode's own config
keeps its own default, `~/.config/opencode/opencode.json`, unaffected.

A machine enrolled before this move kept those files beside opencode's own
config, each name prefixed `pystino-` to avoid colliding with opencode's
files in that shared directory. The first `run`, `enroll` or `serve` after
upgrading migrates them into `<config-dir>/galopin/` automatically (atomic
rename, mode preserved, one line logged naming what moved) — nothing to do
by hand. An explicit `--creds`/`--state-dir` opts out of the migration, and
if both directories already have credentials the new one wins outright with
nothing overwritten.

## What stays the same

The wire protocol (`PROTOCOL.md`), the `pystino-machine.v1` WebSocket
subprotocol, the `/api/v2/code/machine` path, the `X-Pystino-Machine-*`
headers and the `opencode-enrollment` OIDC client id are all unchanged by
this move — live machines depend on them, and none of it is specific to the
old name.
