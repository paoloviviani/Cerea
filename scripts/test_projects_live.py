#!/usr/bin/env python3
"""Projects, end to end against the running stack (ADR 0062).

Signs in through the identity provider, creates a project with standing
instructions and a knowledge base, starts a chat inside it, sends a turn, and
then checks the two things that are only observable against a live stack:

* the project's standing context **and a retrieved passage** were in the prompt
  the gateway sent upstream — asserted against the smoke upstream's recorded
  request, because the echo only carries the last *user* message and a
  project's context is a system message;
* the finished exchange was written into the project's own memory base and is
  retrievable from it.

Three things this found that no unit test could:

* the chat's model catalogue is built **once at startup with the deployment's
  own key**, so it is the same list for everybody;
* a turn is a **multipart** post with the JSON in a `data` field, and a native
  form content type needs an `Origin` header past the CSRF guard;
* a first user message still needs its parent message id — the conversation is
  created with a system message at its root.

Run it with the deployment's own variables sourced, so it reaches the same
origin the session cookie is scoped to:

    set -a; . deploy/.env; set +a
    ./scripts/test_projects_live.py
"""

import os
import re
import sys
import time
from json import dumps as json_dumps

import httpx

ENV_PATH = os.environ.get("PYSTINO_ENV", "/home/ubuntu/pystino/deploy/.env")

env = {}
for line in open(ENV_PATH):
    line = line.strip()
    if line and not line.startswith("#") and "=" in line:
        k, v = line.split("=", 1)
        env[k] = v.strip().strip('"').strip("'")

BASE = f"https://{env['PUBLIC_HOST']}:{env['HTTPS_PORT']}"
CHAT = f"{BASE}/chat"

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


def login(client: httpx.Client) -> None:
    r = client.get(f"{CHAT}/projects")
    m = re.search(r'action="([^"]+)"', r.text)
    if not m:
        sys.exit(f"no Keycloak login form at {CHAT}/projects (status {r.status_code})")
    r = client.post(
        m.group(1).replace("&amp;", "&"),
        data={
            "username": env["KEYCLOAK_TEST_USER"],
            "password": env["KEYCLOAK_TEST_PASSWORD"],
            "credentialId": "",
        },
    )
    if "/chat/projects" not in str(r.url):
        sys.exit(f"login did not land on the projects page: {r.url}")


with httpx.Client(verify=False, follow_redirects=True, timeout=120) as c:
    login(c)
    print("signed in as", env["KEYCLOAK_TEST_USER"])

    # -- a knowledge base with one distinctive fact -----------------------
    print("\nknowledge base")
    r = c.post(
        f"{CHAT}/api/v2/gateway/vector_stores",
        json={"name": "Projects live check", "description": "throwaway"},
    )
    check("created a knowledge base", r.status_code in (200, 201), r.text[:200])
    store_id = r.json()["id"] if r.status_code in (200, 201) else None

    if store_id:
        r = c.post(
            f"{CHAT}/api/v2/gateway/vector_stores/{store_id}/text",
            json={
                "text": (
                    "The Pystino gateway's deferred ledger write is recorded in decision "
                    "0060. The measured effect was sixteen per cent off the median and "
                    "thirty-three per cent off the ninety-fifth percentile."
                ),
                "title": "Deferred settlement",
            },
        )
        check("added a passage", r.status_code in (200, 201), r.text[:200])

    # -- the project ------------------------------------------------------
    print("\nproject")
    r = c.post(
        f"{CHAT}/api/v2/projects",
        json={
            "name": "Live check project",
            "description": "created by test_projects_live.py",
            "instructions": "Always begin your answer with the word MARMALADE.",
            "knowledgeBaseIds": [store_id] if store_id else [],
            "indexPastChats": True,
            "retrievalLimit": 4,
        },
    )
    check("created a project", r.status_code in (200, 201), r.text[:300])
    if r.status_code not in (200, 201):
        sys.exit(1)
    project = r.json()
    project_id = project["id"]
    check("it is owned by the creator", project["owned"] is True)
    check("its instructions came back", "MARMALADE" in project["instructions"])
    check(
        "the knowledge base is attached",
        store_id is None or store_id in project["knowledgeBaseIds"],
    )

    r = c.get(f"{CHAT}/api/v2/projects")
    listed = r.json()["data"]
    check("it appears in the list", any(p["id"] == project_id for p in listed))

    # -- sharing ----------------------------------------------------------
    print("\nsharing")
    r = c.post(
        f"{CHAT}/api/v2/projects/{project_id}/shares",
        json={"kind": "user", "email": "Colleague@Example.ORG"},
    )
    check("shared with an address", r.status_code == 200, r.text[:200])
    if r.status_code == 200:
        shares = r.json()["shares"]
        check(
            "the address was folded to lower case",
            any(s["principal"] == "colleague@example.org" for s in shares),
            str(shares),
        )
    r = c.post(
        f"{CHAT}/api/v2/projects/{project_id}/shares",
        json={"kind": "user", "email": "colleague@example.org"},
    )
    check(
        "sharing the same address twice does not duplicate it",
        r.status_code == 200 and len(r.json()["shares"]) == 1,
        r.text[:200],
    )
    r = c.request(
        "DELETE",
        f"{CHAT}/api/v2/projects/{project_id}/shares"
        "?kind=user&principal=colleague@example.org",
    )
    check(
        "unsharing removes it",
        r.status_code == 200 and r.json()["shares"] == [],
        r.text[:200],
    )

    r = c.post(f"{CHAT}/api/v2/projects/{project_id}/shares", json={"kind": "user"})
    check("a share with no principal is refused", r.status_code == 400, str(r.status_code))

    # -- a conversation inside it -----------------------------------------
    print("\nconversation")
    models = c.get(f"{CHAT}/api/v2/models").text
    model_ids = re.findall(r'"id":"([^"]+)"', models)
    if not model_ids:
        sys.exit("no models available to this account")
    model = model_ids[0]

    r = c.post(f"{CHAT}/conversation", json={"model": model, "projectId": project_id})
    check("started a chat in the project", r.status_code == 200, r.text[:300])
    conv_id = r.json()["conversationId"] if r.status_code == 200 else None

    r = c.post(
        f"{CHAT}/conversation",
        json={"model": model, "projectId": "64b8f0000000000000000000"},
    )
    check(
        "a project you cannot see is refused, not silently dropped",
        r.status_code in (403, 404),
        str(r.status_code),
    )

    if conv_id:
        r = c.get(f"{CHAT}/api/v2/projects/{project_id}/conversations")
        check(
            "it is listed on the project",
            r.status_code == 200 and any(x["id"] == conv_id for x in r.json()["data"]),
            r.text[:200],
        )

        # -- the turn, and what the model was actually given ---------------
        print("\ngeneration")
        # The parent to append to: the system message the create put at the
        # root. `addChildren` refuses to guess one, which is right — a tree
        # with two roots has no defined order.
        loaded = c.get(f"{CHAT}/api/v2/conversations/{conv_id}").text
        root = re.search(r'"rootMessageId":"([0-9a-f-]{36})"', loaded)
        if not root:
            root = re.search(r'"id":"([0-9a-f-]{36})"', loaded)
        parent_id = root.group(1) if root else None
        # multipart with the JSON in a `data` field: what the route reads.
        r = c.post(
            f"{CHAT}/conversation/{conv_id}",
            files={
                "data": (
                    None,
                    json_dumps(
                        {
                            "inputs": (
                                "What does decision 0060 say about the deferred "
                                "ledger write?"
                            ),
                            "is_retry": False,
                            **({"id": parent_id} if parent_id else {}),
                        }
                    ),
                )
            },
            headers={"origin": BASE},
        )
        body = r.text
        check("the turn ran", r.status_code == 200, f"{r.status_code}: {body[:300]}")
        check(
            "it was not refused upstream",
            '"status":"error"' not in body,
            body[:300],
        )

        # -- the memory base ----------------------------------------------
        print("\nproject memory")
        memory_id = None
        for _ in range(20):
            time.sleep(1.5)
            stores = c.get(f"{CHAT}/api/v2/gateway/vector_stores").json()["data"]
            match = [s for s in stores if s["name"].startswith("Live check project")]
            if match:
                memory_id = match[0]["id"]
                if match[0]["file_counts"]["completed"] >= 1:
                    break
        check("a memory base was created for the project", memory_id is not None)
        if memory_id:
            docs = c.get(f"{CHAT}/api/v2/gateway/vector_stores/{memory_id}").json()
            check(
                "the exchange was indexed into it",
                docs["file_counts"]["total"] >= 1,
                str(docs["file_counts"]),
            )
            r = c.post(
                f"{CHAT}/api/v2/gateway/vector_stores/{memory_id}/search",
                json={"query": "deferred ledger write", "max_num_results": 3},
            )
            check(
                "the transcript is retrievable",
                r.status_code == 200 and len(r.json()["data"]) >= 1,
                r.text[:200],
            )

    # -- what actually left the gateway -----------------------------------
    #
    # A second project, with `indexPastChats` off, so the completion is the
    # last thing the upstream records: with indexing on, the transcript's
    # embedding overwrites it before this can be read.
    print("\nthe prompt the upstream received")
    r = c.post(
        f"{CHAT}/api/v2/projects",
        json={
            "name": "Live check prompt",
            "instructions": "Always begin your answer with the word MARMALADE.",
            "knowledgeBaseIds": [store_id] if store_id else [],
            "indexPastChats": False,
            "retrievalLimit": 4,
        },
    )
    check("created a project with indexing off", r.status_code in (200, 201), r.text[:200])
    quiet_id = r.json()["id"] if r.status_code in (200, 201) else None

    if quiet_id:
        r = c.post(f"{CHAT}/conversation", json={"model": model, "projectId": quiet_id})
        quiet_conv = r.json()["conversationId"] if r.status_code == 200 else None
        loaded = c.get(f"{CHAT}/api/v2/conversations/{quiet_conv}").text
        root = re.search(r'"rootMessageId":"([0-9a-f-]{36})"', loaded)
        r = c.post(
            f"{CHAT}/conversation/{quiet_conv}",
            files={
                "data": (
                    None,
                    json_dumps(
                        {
                            "inputs": (
                                "What does decision 0060 say about the deferred "
                                "ledger write?"
                            ),
                            "is_retry": False,
                            **({"id": root.group(1)} if root else {}),
                        }
                    ),
                )
            },
            headers={"origin": BASE},
        )
        check("the turn ran", r.status_code == 200, r.text[:200])

        sent = httpx.get("http://127.0.0.1:8081/_last_request", timeout=30).json()
        system = " ".join(
            m.get("content") or ""
            for m in sent.get("messages", [])
            if m.get("role") == "system"
        )
        check(
            "the upstream received a chat completion, not an embedding",
            "messages" in sent,
            str(sent)[:200],
        )
        check(
            "the project's instructions reached the model",
            "MARMALADE" in system,
            f"system prompt was: {system[:200]!r}",
        )
        check(
            "a retrieved passage reached the model",
            "Deferred settlement" in system or "thirty-three per cent" in system,
            f"system prompt was: {system[:400]!r}",
        )
        c.delete(f"{CHAT}/api/v2/projects/{quiet_id}")

    # -- cleanup ----------------------------------------------------------
    print("\ncleanup")
    r = c.delete(f"{CHAT}/api/v2/projects/{project_id}")
    check("deleted the project", r.status_code == 204, str(r.status_code))
    r = c.get(f"{CHAT}/api/v2/projects/{project_id}")
    check("it is gone", r.status_code == 404, str(r.status_code))
    if conv_id:
        r = c.get(f"{CHAT}/api/v2/conversations/{conv_id}")
        check(
            "its conversation survives the project's deletion",
            r.status_code == 200,
            str(r.status_code),
        )
        c.delete(f"{CHAT}/api/v2/conversations/{conv_id}")

    # The bases this run made, including the memory base the project created on
    # demand. Deleting the project does not delete them — that is deliberate
    # (they are gateway resources with their own owner), which is exactly why a
    # check that makes them has to clean them up itself.
    for store in c.get(f"{CHAT}/api/v2/gateway/vector_stores").json()["data"]:
        if store["name"].startswith(("Projects live check", "Live check project")):
            c.delete(f"{CHAT}/api/v2/gateway/vector_stores/{store['id']}")
    remaining = [
        store["name"]
        for store in c.get(f"{CHAT}/api/v2/gateway/vector_stores").json()["data"]
        if store["name"].startswith(("Projects live check", "Live check project"))
    ]
    check("the run left no knowledge bases behind", remaining == [], str(remaining))

print(f"\n{ok} ok, {fail} failed")
sys.exit(1 if fail else 0)
