"""JSON-schema validation of request bodies. Runs before any document work starts."""

from __future__ import annotations

from typing import Any

from jsonschema import Draft202012Validator
from jsonschema.exceptions import ValidationError

from .config import Limits
from .errors import InvalidRequest
from .spec import friendly

FORMATS = ("docx", "xlsx", "pptx")
EXT_FORMAT = {
    ".docx": "docx", ".docm": "docx", ".dotx": "docx", ".dotm": "docx",
    ".xlsx": "xlsx", ".xlsm": "xlsx", ".xltx": "xlsx", ".xltm": "xlsx",
    ".pptx": "pptx", ".pptm": "pptx", ".potx": "pptx", ".potm": "pptx", ".ppsx": "pptx", ".ppsm": "pptx",
}  # fmt: skip


def format_from_name(filename: str | None) -> str | None:
    if not filename:
        return None
    dot = filename.rfind(".")
    return EXT_FORMAT.get(filename[dot:].lower()) if dot >= 0 else None


def _envelope(limits: Limits) -> dict[str, Any]:
    return {
        "type": "object",
        "properties": {
            "format": {"enum": list(FORMATS)},
            "operations": {
                "type": "array",
                "minItems": 1,
                "maxItems": limits.max_operations,
                "items": {"type": "object"},
            },
            "track_changes": {"type": "boolean"},
            "author": {"type": "string", "minLength": 1, "maxLength": 120},
        },
        "required": ["operations"],
        "additionalProperties": False,
    }


def _where(err: ValidationError) -> str:
    path = ".".join(str(p) for p in err.absolute_path)
    return f"{path}: " if path else ""


def _first(validator: Draft202012Validator, instance: Any) -> ValidationError | None:
    errors = sorted(validator.iter_errors(instance), key=lambda e: list(map(str, e.absolute_path)))
    if not errors:
        return None
    from jsonschema.exceptions import best_match

    best: ValidationError | None = best_match(errors)
    return best or errors[0]


def validate_envelope(body: Any, limits: Limits) -> None:
    if not isinstance(body, dict):
        raise InvalidRequest("the body must be a JSON object", reason="schema")
    err = _first(Draft202012Validator(_envelope(limits)), body)
    if err is not None:
        raise InvalidRequest(f"invalid request body: {_where(err)}{friendly(err)}", reason="schema")


def validate_edit(fmt: str, body: Any, limits: Limits) -> None:
    """Validate the envelope and every operation against its schema; list what exists on a mistake."""
    from . import core

    validate_envelope(body, limits)
    engine = core.ENGINES[fmt]
    for i, op in enumerate(body["operations"]):
        name = op.get("op")
        if name not in engine.OPS:
            deferred = [d for d in engine.DEFERRED if d == name]
            hint = f" ({name} is planned but not implemented yet)" if deferred else ""
            raise InvalidRequest(
                f"operations[{i}]: unknown operation {name!r} for {fmt}{hint}; available: {sorted(engine.OPS)}",
                reason="unknown_operation",
                operation_index=i,
                details={"available": sorted(engine.OPS)},
            )
        schema = engine.OPS[name][0]
        err = _first(Draft202012Validator(schema), op)
        if err is not None:
            raise InvalidRequest(
                f"operations[{i}] ({name}): {_where(err)}{friendly(err)}",
                reason="schema",
                operation_index=i,
                details={
                    "schema": {k: v for k, v in schema["properties"].items() if k != "op"},
                    "required": schema["required"],
                },
            )


_READ_TARGETS = {
    "docx": {"type": "string", "pattern": r"^[pt][0-9]+$"},
    "xlsx": {
        "type": "object",
        "properties": {
            "sheet": {"type": "string", "minLength": 1},
            "range": {"type": "string", "pattern": r"^[A-Za-z]{1,3}[0-9]+(:[A-Za-z]{1,3}[0-9]+)?$"},
        },
        "required": ["sheet"],
        "additionalProperties": False,
    },
    "pptx": {
        "type": "object",
        "properties": {"slide": {"type": "integer", "minimum": 1}},
        "required": ["slide"],
        "additionalProperties": False,
    },
}


def validate_read(fmt: str, body: Any) -> None:
    schema = {
        "type": "object",
        "properties": {
            "format": {"enum": list(FORMATS)},
            "targets": {"type": "array", "minItems": 1, "maxItems": 200, "items": _READ_TARGETS[fmt]},
        },
        "required": ["targets"],
        "additionalProperties": False,
    }
    if not isinstance(body, dict):
        raise InvalidRequest("the body must be a JSON object", reason="schema")
    err = _first(Draft202012Validator(schema), body)
    if err is not None:
        raise InvalidRequest(
            f"invalid read request for {fmt}: {_where(err)}{friendly(err)}",
            reason="schema",
            details={"target_shape": _READ_TARGETS[fmt]},
        )
