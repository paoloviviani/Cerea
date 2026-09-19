#!/usr/bin/env python3
"""The sidebar tree and signing out, against the running stack.

What is checkable without a browser: the panel renders every branch, each
branch row is expandable rather than a link, the foot is a static footer (who
is signed in, a theme switch, sign out — no popup opens there), Workspace and
Settings are rows above it, and a conversation inside a project is listed once
rather than twice.

The half that matters most is **signing out**, because it is the half no
in-process test can see. Clearing the local cookie is easy and was already
right; what was wrong is that the redirect afterwards re-ran the OIDC flow and
the directory's own still-live session signed the person straight back in, so
Sign out did nothing observable. This walks the real sequence — local session
gone, provider end-session, back to the app — and asserts they are still signed
out at the end of it.

Two things it learned the hard way, both recorded so they are not rediscovered:
the house IdP ends the session unconditionally and never answers 400 — an
unregistered `post_logout_redirect_uri` falls back to `/` rather than
refusing (there is no Keycloak here anymore; ADR 0044 removed it and ADR 0068
is what signs people in). The chat always sends its own home, which is
same-origin and so honoured, meaning the browser comes back to `/chat/`,
which is unauthenticated by then and bounces to the login prompt. Landing on
a login prompt at the end is the *proof* of a working sign-out, not a
failure.

Run it against the live deployment (the file is parsed, never sourced —
sourcing would mangle the CHAT_OPENID_CONFIG JSON bash quote removal
destroys; PYSTINO_ENV names a different file when the checkout is elsewhere):

    PYSTINO_ENV=/home/ubuntu/workspace/Pystino/deploy/.env \
      /home/ubuntu/workspace/Pystino/.venv/bin/python scripts/test_nav_live.py
"""

import os
import re
import subprocess
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

ok = 0
fail = 0


def check(name, condition, detail=""):
    global ok, fail
    if condition:
        ok += 1
        print(f"  ok   {name}")
    else:
        fail += 1
        print(f"  FAIL {name}" + (f" — {detail}" if detail else ""))


def sign_in(client: httpx.Client, email: str, password: str) -> None:
    """Sign in through the house IdP (ADR 0068) with the local door (ADR 0043).

    There is no login form to post anymore — the console's login is a
    JavaScript SPA. Instead: POST the credentials as JSON to the gateway's
    local-login endpoint, which sets the management session cookie, then walk
    the chat's authorize round trip the cookie unlocks (chat 302s to
    /oauth/authorize with PKCE, the gateway mints a code for the session, the
    chat's callback exchanges it). One client jar holds both cookies because
    it is one origin.
    """
    r = client.post(f"{BASE}/auth/login", json={"email": email, "password": password})
    if r.status_code != 200:
        sys.exit(f"local login as {email} failed ({r.status_code}): {r.text[:200]}")
    # Per-request redirect following: the throwaway client below runs with
    # follow_redirects=False and this must not depend on the client's default.
    home = client.get(f"{CHAT}/", follow_redirects=True)
    if "login" in str(home.url).lower() or home.status_code != 200:
        sys.exit(f"the authorize round trip did not land in the chat: {home.url} ({home.status_code})")


with httpx.Client(follow_redirects=True, timeout=90) as c:
    sign_in(c, ADMIN_EMAIL, ADMIN_PASSWORD)
    print("signed in as", ADMIN_EMAIL)
    home = c.get(f"{CHAT}/").text

    print("\neverything is in the panel:")
    # Against the rendered text rather than the markup: a row with a count has
    # its label followed by a `<span>`, so matching on `>Label<` fails for
    # exactly the rows that have a badge.
    text = re.sub(r"<[^>]+>", " ", home)
    text = re.sub(r"\s+", " ", text)
    # Models, Knowledge and MCP Servers are not rows here any more: they are
    # tabs of the workspace page, which is one Workspace row.
    for label in ("Projects", "Chats", "Workspace", "Settings"):
        check(label, label in text, "not in the panel")

    print("\nthe row controls are actually visible:")
    check(
        "the Projects row offers New project",
        'aria-label="New project"' in home,
        "no add control on the Projects row",
    )
    # `opacity-0 group-hover:...` renders fine and paints never on a touch
    # screen, so it has to be asserted against rather than looked for.
    check(
        "nothing in the panel is hover-gated with opacity",
        "opacity-0" not in home,
        "a control is hidden until hover — invisible on any touch device",
    )

    print("\nthe two trees expand; the rows do not pretend to:")
    # Projects and Chats are branches, and so is each project folder under
    # Projects. The rows at the foot open dialogs and have nothing to reveal.
    check(
        "Projects and Chats carry aria-expanded",
        home.count("aria-expanded") >= 2,
        f'only {home.count("aria-expanded")} found',
    )

    print("\nthe person at the foot:")
    # The footer is static: the name, a theme switch and a sign-out button,
    # all inline. Nothing there opens a menu — but the page as a whole has
    # legitimate ones elsewhere (the project rows' "Manage" menu, the
    # composer's attachment and effort dropdowns), so the assertion is
    # scoped to the panel itself: the desktop <nav>, minus the row menus.
    # (RowMenu is always drawn so touch screens get Edit/Delete; the
    # composer's bits-ui triggers are outside the panel entirely. Note the
    # scoping has to name the desktop panel's own <nav> (*:w-[260px]): the
    # page carries a top bar nav and a mobile drawer nav too — the drawer
    # even shares max-h-dvh — and a first-match scope would pass vacuously
    # against one of those instead of the panel.)
    nav = re.search(r"<nav\b[^>]*260px[^>]*>.*?</nav>", home, re.S)
    check("the panel is present", nav is not None, "no panel nav element on the page")
    panel = re.sub(r'<button[^>]*aria-label="Manage [^"]*"[^>]*>', "", nav.group(0)) if nav else ""
    check(
        "the footer opens no menu",
        nav is not None and 'aria-haspopup="menu"' not in panel,
        "a popup affordance survived in the panel",
    )
    check(
        "the account label is shown",
        ADMIN_EMAIL in home,
        "the username is not in the panel",
    )
    check(
        "Settings is a panel row again",
        "/chat/settings/application" in home,
        "no settings row in the panel",
    )
    check(
        "the workspace row is a link to the workspace",
        "/chat/workspace" in home,
        "no workspace row in the panel",
    )
    print("\nsigning out, at both ends:")
    # A throwaway client, so the main one keeps its session for the rest.
    with httpx.Client(follow_redirects=False, timeout=60) as d:
        sign_in(d, ADMIN_EMAIL, ADMIN_PASSWORD)
        check(
            "signed in, the projects API answers",
            d.get(f"{CHAT}/api/v2/projects").status_code == 200,
        )

        out = d.post(f"{CHAT}/logout", headers={"origin": BASE})
        check("POST /logout redirects", out.status_code == 302, str(out.status_code))
        target = out.headers.get("location", "")
        check(
            "it redirects to the house IdP's end-session endpoint",
            "/oauth/end_session" in target,
            f"went to {target[:120]} — the provider session would survive",
        )
        check(
            "the local cookie is cleared on the way",
            any("Max-Age=0" in value for value in out.headers.get_list("set-cookie")),
            str(out.headers.get_list("set-cookie")),
        )

        # Follow the provider logout, as a browser would. It ends the gateway
        # session and comes back to `/chat/`, which is unauthenticated by then
        # and bounces to the login prompt — so a login page at the end is the
        # *proof*, not a fault.
        if target:
            hop = d.get(target, follow_redirects=True)
            landed = str(hop.url)
            check(
                "the provider hands the browser back, and it lands on a login prompt",
                "login" in landed,
                f"landed on {landed[:120]}",
            )

        # And now the real question: is the person signed out, including at the
        # provider? A still-live session would sign them back in here without
        # a prompt.
        back = d.get(f"{CHAT}/api/v2/projects", follow_redirects=True)
        signed_out = back.status_code != 200 or "login" in str(back.url).lower()
        check(
            "they are signed out, and stay signed out",
            signed_out,
            f"{back.status_code} at {back.url} — the provider signed them back in",
        )

    print("\na project's chat is listed once, under its project:")
    project = c.post(
        f"{CHAT}/api/v2/projects",
        json={"name": "Nav tree check", "instructions": "", "knowledgeBaseIds": []},
    ).json()
    models = c.get(f"{CHAT}/api/v2/models").text
    ids = [x for x in re.findall(r'"id":"([^"]+)"', models)]
    conv = c.post(
        f"{CHAT}/conversation", json={"model": ids[0], "projectId": project["id"]}
    ).json()["conversationId"]

    listed = c.get(f"{CHAT}/api/v2/conversations").text
    check(
        "the sidebar payload carries projectId",
        '"projectId"' in listed,
        "the flat list cannot tell project chats apart",
    )
    inside = c.get(f"{CHAT}/api/v2/projects/{project['id']}/conversations").json()["data"]
    check(
        "it appears under the project",
        any(x["id"] == conv for x in inside),
        str(inside)[:200],
    )

    models = c.get(f"{CHAT}/api/v2/models").text
    first = [x for x in re.findall(r'"id":"([^"]+)"', models)][0]

    print("\nthe per-model settings page is gone:")
    r = c.get(f"{CHAT}/settings/{first}")
    check(
        f"/settings/{first} is not served",
        r.status_code == 404,
        f"answered {r.status_code} — the route survived",
    )

    print("\nnothing links to it any more:")
    check(
        "the panel has no per-model settings link",
        f'href="/chat/settings/{first}"' not in home,
        "a link to the removed page is still rendered",
    )
    r = c.get(f"{CHAT}/settings/application")
    check("the settings screen itself still works", r.status_code == 200, str(r.status_code))
    check(
        "and its model list no longer links to the page",
        'href="/chat/settings/' not in r.text.replace('href="/chat/settings/application"', ""),
        "the settings nav still links per model",
    )

    print("\nthe manager is what ships:")
    # The workspace page renders the models manager server-side, so the markup
    # ships in the route's own chunks.
    for marker in ("Set as default", "Every model available to you", "is the default"):
        found = subprocess.run(
            [
                "docker", "exec", "llm-platform-chat-1", "sh", "-lc",
                f'grep -rl "{marker}" /app/build/client 2>/dev/null | head -1',
            ],
            capture_output=True,
            text=True,
        ).stdout.strip()
        check(f"“{marker}” is in the bundle", bool(found), "not in the built client")

    print("\ncapabilities cross from the gateway to the chat:")
    # The gateway's own answer, through the allowlisted forwarder.
    advertised = {
        entry["id"]: entry
        for entry in c.get(f"{CHAT}/api/v2/gateway/models").json()["data"]
    }
    tool_capable = [
        mid
        for mid, entry in advertised.items()
        if "tools" in [f.lower() for f in entry.get("supported_features") or []]
    ]
    check(
        "the gateway advertises tools on at least one model",
        len(tool_capable) > 0,
        "no model declares `tools` — the catalogue is empty, so this proves nothing",
    )

    # And what this app derived from it. superjson, so read the flags out of the
    # raw text rather than rebuilding the envelope.
    cards = c.get(f"{CHAT}/api/v2/models").text
    derived = {}
    for block in re.split(r'(?=\{"id":")', cards)[1:]:
        found = re.search(r'"id":"([^"]+)"', block)
        if not found:
            continue
        flag = re.search(r'"supportsTools":(true|false)', block)
        derived[found.group(1)] = flag.group(1) == "true" if flag else False

    mismatched = [
        mid for mid in tool_capable if mid in derived and derived[mid] is not True
    ]
    check(
        "a model the gateway says does tools is reported as doing tools",
        mismatched == [],
        f"{mismatched} — the chat is reading a capability shape the gateway does not send",
    )

    print("\nmanaging a project from its own row:")
    # What the `⋯` menu's two items do. Edit opens the overlay on the project,
    # which is a GET; Delete is this, and it must leave the conversation alone
    # — the confirmation promises exactly that.
    detail = c.get(f"{CHAT}/api/v2/projects/{project['id']}")
    check("Edit can open the project", detail.status_code == 200, str(detail.status_code))

    gone = c.delete(f"{CHAT}/api/v2/projects/{project['id']}")
    check("Delete removes it", gone.status_code == 204, str(gone.status_code))
    check(
        "and its conversation survives",
        c.get(f"{CHAT}/api/v2/conversations/{conv}").status_code == 200,
        "the chat went with the project",
    )

    c.delete(f"{CHAT}/api/v2/conversations/{conv}")
    print("  (cleaned up)")

print(f"\n{ok} ok, {fail} failed")
sys.exit(1 if fail else 0)
