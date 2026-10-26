"""The HTTP layer: authentication, size limits, multipart parsing, schema validation of the
envelope. It never parses a document; that happens in the worker subprocess."""

from __future__ import annotations

import asyncio
import base64
import hmac
import json
import logging
import secrets
from typing import Any

from starlette.applications import Starlette
from starlette.datastructures import UploadFile
from starlette.exceptions import HTTPException
from starlette.formparsers import MultiPartException
from starlette.requests import Request
from starlette.responses import JSONResponse, Response
from starlette.routing import Route
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from . import ENGINE, __version__
from .config import Settings
from .core import capabilities
from .errors import DocumentError, InvalidRequest, TooLarge, Unauthorized
from .runner import run_job
from .schemas import FORMATS, format_from_name, validate_envelope
from .spec import validate_envelope as validate_create_envelope

log = logging.getLogger("cerea_documents")
SECRET_HEADER = "x-cerea-documents-secret"  # noqa: S105 - a header name, not a secret
MEDIA_TYPES = {
    "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "pdf": "application/pdf",
}
MACRO_MEDIA = {
    ".docm": "application/vnd.ms-word.document.macroEnabled.12",
    ".xlsm": "application/vnd.ms-excel.sheet.macroEnabled.12",
    ".pptm": "application/vnd.ms-powerpoint.presentation.macroEnabled.12",
}


class BodyLimit:
    """ASGI middleware: refuse a request whose body exceeds the limit, before and while it streams."""

    def __init__(self, app: ASGIApp, max_bytes: int) -> None:
        self.app, self.max = app, max_bytes

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        declared = dict(scope["headers"]).get(b"content-length")
        if declared is not None and declared.isdigit() and int(declared) > self.max:
            await _too_large(self.max)(scope, receive, send)
            return
        seen = 0

        async def limited() -> Message:
            nonlocal seen
            msg = await receive()
            if msg["type"] == "http.request":
                seen += len(msg.get("body", b""))
                if seen > self.max:
                    raise TooLarge(f"the request is larger than the allowed {self.max} bytes", reason="request_size")
            return msg

        await self.app(scope, limited, send)


def _too_large(limit: int) -> JSONResponse:
    return JSONResponse(
        TooLarge(f"the request is larger than the allowed {limit} bytes", reason="request_size").to_dict(),
        status_code=413,
    )


def _json(exc: DocumentError) -> JSONResponse:
    return JSONResponse(exc.to_dict(), status_code=exc.status)


def create_app(settings: Settings | None = None) -> Starlette:
    st = settings or Settings.from_env()
    st.validate()
    limits = st.limits
    gate = asyncio.Semaphore(limits.max_concurrency)
    if not st.secret:
        log.warning("CEREA_DOCUMENTS_ALLOW_NO_AUTH is set: requests are NOT authenticated (development only)")

    def authenticate(request: Request) -> None:
        if not st.secret:
            return
        given = request.headers.get(SECRET_HEADER, "")
        if not hmac.compare_digest(given.encode("utf-8"), st.secret.encode("utf-8")):
            raise Unauthorized("missing or wrong shared secret")

    async def read_request(
        request: Request, need_body: bool, file_part: str = "required"
    ) -> tuple[bytes, str | None, dict[str, Any], dict[str, bytes]]:
        ctype = request.headers.get("content-type", "")
        if not ctype.lower().startswith("multipart/form-data"):
            raise InvalidRequest(
                "send multipart/form-data with a 'file' part (the document) and, where needed, a 'body' part (JSON)",
                reason="content_type",
            )
        try:
            form = await request.form(
                max_files=limits.max_images + 1, max_fields=8, max_part_size=limits.max_request_bytes
            )
        except (MultiPartException, HTTPException) as exc:
            bad = InvalidRequest(
                f"malformed or too large multipart request: {getattr(exc, 'message', None) or getattr(exc, 'detail', '')}",
                reason="multipart",
            )
            bad.status = 400
            raise bad from exc
        try:
            files = form.getlist("file")
            if file_part == "optional" and not files:
                data, name = b"", ""
            else:
                if len(files) != 1 or not isinstance(files[0], UploadFile):
                    raise InvalidRequest("send exactly one 'file' part holding the document", reason="file")
                data = await files[0].read()
                name = files[0].filename or ""
            raw = form.get("body")
            if raw is None:
                body: dict[str, Any] = {}
                if need_body:
                    raise InvalidRequest("a 'body' part (JSON) is required", reason="body")
            else:
                text = (await raw.read()).decode("utf-8", "strict") if isinstance(raw, UploadFile) else str(raw)
                if len(text.encode("utf-8")) > limits.max_body_bytes:
                    raise TooLarge(f"the JSON body is larger than {limits.max_body_bytes} bytes", reason="body_size")
                body = _loads(text)
            images: dict[str, bytes] = {}
            imgs = form.getlist("image")
            if len(imgs) > limits.max_images:
                raise InvalidRequest(f"at most {limits.max_images} images per request", reason="images")
            for im in imgs:
                if not isinstance(im, UploadFile) or not im.filename:
                    raise InvalidRequest(
                        "each 'image' part must be a file whose filename is the name the operations use",
                        reason="images",
                    )
                if im.filename in images:
                    raise InvalidRequest(f"two images are named {im.filename!r}", reason="images")
                images[im.filename] = await im.read()
        except UnicodeDecodeError as exc:
            raise InvalidRequest("the 'body' part is not valid UTF-8", reason="body") from exc
        finally:
            await form.close()
        return data, name, body, images

    def resolve_format(name: str | None, body: dict[str, Any]) -> str | None:
        fmt = body.get("format") if isinstance(body.get("format"), str) else None
        if fmt is not None and fmt not in FORMATS:
            raise InvalidRequest(f"format must be one of {list(FORMATS)}", reason="schema")
        return fmt or format_from_name(name)

    async def handle(request: Request, kind: str) -> Response:
        try:
            authenticate(request)
            creating = kind in ("create", "create_from_template")
            data, name, body, images = await read_request(
                request,
                kind != "outline",
                "optional" if kind == "create" else "required",
            )
            if creating:
                validate_create_envelope(body, limits, template=kind == "create_from_template")
                fmt = resolve_format(name, body) if kind == "create_from_template" else body["format"]
            else:
                fmt = resolve_format(name, body)
            if kind == "edit":
                validate_envelope(body, limits)
                if fmt is None:
                    raise InvalidRequest(
                        "cannot tell the document type: send the file with a .docx, .xlsx or .pptx name, or set 'format' in the body",
                        reason="format",
                    )
            async with gate:
                res = await run_job(
                    kind, data, filename_format=fmt, body=body, images=images, limits=limits, tmpdir=st.tmpdir
                )
            if kind not in ("edit", "create", "create_from_template"):
                return JSONResponse(res.result)
            assert res.file is not None
            out_name = name or "document"
            if kind == "create":
                out_name = _created_name(body.get("file_name"), body["format"])
            return _edit_response(request, res.result, res.file, out_name)
        except DocumentError as exc:
            if exc.status >= 500:
                log.error("request failed: %s", exc.message)
            return _json(exc)

    async def healthz(_: Request) -> Response:
        return JSONResponse({"status": "ok", "version": __version__})

    async def caps(request: Request) -> Response:
        try:
            authenticate(request)
        except DocumentError as exc:
            return _json(exc)
        return JSONResponse({**capabilities(), "limits": limits.to_dict()})

    def endpoint(kind: str) -> Any:
        async def view(request: Request) -> Response:
            return await handle(request, kind)

        return view

    app = Starlette(
        routes=[
            Route("/healthz", healthz, methods=["GET"]),
            Route("/v1/capabilities", caps, methods=["GET"]),
            Route("/v1/outline", endpoint("outline"), methods=["POST"]),
            Route("/v1/read", endpoint("read"), methods=["POST"]),
            Route("/v1/edit", endpoint("edit"), methods=["POST"]),
            Route("/v1/create", endpoint("create"), methods=["POST"]),
            Route("/v1/create_from_template", endpoint("create_from_template"), methods=["POST"]),
        ]
    )
    app.add_middleware(BodyLimit, max_bytes=limits.max_request_bytes)
    return app


def _loads(text: str) -> dict[str, Any]:
    def refuse(const: str) -> Any:
        raise ValueError(f"{const} is not valid JSON")

    try:
        value = json.loads(text, parse_constant=refuse)
    except RecursionError as exc:
        raise InvalidRequest("the 'body' part is nested too deeply", reason="too_deep") from exc
    except ValueError as exc:
        raise InvalidRequest(f"the 'body' part is not valid JSON: {exc}", reason="body") from exc
    if not isinstance(value, dict):
        raise InvalidRequest("the 'body' part must be a JSON object", reason="body")
    return value


def _edit_response(request: Request, result: dict[str, Any], file: bytes, name: str) -> Response:
    dot = name.rfind(".")
    ext = name[dot:].lower() if dot >= 0 else ""
    ctype = MACRO_MEDIA.get(ext) or MEDIA_TYPES[result["format"]]
    result = {**result, "file_name": name, "content_type": ctype, "file_bytes": len(file)}
    accept = request.headers.get("accept", "")
    if request.query_params.get("response") == "json" or "application/json" in accept:
        return JSONResponse({**result, "file_base64": base64.b64encode(file).decode("ascii")})
    boundary = secrets.token_hex(16)
    head = (
        (
            f'--{boundary}\r\nContent-Disposition: form-data; name="result"\r\nContent-Type: application/json\r\n\r\n'
        ).encode()
        + json.dumps(result).encode()
        + (
            f'\r\n--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{_safe_name(name)}"\r\n'
            f"Content-Type: {ctype}\r\n\r\n"
        ).encode()
    )
    return Response(
        head + file + f"\r\n--{boundary}--\r\n".encode(), media_type=f"multipart/form-data; boundary={boundary}"
    )


def _created_name(requested: Any, fmt: str) -> str:
    base = _safe_name(str(requested)) if requested else "document"
    return base if base.lower().endswith("." + fmt) else f"{base.rsplit('.', 1)[0] if '.' in base else base}.{fmt}"


def _safe_name(name: str) -> str:
    return "".join(c if c.isalnum() or c in "._- " else "_" for c in name)[:200] or "document"


_ = ENGINE
