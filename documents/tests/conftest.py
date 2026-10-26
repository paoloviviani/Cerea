from __future__ import annotations

import email
import json
from collections.abc import Iterator
from dataclasses import replace
from email.message import Message
from typing import Any, cast

import httpx
import pytest
from starlette.testclient import TestClient

from cerea_documents.api import create_app
from cerea_documents.config import Limits, Settings

SECRET = "test-secret-value"
AUTH = {"X-Cerea-Documents-Secret": SECRET}


def make_client(**limit_overrides: int) -> TestClient:
    limits = replace(Limits(), **{"worker_wall_seconds": 60, **limit_overrides})
    return TestClient(create_app(Settings(secret=SECRET, limits=limits)), raise_server_exceptions=True)


@pytest.fixture(scope="session")
def client() -> Iterator[TestClient]:
    with make_client() as c:
        yield c


def post(
    c: TestClient,
    path: str,
    name: str,
    data: bytes,
    body: dict[str, Any] | None = None,
    images: dict[str, bytes] | None = None,
    **kw: Any,
) -> httpx.Response:
    files: list[Any] = [("file", (name, data, "application/octet-stream"))]
    for n, b in (images or {}).items():
        files.append(("image", (n, b, "application/octet-stream")))
    form = {"body": json.dumps(body)} if body is not None else {}
    return c.post(path, files=files, data=form, headers=AUTH, **kw)


def parse_multipart(resp: httpx.Response) -> tuple[dict[str, Any], bytes]:
    """(the 'result' JSON, the 'file' bytes) of an edit response."""
    msg = email.message_from_bytes(
        b"Content-Type: " + resp.headers["content-type"].encode() + b"\r\n\r\n" + resp.content
    )
    result: dict[str, Any] = {}
    file = b""
    for part in cast("list[Message]", msg.get_payload()):
        name = part.get_param("name", header="content-disposition")
        payload = cast("bytes", part.get_payload(decode=True))
        if name == "result":
            result = json.loads(payload)
        elif name == "file":
            file = payload
    return result, file
