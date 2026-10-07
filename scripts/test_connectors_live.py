#!/usr/bin/env python3
"""MCP connectors and their OAuth, against the running stack (ADR 0064).

Run it against the live deployment (the file is parsed, never sourced —
sourcing would mangle the CHAT_OPENID_CONFIG JSON bash quote removal
destroys; PYSTINO_ENV names a different file when the checkout is elsewhere):

    PYSTINO_ENV=/home/ubuntu/workspace/Pystino/deploy/.env \\
      /home/ubuntu/workspace/Pystino/.venv/bin/python scripts/test_connectors_live.py

Adds Notion's remote MCP server as a connector and drives the flow as far as a
machine can: discovery finds its authorization server, dynamic client
registration gets us a client id, and the authorize URL comes back pointing at
**our own** redirect URI. The last step — approving a consent screen — needs a
person with a Notion account, and this says so rather than pretending a green
run covers it.

What it also asserts, and what the whole ADR is for: **no credential reaches
the browser.** The connector listing carries `connected` and never a token.
"""

import os
import sys

import httpx

ok = 0
fail = 0


def check(name: str, condition: bool, detail: str = "") -> None:
    global ok, fail
    if condition:
        ok += 1
        print(f"  ok   {name}")
    else:
        fail += 1
        print(f"  FAIL {name}" + (f" — {detail}" if detail else ""))


def ca_bundle() -> str | bool:
    path = "deploy/tls/caddy-root.crt"
    return path if os.path.exists(path) else True


ENV_PATH = os.environ.get("PYSTINO_ENV", "/home/ubuntu/workspace/Pystino/deploy/.env")
if not os.path.exists(ENV_PATH):
    sys.exit(f"no env file at {ENV_PATH} — set PYSTINO_ENV to the Pystino deploy/.env")

env = {}
for line in open(ENV_PATH):
    line = line.strip()
    if line and not line.startswith("#") and "=" in line:
        k, v = line.split("=", 1)
        env[k] = v.strip().strip('"').strip("'")

if not env.get("PUBLIC_ORIGIN"):
    sys.exit(f"PUBLIC_ORIGIN is not set in {ENV_PATH}")
BASE = env["PUBLIC_ORIGIN"].rstrip("/")
CHAT = f"{BASE}/chat"

ADMIN_EMAIL = env.get("GATEWAY_LOCAL_ADMIN_EMAIL") or "admin@local"
ADMIN_PASSWORD = env.get("GATEWAY_LOCAL_ADMIN_PASSWORD") or ""
if not ADMIN_PASSWORD:
    sys.exit(
        f"GATEWAY_LOCAL_ADMIN_PASSWORD is not set in {ENV_PATH} — "
        "the scripts sign in through the gateway's local door (ADR 0043), "
        "whose password lives there, never in this repository."
    )

NOTION = "https://mcp.notion.com/mcp"


def sign_in(client: httpx.Client) -> None:
    """House IdP (ADR 0068) plus local door (ADR 0043): JSON credentials to
    the gateway, then the chat's authorize round trip on the same jar."""
    r = client.post(
        f"{BASE}/auth/login", json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD}
    )
    if r.status_code != 200:
        sys.exit(f"local login as {ADMIN_EMAIL} failed ({r.status_code}): {r.text[:200]}")
    home = client.get(f"{CHAT}/", follow_redirects=True)
    if "login" in str(home.url).lower() or home.status_code != 200:
        sys.exit(
            f"the authorize round trip did not land in the chat: {home.url} ({home.status_code})"
        )


def main() -> int:
    with httpx.Client(verify=ca_bundle(), follow_redirects=True, timeout=120) as c:
        sign_in(c)
        print("signed in as", ADMIN_EMAIL)

        api = f"{CHAT}/api/v2/mcp/connectors"

        # Start from nothing, so the run is repeatable.
        for existing in c.get(api).json()["data"]:
            if existing["name"].startswith("Notion live check"):
                c.delete(f"{api}/{existing['id']}")

        print("\nadding it probes the server rather than asking:")
        r = c.post(api, json={"name": "Notion live check", "url": NOTION})
        check("the connector was created", r.status_code == 201, r.text[:300])
        if r.status_code != 201:
            return 1
        connector = r.json()

        check(
            "discovery found that it wants OAuth",
            connector["auth"] == "oauth",
            f"it reported auth={connector['auth']}: {connector.get('lastError')}",
        )
        check(
            "and named its authorization server",
            connector.get("issuer") == "https://mcp.notion.com",
            str(connector.get("issuer")),
        )
        check(
            "so a sign-in can be offered",
            connector["canAuthorize"] is True,
            "no registration endpoint was discovered",
        )
        check("nobody is connected yet", connector["connected"] is False)

        print("\nno credential reaches the browser:")
        body = r.text
        for leaked in ("tokenSealed", "clientSecret", "accessToken", "refreshToken"):
            check(f"`{leaked}` is not in the response", leaked not in body)

        print("\nstarting a sign-in registers us and builds the URL:")
        r = c.post(
            f"{api}/{connector['id']}",
            json={"action": "authorize", "next": "/chat/"},
        )
        check("authorize returned a URL", r.status_code == 200, r.text[:300])
        if r.status_code != 200:
            return 1
        authorize = r.json()["authorizeUrl"]
        parsed = httpx.URL(authorize)
        params = dict(parsed.params)

        check(
            "it points at Notion's authorization endpoint",
            str(parsed).startswith("https://mcp.notion.com/authorize"),
            str(parsed)[:120],
        )
        check(
            "the redirect URI is ours, not a localhost",
            params.get("redirect_uri") == f"{BASE}/chat/mcp/callback",
            f"redirect_uri={params.get('redirect_uri')}",
        )
        check("PKCE S256", params.get("code_challenge_method") == "S256")
        check("a code challenge is present", len(params.get("code_challenge", "")) > 20)
        # The MCP server's canonical URI, not its issuer's origin: RFC 8707 is
        # about naming the resource the token is *for*, and one authorization
        # server can front several. Asserted here because getting it wrong is
        # invisible until a provider starts checking the audience.
        check(
            "the RFC 8707 resource indicator names the server",
            params.get("resource") == NOTION,
            f"resource={params.get('resource')}",
        )
        check("a state was issued", len(params.get("state", "")) > 20)
        check(
            "a client id was obtained by registration",
            bool(params.get("client_id")),
            "no client_id — dynamic registration did not happen",
        )

        print("\nstatic credentials, for a provider that will not register us:")
        # The dead end this mode exists for. Notion *does* offer DCR, so the
        # case is built by hand: a connector created with credentials we supply
        # must reach an authorize URL carrying exactly those.
        r = c.post(
            api,
            json={
                "name": "Notion live check static",
                "url": NOTION,
                "authMode": "oauth_static",
                "clientId": "a-client-id-we-were-given",
                "clientSecret": "a-secret-we-were-given",
            },
        )
        check("a static connector was created", r.status_code == 201, r.text[:300])
        if r.status_code == 201:
            static = r.json()
            check(
                "it reports its own client rather than a registered one",
                static.get("registrationSource") == "static",
                f"registrationSource={static.get('registrationSource')}",
            )
            check(
                "the client id is shown back, since it is not a secret",
                static.get("clientId") == "a-client-id-we-were-given",
                str(static.get("clientId")),
            )
            check(
                "the client secret is not",
                "a-secret-we-were-given" not in r.text,
                "the client secret came back to the browser",
            )
            check("so it can be signed in to", static["canAuthorize"] is True)

            r = c.post(
                f"{api}/{static['id']}",
                json={"action": "authorize", "next": "/chat/"},
            )
            check("authorize works with those credentials", r.status_code == 200, r.text[:200])
            if r.status_code == 200:
                params = dict(httpx.URL(r.json()["authorizeUrl"]).params)
                check(
                    "and carries the client id we supplied",
                    params.get("client_id") == "a-client-id-we-were-given",
                    f"client_id={params.get('client_id')}",
                )
                check("still PKCE S256", params.get("code_challenge_method") == "S256")

            c.delete(f"{api}/{static['id']}")

        print("\nthe callback refuses what it should:")
        r = c.get(f"{CHAT}/mcp/callback?state=not-one-we-issued&code=x")
        check(
            "an unknown state does not connect anything",
            "mcp=failed" in str(r.url),
            f"landed on {r.url}",
        )
        still = c.get(f"{api}/{connector['id']}").json()
        check("and the connector is still unconnected", still["connected"] is False)

        print("\ncleanup")
        r = c.delete(f"{api}/{connector['id']}")
        check("removed", r.status_code == 204, str(r.status_code))

        print(f"\n{ok} ok, {fail} failed")
        print(
            "\nTo finish it by hand: open the Connectors section of the MCP dialog,\n"
            "add https://mcp.notion.com/mcp, and press Sign in. Approving the\n"
            "consent screen is the one step no script can do."
        )
    return 1 if fail else 0


if __name__ == "__main__":
    raise SystemExit(main())
