#!/usr/bin/env python3
"""Attaching a document to a message, end to end (ADR 0055, ADR 0062).

A PDF or a `.docx` is bytes no model reads. The gateway's `POST /v1/ocr` turns
one into markdown — with this deployment's own extractor, or an upstream OCR
model if one is named — and the chat does that **once, at upload**, storing the
text beside the file. This checks the whole path against a running stack:

* a real `.docx` is accepted, extracted, and its text reaches the model;
* the extraction is **not repeated** on the second turn about the same file,
  which is the property that matters because `/v1/ocr` is priced per page;
* a document whose text cannot be read still uploads, and the model is told so
  rather than being handed nothing.

The count of extractions is read from the gateway's own ledger, which is the
only place that can distinguish "extracted once" from "extracted per turn".

Run it with the deployment's variables sourced:

    set -a; . deploy/.env; set +a
    ./scripts/test_attachments_live.py
"""

import base64
import os
import re
import subprocess
import sys
import zipfile
from io import BytesIO
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


def ocr_rows() -> int:
    """How many OCR requests the gateway has billed.

    Read from the ledger through the database rather than an API, because the
    point is to count what the *gateway* recorded — a client-side count would
    only prove what the client believes it asked for.
    """
    sql = (
        "select count(*) from usage_records u join models m on m.id = u.model_id "
        "where m.kind = 'ocr';"
    )
    out = subprocess.run(
        [
            "docker", "exec", "llm-platform-postgres-1",
            "psql", "-U", env.get("POSTGRES_USER", "gateway"),
            "-d", env.get("POSTGRES_DB", "gateway"),
            "-tAc", sql,
        ],
        capture_output=True,
        text=True,
        check=True,
    )
    return int(out.stdout.strip() or 0)


def a_docx(paragraphs: list[str]) -> bytes:
    """The smallest thing markitdown reads as a Word document.

    Built here rather than committed as a fixture: a binary in the repository
    for a test that needs three sentences of text is a binary somebody has to
    trust, and this is twenty lines of the format's actual shape.
    """
    body = "".join(
        f"<w:p><w:r><w:t>{text}</w:t></w:r></w:p>" for text in paragraphs
    )
    document = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
        f"<w:body>{body}</w:body></w:document>"
    )
    content_types = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        '<Default Extension="xml" ContentType="application/xml"/>'
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
        "</Types>"
    )
    rels = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
        "</Relationships>"
    )
    buffer = BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml", content_types)
        archive.writestr("_rels/.rels", rels)
        archive.writestr("word/document.xml", document)
    return buffer.getvalue()


DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
MARKER = "PERSIMMON is the codeword for the third quarter forecast."


def login(client: httpx.Client) -> None:
    r = client.get(f"{CHAT}/projects")
    m = re.search(r'action="([^"]+)"', r.text)
    if not m:
        sys.exit(f"no login form at {CHAT}/projects (status {r.status_code})")
    r = client.post(
        m.group(1).replace("&amp;", "&"),
        data={
            "username": env["KEYCLOAK_TEST_USER"],
            "password": env["KEYCLOAK_TEST_PASSWORD"],
            "credentialId": "",
        },
    )
    if "/chat/" not in str(r.url):
        sys.exit(f"login did not land in the chat: {r.url}")


def turn(
    client: httpx.Client,
    conv: str,
    text: str,
    attachments: list[tuple[str, str, str]],
) -> httpx.Response:
    """One turn. `attachments` are (name, mime, base64) triples.

    They are separate `files` parts rather than a field inside `data`, and each
    part's *filename* carries the kind and the real name as `base64;<name>` —
    which is the route's own convention, not this script's invention.
    """
    loaded = client.get(f"{CHAT}/api/v2/conversations/{conv}").text
    root = re.search(r'"rootMessageId":"([0-9a-f-]{36})"', loaded)
    # The newest message is what a follow-up hangs off; for the first turn that
    # is the system message at the root.
    ids = re.findall(r'"id":"([0-9a-f-]{36})"', loaded)
    parent = ids[-1] if len(ids) > 1 else (root.group(1) if root else None)
    parts: list[tuple[str, tuple]] = [
        (
            "data",
            (
                None,
                json_dumps(
                    {
                        "inputs": text,
                        "is_retry": False,
                        **({"id": parent} if parent else {}),
                    }
                ),
            ),
        )
    ]
    for name, mime, payload in attachments:
        parts.append(("files", (f"base64;{name}", payload, mime)))
    return client.post(
        f"{CHAT}/conversation/{conv}", files=parts, headers={"origin": BASE}
    )


with httpx.Client(verify=False, follow_redirects=True, timeout=180) as c:
    login(c)
    print("signed in as", env["KEYCLOAK_TEST_USER"])

    models = c.get(f"{CHAT}/api/v2/models").text
    ids = [m for m in re.findall(r'"id":"([^"]+)"', models) if not m.startswith("agent:")]
    if not ids:
        sys.exit("no models available to this account")
    model = ids[0]

    # -- a document that has text ----------------------------------------
    print("\na .docx with text in it")
    before = ocr_rows()
    conv = c.post(f"{CHAT}/conversation", json={"model": model}).json()["conversationId"]

    payload = base64.b64encode(a_docx([MARKER, "It is not to be shared."])).decode()
    r = turn(
        c,
        conv,
        "What is the codeword in the attached document?",
        [("forecast.docx", DOCX_MIME, payload)],
    )
    check("the turn ran", r.status_code == 200, r.text[:300])
    check("it was not refused", '"status":"error"' not in r.text, r.text[:400])

    after_first = ocr_rows()
    check(
        "the document was extracted exactly once",
        after_first == before + 1,
        f"ledger went {before} -> {after_first}",
    )

    sent = httpx.get("http://127.0.0.1:8081/_last_request", timeout=30).json()
    prompt = json_dumps(sent)
    check(
        "the extracted text reached the model",
        "PERSIMMON" in prompt,
        f"the prompt did not carry it: {prompt[:300]}",
    )
    check(
        "the document bytes did not",
        DOCX_MIME not in prompt,
        "a base64 .docx is in the prompt, which no model can read",
    )

    # -- the second turn must not extract again --------------------------
    print("\nasking again about the same file")
    r = turn(c, conv, "And what quarter was that about?", [])
    check("the follow-up ran", r.status_code == 200, r.text[:200])
    after_second = ocr_rows()
    check(
        "extraction was not repeated",
        after_second == after_first,
        f"ledger went {after_first} -> {after_second}: it is billed per page, per turn",
    )
    sent = json_dumps(httpx.get("http://127.0.0.1:8081/_last_request", timeout=30).json())
    check(
        "the text is still in the prompt on the follow-up",
        "PERSIMMON" in sent,
        "the document dropped out of the history",
    )

    # -- a document with nothing to read ---------------------------------
    print("\na document with no text")
    empty = base64.b64encode(a_docx([])).decode()
    r = turn(
        c,
        conv,
        "What does this one say?",
        [("blank.docx", DOCX_MIME, empty)],
    )
    check("the upload was not refused", r.status_code == 200, r.text[:200])
    sent = json_dumps(httpx.get("http://127.0.0.1:8081/_last_request", timeout=30).json())
    check(
        "the model was told there was no text",
        "No text could be read" in sent,
        "an unreadable document was dropped silently instead",
    )

    c.delete(f"{CHAT}/api/v2/conversations/{conv}")

print(f"\n{ok} ok, {fail} failed")
sys.exit(1 if fail else 0)
