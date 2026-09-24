# The `/code` panel: deploying it

The Agents panel drives **coding agents running on people's own machines**
from the chat's sidebar. Nothing about it runs model inference here, and
nothing about it stores code here: the agent is `opencode`, supervised by a
one-binary agent (`pystino-agent`) on the person's own machine, which dials
**out** to this deployment over WSS and authenticates with its own OIDC
enrollment credential — no relay, no daemon, no paseo (see
`reports/2026-09-24-thin-agent-protocol.md` for the wire protocol).

This page is for whoever deploys it. The person sitting in front of the panel
wants [Agent machines](agent-machines.md) instead.

## What actually gets deployed

Nothing extra. The machine link is one WebSocket endpoint
(`GET /api/v2/code/machine`) served by this same chat process — `server.js`
upgrades it below SvelteKit's request handling (`src/lib/server/code/machineServer.ts`).
There is no relay container, no pinned external image, and no published port
beyond the one this deployment already exposes.

## Turning it on

Two env vars:

| Var                      | What                                                                                                                                                                                                                |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CODE_AGENTS_ENABLED`    | `"true"` to show the sidebar switch and serve `/code`; off (including unset) 404s the route and hides pairing, since a route that only errors without a machine is worse than none                                  |
| `CODE_MACHINE_AUDIENCE`  | the `aud` a machine's bearer must carry; defaults to `pystino-api`                                                                                                                                                  |
| `CODE_MACHINE_CLIENT_ID` | the `azp`/`client_id` a machine's bearer must carry; defaults to `opencode-enrollment`                                                                                                                              |
| `CODE_MACHINE_ISSUER`    | the OIDC issuer a machine's bearer must be signed by; defaults to `OPENID_PROVIDER_URL`, so a normal deployment sets nothing extra here — separate only for a test harness pointing machine tokens at a mock issuer |

## Local JWT validation, not userinfo (review C1)

A machine's bearer is validated **locally** against the issuer's own JWKS
(`src/lib/server/code/machineAuth.ts`): `iss` exact match (trailing slash
normalized), `aud` contains `CODE_MACHINE_AUDIENCE`, `azp`/`client_id` equals
`CODE_MACHINE_CLIENT_ID`, `exp` in the future, and the token must not be an ID
token. Userinfo is never called — it proves nothing about audience or
authorized party, which is exactly the hole the old `enroll/machine` endpoint
had.

The token's `sub` maps to an existing Cerea user the same way the OIDC login
callback does (`hfUserId`). No user → the WebSocket upgrade is refused with a
plain HTTP 403 before it ever completes.

## What Cerea stores, and what it does not

Cerea persists **pairing records only**, in the `codeDevices` collection: a
name, the machine's own id (`machineId`, from `X-Pystino-Machine-Id`), the
OIDC `sub`/`iss` it last connected with, the backends and policy it reported
in `hello`, and its last-known credential health. Nothing here is a bearer
capability — the only thing that can reach a machine is a live socket held in
an in-process registry (`src/lib/server/code/machines.ts`), lost on restart, and a
Mongo dump of the collection yields names and ids only (review C4).

That is why revoking a machine tombstones the row (`status: "revoked"`)
rather than deleting it: a reconnect under the same `machineId` is refused
from then on, and the live socket (if any) is closed with WebSocket code
`4403`.

## Pairing: connect, then confirm

A machine with a valid bearer and an unrecognized `machineId` creates a
`pending` row on its first `hello` frame — the socket stays open, but nothing
is forwarded to it. The panel lists pending machines with **Confirm/Reject**;
Confirm is the fresh human approval that a phished device-code grant alone
never reaches (review C2), and pushes a `status: "paired"` frame down the
socket. Reject is the same tombstoning action as revoking a paired machine.

## What the browser may ask the machine to do

Never directly: the browser talks to Cerea, Cerea talks to the machine
registry. The forwarder (`src/routes/api/v2/code/[...path]/+server.ts`) maps
each allowed browser path onto exactly one typed op (spec §6), and every call
carries `?device=`, whose row is checked against the caller before anything
is sent. An offline machine answers instantly from the registry — never a
hang (review R1).

Deliberately **not** offered, and why:

- **timeline streams** — the SSE bridge at `agents/[id]/stream` owns the
  subscription and calls `session.sync`/events directly;
- **pairing hooks on the machine** — pairing happens on connect
  (`machines.ts`), confirm/reject/revoke live in `devices/+server.ts`;
- **anything beyond one backend's sessions** (workspace roots outside the
  machine's own policy, raw backend config) — the panel drives sessions, not
  machines, and the machine's own policy is a veto the panel cannot override.

## When it does not work

| Symptom                                                | Where to look                                                                                                                                                                                                                |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| no Agents switch in the sidebar                        | `CODE_AGENTS_ENABLED` is not exactly `"true"`, or the person is not signed in                                                                                                                                                |
| `/code` answers 404                                    | same flag; the route gates on it independently of the sidebar                                                                                                                                                                |
| a machine never appears, even `pending`                | its bearer is failing local validation — check `CODE_MACHINE_ISSUER`/`CODE_MACHINE_AUDIENCE`/`CODE_MACHINE_CLIENT_ID` match what the enrollment minted, and that the machine's `sub` has signed into this chat at least once |
| a machine appears `pending` forever                    | nobody has clicked Confirm in the Agents panel yet                                                                                                                                                                           |
| every call to a paired machine answers "not connected" | the machine's process is not running, or its WSS dial to this origin is failing (check its own logs)                                                                                                                         |
| a machine that was working now gets `4401` closes      | its access token stopped renewing — re-run its enrollment                                                                                                                                                                    |
