"""Creation (ADR 0103 step 3): `create` builds a file from a spec, `create_from_template` fills a template
the person uploaded. Both run inside the sandboxed worker, validate before building, are all-or-none, and
verify the file they made."""

from __future__ import annotations

import re
from typing import Any

from . import ENGINE, excel, powerpoint, word
from .config import Limits
from .core import ENGINES, _edit, _images, _structure_errors, detect_format, passed_through
from .errors import InvalidDocument, InvalidRequest, PatchError, UnsafeDocument
from .images_ref import ImageSet
from .pkg import Pkg
from .spec import validate_envelope, validate_spec
from .theme import resolve_theme
from .verify import verify_created

PLACEHOLDER = re.compile(r"\{\{\s*([^{}]+?)\s*\}\}")
EMU_CM = 360_000


def _check_template(data: bytes, fmt: str, limits: Limits) -> None:
    """The template is hostile input like any file: package checks, the right type, and no active content."""
    pkg = Pkg(data, limits)
    found = detect_format(pkg)
    if found != fmt:
        raise InvalidRequest(f"the template is a {found} file but a {fmt} was asked for", reason="template_format")
    active = passed_through(pkg)
    if active:
        raise UnsafeDocument(
            "the template contains macros, ActiveX or embedded OLE objects ("
            + ", ".join(active[:3])
            + "); created files never carry active content. Save the template as a plain .docx, .xlsx or .pptx first.",
            reason="active_content",
            details={"parts": active[:10]},
        )


def _outline_summary(fmt: str, data: bytes, limits: Limits, spec: dict[str, Any]) -> dict[str, Any]:
    """What was written, as a short outline the model can quote back."""
    if fmt == "pdf":
        return {"headings": [_plain(b) for b in spec["blocks"] if b["type"] == "heading"][:60]}
    full = ENGINES[fmt].outline(Pkg(data, limits))
    if fmt == "docx":
        blocks = [
            {k: v for k, v in b.items() if k in ("id", "type", "level", "rows", "cols")}
            | ({"text": b["text"][:70]} if b.get("text") else {})
            for b in full["blocks"]
        ]
        out: dict[str, Any] = {"blocks": blocks[:80], "images": len(full["images"])}
        if len(blocks) > 80:
            out["blocks_not_shown"] = len(blocks) - 80
        return out
    if fmt == "xlsx":
        return {
            "sheets": [{k: v for k, v in s.items() if k not in ("part", "sheet_id", "state")} for s in full["sheets"]]
        }
    slides = []
    for s in full["slides"]:
        title = next(
            (
                " ".join(x["text"])
                for x in s["shapes"]
                if x.get("placeholder", {}).get("type") in ("title", "ctrTitle") and x.get("text")
            ),
            "",
        )
        kinds: dict[str, int] = {}
        for x in s["shapes"]:
            kinds[x["kind"]] = kinds.get(x["kind"], 0) + 1
        slides.append({"index": s["index"], "layout": s["layout"], "title": title[:70], "shapes": kinds})
    return {"slides": slides}


def _plain(b: dict[str, Any]) -> str:
    return "".join(r["text"] for r in b["runs"]) if "runs" in b else str(b.get("text", ""))


def create(
    body: dict[str, Any], template: bytes | None, raw_images: dict[str, bytes], limits: Limits
) -> tuple[dict[str, Any], bytes]:
    validate_envelope(body, limits)
    fmt = body["format"]
    spec = validate_spec(fmt, body["spec"], limits)
    theme = resolve_theme(spec.get("theme"))
    if theme.template is not None:
        if not template:
            raise InvalidRequest(
                f"spec.theme.template names {theme.template!r} but no template file came with the request",
                reason="template",
            )
        _check_template(template, fmt, limits)
    elif template:
        raise InvalidRequest("a template file was sent but spec.theme.template is not set", reason="template")
    images = _images(raw_images, limits)
    try:
        try:
            data, extra = _build(fmt, spec, images, theme, template)
        except (KeyError, ValueError, AttributeError, TypeError, IndexError) as exc:
            if template is None:
                raise  # a fault in the builder is an internal error, never blamed on the person's spec
            raise InvalidDocument(
                f"the template could not be used ({type(exc).__name__}: {str(exc)[:160]}); "
                "check that it opens in Word, Excel or PowerPoint, or use the built-in style",
                reason="template",
            ) from exc
    except PatchError as exc:  # a missing image and the like: a problem with the request, not with a document
        raise InvalidRequest(exc.message, reason="spec", details=exc.details) from exc
    verify = verify_created(data, limits, fmt)
    report: dict[str, Any] = {
        "format": fmt,
        "engine": ENGINE,
        "outline": _outline_summary(fmt, data, limits, spec),
        "verify": verify,
        "styled_from": "template" if theme.template else "built-in",
        **{k: v for k, v in extra.items() if v},
    }
    report["charts"] = extra.get("charts", [])
    return report, data


def _build(
    fmt: str, spec: dict[str, Any], images: ImageSet, theme: Any, template: bytes | None
) -> tuple[bytes, dict[str, Any]]:
    if fmt == "docx":
        from .make_docx import build_docx

        return build_docx(spec, images, theme, template)
    if fmt == "xlsx":
        from .make_xlsx import build_xlsx

        return build_xlsx(spec, images, theme, template)
    if fmt == "pptx":
        from .make_pptx import build_pptx

        return build_pptx(spec, images, theme, template)
    from .make_pdf import build_pdf

    return build_pdf(spec, images, theme)


# ---- templates ----------------------------------------------------------------------------------


def create_from_template(
    body: dict[str, Any], template: bytes, filename_format: str | None, raw_images: dict[str, bytes], limits: Limits
) -> tuple[dict[str, Any], bytes]:
    with _structure_errors():
        validate_envelope(body, limits, template=True)
        pkg = Pkg(template, limits)
        fmt = detect_format(pkg, body.get("format") or filename_format)
        _check_template(template, fmt, limits)
        values: dict[str, Any] = body["values"]
        ops, info = {"docx": _docx_ops, "pptx": _pptx_ops, "xlsx": _xlsx_ops}[fmt](pkg, values)
        report, out = _edit(template, fmt, {"operations": ops}, raw_images, limits)
        from .determinism import fix_zip

        out = fix_zip(out, core_part=None)
        report.pop("operations", None)
        return {**report, **info, "engine": ENGINE, "styled_from": "template"}, out


def _keys_error(kind: str, given: list[str], have: list[str]) -> InvalidRequest:
    return InvalidRequest(
        f"the template has no {kind} named {sorted(given)}; it has: {sorted(have) or 'none'}. "
        "Use exactly those names in `values` (nothing was filled).",
        reason="unknown_placeholder",
        details={"available": sorted(have)},
    )


def _scalar(v: Any) -> str:
    if isinstance(v, list):
        raise InvalidRequest(
            "a list value only fits an Excel named range; give one text or number here", reason="schema"
        )
    return "" if v is None else ("true" if v is True else "false" if v is False else str(v))


def _docx_ops(pkg: Pkg, values: dict[str, Any]) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    outline = word.outline(pkg)
    have: list[str] = outline["placeholders"]
    missing = [k for k in values if k.strip() not in have]
    if missing:
        raise _keys_error("placeholder", missing, have)
    ops: list[dict[str, Any]] = []
    text_values = {k: _scalar(v) for k, v in values.items() if not isinstance(v, dict)}
    images = {k: v for k, v in values.items() if isinstance(v, dict)}
    if text_values:
        ops.append({"op": "fill_placeholders", "values": text_values})
    for key, spec in images.items():
        para = next(
            (
                b
                for b in outline["blocks"]
                if b["type"] != "table" and b.get("text", "").strip() == "{{" + key.strip() + "}}"
            ),
            None,
        )
        if para is None:
            raise InvalidRequest(
                f"an image for {{{{{key}}}}} needs a paragraph that holds only that placeholder; none does",
                reason="image_placeholder",
            )
        ops.append(
            {
                "op": "insert_image_after",
                "anchor": para["id"],
                **{k: v for k, v in spec.items() if k in ("image", "width_cm", "height_cm", "alt")},
            }
        )
        ops.append({"op": "delete_paragraph", "paragraph": para["id"]})
    unfilled = [p for p in have if p not in {k.strip() for k in values}]
    return ops, {"filled": sorted(values), "unfilled": unfilled}


def _pptx_ops(pkg: Pkg, values: dict[str, Any]) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    outline = powerpoint.outline(pkg)
    tokens: dict[str, set[str]] = {}  # name -> literal tokens as written in the file
    shapes: dict[str, list[tuple[int, dict[str, Any]]]] = {}
    for s in outline["slides"]:
        for sh in s["shapes"]:
            flat = _flat_text(sh.get("text"))
            for m in PLACEHOLDER.finditer(flat):
                tokens.setdefault(m.group(1).strip(), set()).add(m.group(0))
            if flat.strip() and PLACEHOLDER.fullmatch(flat.strip()):
                shapes.setdefault(PLACEHOLDER.fullmatch(flat.strip()).group(1).strip(), []).append((s["index"], sh))  # type: ignore[union-attr]
        for m in PLACEHOLDER.finditer(s.get("notes") or ""):
            tokens.setdefault(m.group(1).strip(), set()).add(m.group(0))
    missing = [k for k in values if k.strip() not in tokens]
    if missing:
        raise _keys_error("placeholder", missing, list(tokens))
    ops: list[dict[str, Any]] = []
    for key, v in values.items():
        name = key.strip()
        if isinstance(v, dict):
            if name not in shapes:
                raise InvalidRequest(
                    f"an image for {{{{{name}}}}} needs a shape that holds only that placeholder; none does",
                    reason="image_placeholder",
                )
            for slide, sh in shapes[name]:
                x, y, w, _h = sh.get("box") or [0, 0, 0, 0]
                img_w = v.get("width_cm") or (w / EMU_CM if w else None)
                box = {"x": x / EMU_CM, "y": y / EMU_CM, **({"width": img_w} if img_w else {})}
                ops.append(
                    {"op": "insert_image", "slide": slide, "image": v["image"], "box": box, "alt": v.get("alt", "")}
                )
            for token in tokens[name]:
                ops.append({"op": "replace_text", "find": token, "replace": "", "notes": True})
        else:
            for token in sorted(tokens[name]):
                ops.append({"op": "replace_text", "find": token, "replace": _scalar(v), "notes": True})
    unfilled = [k for k in tokens if k not in {x.strip() for x in values}]
    return ops, {"filled": sorted(values), "unfilled": sorted(unfilled)}


def _flat_text(text: Any) -> str:
    if isinstance(text, str):
        return text
    if isinstance(text, list):
        return "\n".join(_flat_text(t) for t in text)
    return ""


_NAME_REF = re.compile(r"^(?:'((?:[^']|'')+)'|([^'!]+))!\$?([A-Z]{1,3})\$?(\d+)(?::\$?([A-Z]{1,3})\$?(\d+))?$")


def _substitute(text: str, name: str, value: Any) -> str:
    return PLACEHOLDER.sub(lambda m: _scalar(value) if m.group(1).strip() == name else m.group(0), text)


def _xlsx_ops(pkg: Pkg, values: dict[str, Any]) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    sst = excel._shared_strings(pkg)
    texts: dict[tuple[str, str], str] = {}  # (sheet, cell) -> text, for the cells that hold a {{placeholder}}
    holders: dict[str, list[tuple[str, str]]] = {}
    for name, part, _st, _sid, typ in excel._sheets(pkg):
        if typ != excel.WS_REL:
            continue
        for ref, item in excel._cells_of(pkg, part, sst).items():
            v = item.get("value")
            if isinstance(v, str) and PLACEHOLDER.search(v):
                texts[(name, ref)] = v
                for m in PLACEHOLDER.finditer(v):
                    holders.setdefault(m.group(1).strip(), []).append((name, ref))
    names: dict[str, tuple[str, list[str]]] = {}
    for dn in excel.outline(pkg)["defined_names"]:
        nref = _NAME_REF.match((dn.get("ref") or "").strip())
        if not nref:
            continue
        sheet = (nref.group(1) or nref.group(2)).replace("''", "'")
        n1, n2 = excel._col2n(nref.group(3)), excel._col2n(nref.group(5) or nref.group(3))
        r1, r2 = int(nref.group(4)), int(nref.group(6) or nref.group(4))
        names[dn["name"]] = (sheet, [excel._n2col(c) + str(r) for r in range(r1, r2 + 1) for c in range(n1, n2 + 1)])
    have = sorted({*holders, *names})
    missing = [k for k in values if k.strip() not in have]
    if missing:
        raise _keys_error("{{placeholder}} cell or named range", missing, have)
    final: dict[tuple[str, str], Any] = {}
    ops: list[dict[str, Any]] = []
    for key, v in values.items():
        name = key.strip()
        image = v if isinstance(v, dict) else None
        if name in names:
            sheet, refs = names[name]
            if image:
                ops.append(
                    {
                        "op": "insert_image",
                        "sheet": sheet,
                        "cell": refs[0],
                        "image": image["image"],
                        "alt": image.get("alt", ""),
                    }
                )
                continue
            seq = v if isinstance(v, list) else [v]
            if len(seq) > len(refs):
                raise InvalidRequest(
                    f"{len(seq)} values for the named range {name!r}, which has {len(refs)} cells", reason="schema"
                )
            for ref, item in zip(refs, seq, strict=False):
                final[(sheet, ref)] = item
            continue
        if isinstance(v, list):
            raise InvalidRequest(
                f"{{{{{name}}}}} is a cell placeholder: give one value (lists fit named ranges)", reason="schema"
            )
        for cell in holders.get(name, []):
            current = final.get(cell, texts[cell])
            if image:
                final[cell] = None
                ops.append(
                    {
                        "op": "insert_image",
                        "sheet": cell[0],
                        "cell": cell[1],
                        "image": image["image"],
                        "alt": image.get("alt", ""),
                    }
                )
            elif isinstance(current, str):
                whole = PLACEHOLDER.fullmatch(current.strip())
                final[cell] = v if whole and whole.group(1).strip() == name else _substitute(current, name, v)
    by_sheet: dict[str, dict[str, Any]] = {}
    for (sheet, ref), item in final.items():
        by_sheet.setdefault(sheet, {})[ref] = item
    ops = [{"op": "set_cells", "sheet": sh, "cells": cells} for sh, cells in by_sheet.items()] + ops
    unfilled = [k for k in holders if k not in {x.strip() for x in values}]
    return ops, {"filled": sorted(values), "unfilled": sorted(unfilled)}
