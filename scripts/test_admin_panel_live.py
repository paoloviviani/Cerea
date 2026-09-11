#!/usr/bin/env python3
"""The chat's administration panel, and the gate in front of it.

    set -a; . deploy/.env; set +a
    ./scripts/test_admin_panel_live.py

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
"""

import os
import re
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


def main() -> int:
    host = os.environ.get("PUBLIC_HOST")
    if not host:
        sys.exit("source deploy/.env first — PUBLIC_HOST is not set")
    base = f"https://{host}:{os.environ.get('HTTPS_PORT', '443')}"

    with httpx.Client(verify=ca_bundle(), follow_redirects=True, timeout=120) as c:
        r = c.get(f"{base}/chat/")
        form = re.search(r'action="([^"]+)"', r.text)
        if not form:
            sys.exit(f"no login form at {base}/chat/ (status {r.status_code})")
        c.post(
            form.group(1).replace("&amp;", "&"),
            data={
                "username": os.environ["KEYCLOAK_TEST_USER"],
                "password": os.environ["KEYCLOAK_TEST_PASSWORD"],
                "credentialId": "",
            },
        )
        print("signed in as", os.environ["KEYCLOAK_TEST_USER"], "(an ordinary user)")

        print("\nthe panel explains rather than crashing:")
        r = c.get(f"{base}/chat/admin/fetch")
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
        r = c.get(f"{base}/chat/api/v2/admin/fetching")
        check("reading the setting is refused", r.status_code in (401, 403), str(r.status_code))

        r = c.patch(
            f"{base}/chat/api/v2/admin/fetching",
            json={"backend": "playwright"},
            headers={"origin": base},
        )
        check(
            "changing it is refused",
            r.status_code in (401, 403),
            f"{r.status_code}: {r.text[:120]}",
        )

        print("\nthe connector API is open to an ordinary user (it is theirs):")
        r = c.get(f"{base}/chat/api/v2/mcp/connectors")
        check("listing their own connectors works", r.status_code == 200, str(r.status_code))
        r = c.post(
            f"{base}/chat/api/v2/mcp/connectors",
            json={
                "name": "not allowed",
                "url": "https://mcp.notion.com/mcp",
                "scope": "deployment",
            },
            headers={"origin": base},
        )
        # The pairing: they may add their own, they may not add everybody's.
        check(
            "but publishing one to everybody is not",
            r.status_code in (401, 403),
            f"{r.status_code}: {r.text[:120]}",
        )

    print(f"\n{ok} ok, {fail} failed")
    return 1 if fail else 0


if __name__ == "__main__":
    raise SystemExit(main())
