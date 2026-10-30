"""End-to-end sign-in through a fresh kit stack (the release's fresh-kit test, or by hand).

    uv run python scripts/release/signin_check.py <deploy dir> <first user's password> [--chat] [--real-dns]

Browser-shaped: every request goes to the public origin, whose name this
script resolves to the local proxy; cookies are kept per host and redirects
are followed by hand so each hop prints. It proves: the proxy routes, Authelia
serves its portal under /authelia, the gateway's OIDC client exchanges the
code over the internal back-channel (no CA bundle anywhere), and the bootstrap
address is the administrator. With --chat it then signs into the chat on the
same Authelia session — the chat's own back-channel discovery and token
exchange — and reads the signed-in user back.

--real-dns checks a live deployment as it is reached from outside: the public
name resolves as DNS says (through a TLS-terminating edge, say) and the
certificate is verified.
"""

import json
import os
import socket
import sys
import urllib.parse

import httpx

args = [a for a in sys.argv[1:] if not a.startswith("--")]
if len(args) != 2:
    sys.exit("usage: signin_check.py <deploy dir> <first user password> [--chat] [--real-dns]")
deploy, password = args
chat = "--chat" in sys.argv
real_dns = "--real-dns" in sys.argv

env = {}
with open(f"{deploy}/.env") as handle:
    for line in handle:
        if "=" in line and not line.startswith("#"):
            key, value = line.rstrip("\n").split("=", 1)
            env[key] = value.strip("'")
origin = env["PUBLIC_ORIGIN"]
public = urllib.parse.urlsplit(origin)

# The public name resolves to this machine, as DNS would make it for a real
# deployment; URLs, Host headers, SNI and cookie domains stay exactly as a
# browser would have them.
_getaddrinfo = socket.getaddrinfo


def _resolve(host, *rest, **kw):
    return _getaddrinfo("127.0.0.1" if host == public.hostname else host, *rest, **kw)


if not real_dns:
    socket.getaddrinfo = _resolve
# verify=False for the trial stacks: they run TLS_MODE=internal (Caddy's own
# CA), which no server is meant to trust — that is the whole point of the
# back-channel. A live check verifies the certificate like any browser.
client = httpx.Client(verify=real_dns, follow_redirects=False, timeout=30)


def step(method, url, **kw):
    response = client.request(method, url, **kw)
    where = response.headers.get("location", "")[:100]
    print(f"{method} {urllib.parse.urlsplit(url).path[:60]} -> {response.status_code} {where}")
    return response


consents = []  # one entry per consent decision made: (client, scopes, allowed)


def absolute(location: str) -> str:
    return f"{origin}{location}" if location.startswith("/") else location


def authorize(auth_url: str, client_id: str, done_marker: str, deny_offline: bool = False) -> str:
    """Walk Authelia from an authorization URL to the relying party's callback.

    A consent screen is accepted and remembered, except that `deny_offline` refuses one that asks
    for `offline_access` (the person saying no to background access)."""
    loc = ""
    for _ in range(6):
        r = step("GET", auth_url)
        loc = r.headers.get("location", "")
        if done_marker in loc:
            return loc
        query = dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(loc).query))
        if loc.startswith(f"{origin}/authelia/?") and query.get("flow_id"):
            first = step(
                "POST",
                f"{origin}/authelia/api/firstfactor",
                json={
                    "username": os.environ.get("LOGIN_USER") or env["AUTHELIA_ADMIN_USER"],
                    "password": password,
                    "keepMeLoggedIn": False,
                    "flow": "openid_connect",
                    "flowID": query["flow_id"],
                },
                headers={"origin": origin},
            )
            assert first.status_code == 200, first.text[:300]
        elif "consent" in loc and query.get("flow_id"):
            info = step(
                "GET",
                f"{origin}/authelia/api/oidc/consent?flow_id={query['flow_id']}",
                headers={"origin": origin},
            )
            data = info.json().get("data", {})
            claims = data.get("claims") or []
            scopes = data.get("scopes") or []
            allow = not (deny_offline and "offline_access" in scopes)
            consents.append((client_id, tuple(scopes), allow))
            print(f"   consent screen for {client_id}: scopes={scopes} -> {'allow' if allow else 'DENY'}")
            decision = step(
                "POST",
                f"{origin}/authelia/api/oidc/consent",
                json={
                    "flow_id": query["flow_id"],
                    "client_id": client_id,
                    "consent": allow,
                    "pre_configure": True,
                    "claims": claims,
                },
                headers={"origin": origin},
            )
            auth_url = decision.json()["data"]["redirect_uri"]
        else:
            raise SystemExit(f"unexpected hop: {r.status_code} {loc} {r.text[:200]}")
    raise SystemExit(f"never reached {done_marker}: {loc}")


# --- the console ------------------------------------------------------------
r = step("GET", f"{origin}/auth/login?provider=default")
assert r.status_code in (302, 303, 307), r.text[:300]
assert r.headers["location"].startswith(f"{origin}/authelia/"), r.headers["location"]
callback = authorize(r.headers["location"], "pystino-console", "/auth/callback/")
r = step("GET", callback)  # the gateway exchanges the code over the back-channel here
assert r.status_code in (302, 303), r.text[:500]
me = step("GET", f"{origin}/api/me")
assert me.status_code == 200, me.text[:300]
body = me.json()
print("ME:", {k: body.get(k) for k in ("email", "is_admin", "groups")})
want_admin = os.environ.get("EXPECT_ADMIN", "true") == "true"
assert body.get("is_admin") is want_admin, f"is_admin={body.get('is_admin')}, expected {want_admin}"
r = step("GET", f"{origin}/console/")
print("CONSOLE:", r.status_code)
assert r.status_code == 200, r.text[:300]

# --- the chat ---------------------------------------------------------------
GRANT_URL = f"{origin}/chat/api/v2/user/schedule-grant"
MAX_ROUNDS = 4


def chat_sign_in(label: str, deny_offline: bool = False) -> str:
    """Sign in to the chat as a browser would, following the chat's own fallbacks.

    The first sign-in on a browser asks for background access (`offline_access`), which the IdP may
    answer with a consent screen, an error, or a refusal; the chat answers an error by redirecting
    back to /chat/login. The callback may also send the browser round once more to ask for a missing
    grant. Each hop that points back at /chat/login or the portal is followed, at most MAX_ROUNDS
    authorizations in all, so a loop fails here instead of hanging."""
    print(f"-- chat sign-in: {label}")
    r = step("GET", f"{origin}/chat/login")
    assert r.status_code in (302, 303, 307), r.text[:300]
    loc = absolute(r.headers["location"])
    for round_ in range(1, MAX_ROUNDS + 1):
        callback = authorize(loc, "cerea", "/chat/login/callback", deny_offline=deny_offline)
        r = step("GET", callback)  # the chat exchanges the code over its back-channel here
        assert r.status_code in (302, 303), r.text[:500]
        nxt = absolute(r.headers.get("location", ""))
        path = urllib.parse.urlsplit(nxt).path
        if path.startswith("/chat/login") and not path.startswith("/chat/login/callback"):
            r = step("GET", nxt)  # a fallback round: the chat asks again
            assert r.status_code in (302, 303, 307), r.text[:300]
            loc = absolute(r.headers["location"])
            continue
        print(f"   signed in after {round_} authorization(s); landed on {path}")
        assert not path.startswith("/chat/login"), f"still at the sign-in: {nxt}"
        return nxt
    raise SystemExit(f"{label}: the sign-in did not settle in {MAX_ROUNDS} rounds (a loop?)")


def grant_state() -> dict:
    """The person's background-access state, read through the chat's own API (a superjson body)."""
    r = step("GET", GRANT_URL)
    assert r.status_code == 200, r.text[:300]
    body = r.json()
    return body.get("json", body)


if chat:
    chat_email = os.environ.get("LOGIN_EMAIL") or env["AUTHELIA_ADMIN_EMAIL"]

    def check_user():
        user = step("GET", f"{origin}/chat/api/user")
        assert user.status_code == 200, user.text[:300]
        print("CHAT USER:", {k: user.json().get(k) for k in ("email", "username")})
        assert user.json().get("email") == chat_email

    only_deny = os.environ.get("ONLY_DENY") == "true"

    if not only_deny:
        # 1. the first sign-in on this browser: asks for background access, which is consented to once.
        mark = len(consents)
        chat_sign_in("first")
        check_user()
        first = consents[mark:]
        print("   consent decisions:", first)
        assert any("offline_access" in c[1] and c[2] for c in first), "no offline_access consent on the first sign-in"
        state = grant_state()
        print("   background access:", state)
        assert state.get("granted") is True and state.get("active") is True, state
        assert client.cookies.get("hfChat-bgAccess") == "1", client.cookies.get("hfChat-bgAccess")

        # 2. a second sign-in in the same cookie jar: plain scopes now. Its ordinary consent is asked and
        #    remembered (at most one screen); the grant is kept, and offline_access is not asked again.
        mark = len(consents)
        chat_sign_in("second, same browser")
        check_user()
        second = consents[mark:]
        print("   consent decisions:", second)
        assert not any("offline_access" in c[1] for c in second), second
        assert len(second) <= 1, second
        assert grant_state().get("granted") is True

        # 3. and a third: the remembered consent means no screen at all.
        mark = len(consents)
        chat_sign_in("third, same browser")
        check_user()
        assert consents[mark:] == [], f"a consent screen on the third sign-in: {consents[mark:]}"
        assert grant_state().get("granted") is True

        for path in ("/chat/", "/chat/code"):
            r = step("GET", f"{origin}{path}")
            print("CHAT PAGE:", path, r.status_code)
            assert r.status_code == 200, r.text[:300]
    else:
        # A person who says no to background access still signs in: once, with no loop, and no grant.
        mark = len(consents)
        chat_sign_in("denied background access", deny_offline=True)
        check_user()
        denied = consents[mark:]
        print("   consent decisions:", denied)
        assert any("offline_access" in c[1] and not c[2] for c in denied), denied
        state = grant_state()
        print("   background access:", state)
        assert state.get("granted") is False, state
        assert client.cookies.get("hfChat-bgAccess") == "0", client.cookies.get("hfChat-bgAccess")
        # And they stay signed in on the next visit: no loop back to the sign-in.
        r = step("GET", f"{origin}/chat/")
        assert r.status_code == 200, r.status_code

print("E2E_OK")
