#!/usr/bin/env python3
"""The chat's administration panel, and the gate in front of it.

Run it against the live deployment (the file is parsed, never sourced —
sourcing would mangle the CHAT_OPENID_CONFIG JSON bash quote removal
destroys; PYSTINO_ENV names a different file when the checkout is elsewhere):

    PYSTINO_ENV=/home/ubuntu/workspace/Pystino/deploy/.env \\
      /home/ubuntu/workspace/Pystino/.venv/bin/python scripts/test_admin_panel_live.py

What this is for: the panel asks the *gateway* who is an administrator
(`GET /v1/me`), because the chat's own `user.isAdmin` comes from a HuggingFace
organisation claim and means nothing in this deployment. That indirection is
easy to get subtly wrong in a way unit tests do not see — the token has to
reach the gateway, the gateway has to answer, and a non-administrator has to be
refused by the *routes* and not merely by the page.

So the assertions worth making live are the negative ones, with the positive
paired against them: signing in as an ordinary user must render the refusal
rather than the panel, and must be refused by the API that changes something —
because a page that renders is not a permission.

The ordinary user comes from `GATEWAY_LOCAL_USER_EMAIL` /
`GATEWAY_LOCAL_USER_PASSWORD` in the env file. When they are absent the
negative half is skipped, openly rather than faked — an administrator's
session cannot prove what a refusal looks like — and the admin-positive
counterparts run instead (the panel renders the settings, the routes answer,
a personal connector can be added and removed).
"""

import os
import sys

import httpx

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
USER_EMAIL = env.get("GATEWAY_LOCAL_USER_EMAIL") or ""
USER_PASSWORD = env.get("GATEWAY_LOCAL_USER_PASSWORD") or ""

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


def sign_in(client: httpx.Client, email: str, password: str) -> None:
    """House IdP (ADR 0068) plus local door (ADR 0043): JSON credentials to
    the gateway, then the chat's authorize round trip on the same jar."""
    r = client.post(f"{BASE}/auth/login", json={"email": email, "password": password})
    if r.status_code != 200:
        sys.exit(f"local login as {email} failed ({r.status_code}): {r.text[:200]}")
    home = client.get(f"{CHAT}/", follow_redirects=True)
    if "login" in str(home.url).lower() or home.status_code != 200:
        sys.exit(
            f"the authorize round trip did not land in the chat for {email}: "
            f"{home.url} ({home.status_code})"
        )

def main() -> int:
    with httpx.Client(follow_redirects=True, timeout=120) as c:
        if USER_EMAIL and USER_PASSWORD:
            sign_in(c, USER_EMAIL, USER_PASSWORD)
            print("signed in as", USER_EMAIL, "(an ordinary user)")
            negative_flow(c)
        else:
            print(
                "SKIP the non-administrator half: GATEWAY_LOCAL_USER_EMAIL/PASSWORD "
                "are not set in the env file. An administrator's session cannot "
                "prove what a refusal looks like, so those assertions are omitted "
                "rather than faked; the admin-positive counterparts run instead."
            )
            sign_in(c, ADMIN_EMAIL, ADMIN_PASSWORD)
            print("signed in as", ADMIN_EMAIL, "(an administrator)")
            positive_flow(c)

    print(f"\n{ok} ok, {fail} failed")
    return 1 if fail else 0


def negative_flow(c: httpx.Client) -> None:
    print("\nthe panel explains rather than crashing:")
    r = c.get(f"{CHAT}/admin/fetch")
    check("the page loads at all", r.status_code == 200, str(r.status_code))
    # A 500 here would be the failure mode of asking the gateway badly, and
    # a rendered panel would be the failure mode of not asking it.
    check(
        "it shows the refusal, not the settings",
        ("needs an administrator" in r.text or "is for administrators" in r.text)
        and "Detect automatically" not in r.text,
        "the panel rendered for a non-administrator"
        if "Detect automatically" in r.text
        else "neither the refusal nor the panel appeared",
    )

    print("\nand the routes refuse, which is the part that matters:")
    r = c.get(f"{CHAT}/api/v2/admin/fetching")
    check("reading the setting is refused", r.status_code in (401, 403), str(r.status_code))

    r = c.patch(
        f"{CHAT}/api/v2/admin/fetching",
        json={"backend": "playwright"},
        headers={"origin": BASE},
    )
    check(
        "changing it is refused",
        r.status_code in (401, 403),
        f"{r.status_code}: {r.text[:120]}",
    )

    print("\nthe connector API is open to an ordinary user (it is theirs):")
    r = c.get(f"{CHAT}/api/v2/mcp/connectors")
    check("listing their own connectors works", r.status_code == 200, str(r.status_code))
    r = c.post(
        f"{CHAT}/api/v2/mcp/connectors",
        json={
            "name": "not allowed",
            "url": "https://mcp.notion.com/mcp",
            "scope": "deployment",
        },
        headers={"origin": BASE},
    )
    # The pairing: they may add their own, they may not add everybody's.
    check(
        "but publishing one to everybody is not",
        r.status_code in (401, 403),
        f"{r.status_code}: {r.text[:120]}",
    )


def positive_flow(c: httpx.Client) -> None:
    """The admin counterparts: the panel renders the settings, the routes
    answer, and a personal connector can be added and removed again. No
    deployment-wide value is changed — this run must not flip live settings
    to prove it can read them."""
    print("\nthe panel renders the settings for an administrator:")
    r = c.get(f"{CHAT}/admin/fetch")
    check("the page loads at all", r.status_code == 200, str(r.status_code))
    check(
        "it shows the settings, not a refusal",
        "Detect automatically" in r.text,
        "the settings did not render for an administrator",
    )

    print("\nand the routes answer, which is the part that matters:")
    r = c.get(f"{CHAT}/api/v2/admin/fetching")
    check("reading the setting works", r.status_code == 200, str(r.status_code))

    print("\ntheir own connectors, added and removed:")
    api = f"{CHAT}/api/v2/mcp/connectors"
    r = c.get(api)
    check("listing their own connectors works", r.status_code == 200, str(r.status_code))
    r = c.post(
        api,
        json={"name": "Admin panel live check", "url": "https://mcp.exa.ai/mcp"},
        headers={"origin": BASE},
    )
    check("adding a personal one works", r.status_code == 201, r.text[:200])
    if r.status_code == 201:
        cid = r.json()["id"]
        r = c.delete(f"{api}/{cid}")
        check("removing it again works", r.status_code == 204, str(r.status_code))


if __name__ == "__main__":
    raise SystemExit(main())
