"""Errors the service raises. Every one maps to an HTTP status and a stable code."""

from __future__ import annotations

from typing import Any


class DocumentError(Exception):
    """Base of every refusal. `code` is stable and machine-readable; the message is for a person."""

    status = 422
    code = "invalid_request"

    def __init__(
        self,
        message: str,
        *,
        reason: str | None = None,
        details: dict[str, Any] | None = None,
        operation_index: int | None = None,
    ) -> None:
        super().__init__(message)
        self.message = message
        self.reason = reason
        self.details = details or {}
        self.operation_index = operation_index

    def to_dict(self) -> dict[str, Any]:
        err: dict[str, Any] = {"code": self.code, "message": self.message}
        if self.reason:
            err["reason"] = self.reason
        if self.operation_index is not None:
            err["operation_index"] = self.operation_index
        if self.details:
            err["details"] = self.details
        return {"error": err}


class InvalidRequest(DocumentError):
    """The request body, an operation or a parameter does not match the schema."""

    status = 422
    code = "invalid_request"


class PatchError(DocumentError):
    """An operation cannot be applied to this document (a missing id, a merged cell, ...)."""

    status = 422
    code = "operation_failed"


class InvalidDocument(DocumentError):
    """The file is not a sound Office package (not a zip, a part is malformed, ...)."""

    status = 422
    code = "invalid_document"


class UnsafeDocument(DocumentError):
    """The file trips a hardening rule (zip bomb, DOCTYPE, path traversal, ...)."""

    status = 422
    code = "unsafe_document"


class UnsupportedFormat(DocumentError):
    status = 415
    code = "unsupported_format"


class TooLarge(DocumentError):
    status = 413
    code = "too_large"


class ResourceLimit(DocumentError):
    """The request needed more memory or output than the limits allow."""

    status = 413
    code = "resource_limit"


class TimeLimit(DocumentError):
    status = 504
    code = "time_limit"


class Unauthorized(DocumentError):
    status = 401
    code = "unauthorized"


class ConfigError(Exception):
    """The service is misconfigured and refuses to start."""
