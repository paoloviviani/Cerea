"""pptx_verify - check an edit made with pptx_edit / pptx_slides, and show what it did.

    import pptx_verify as pv
    rep = pv.verify("original.pptx", "edited.pptx")   # raises PatchError unless sound
    print("\\n".join(rep["text_diff"]))

Licence: Apache-2.0, as the rest of this repository. Original work.
"""

import difflib
import re

from lxml import etree

from pptx_edit import PatchError, _Pkg, _owner, _rels, _slides, outline

# What the helpers may touch; everything else (layouts, masters, theme, ...)
# must stay byte-identical.
EDITABLE = re.compile(r"^(ppt/slides/(_rels/)?[^/]+|ppt/notesSlides/(_rels/)?[^/]+|ppt/media/[^/]+|ppt/presentation\.xml"
                      r"|ppt/_rels/presentation\.xml\.rels|\[Content_Types\]\.xml|ppt/(charts|embeddings|diagrams)/.+)$")


def outline_text(o, width=70):
    """The outline as compact text, for printing."""
    cut = lambda s: s if len(s) <= width else s[: width - 3] + "..."
    lines = []
    for s in o["slides"]:
        lines.append("slide %d [%s] %s" % (s["index"], s["layout"], s["part"].rsplit("/", 1)[1]))
        for sh in s["shapes"]:
            ph = sh.get("placeholder")
            txt = sh.get("text")
            if sh["kind"] == "table":
                txt = " | ".join(" / ".join(r) for r in txt)
            elif isinstance(txt, list):
                txt = " / ".join(x for x in txt if x)
            lines.append("  #%d %s%s%s%s" % (sh["id"], sh["kind"], " %s idx%d" % (ph["type"], ph["idx"]) if ph else "",
                                              " " + sh["image"].rsplit("/", 1)[1] if sh.get("image") else "", ": " + cut(txt) if txt else ""))
        if s["notes"]:
            lines.append("  notes: " + cut(s["notes"].replace("\n", " / ")))
    return "\n".join(lines)


def _lines(path):
    o = outline(path)
    out = ["order: " + ", ".join(s["part"].rsplit("/", 1)[1] for s in o["slides"])]
    for s in o["slides"]:
        name = s["part"].rsplit("/", 1)[1]
        for sh in s["shapes"]:
            txt = sh.get("text")
            txt = " | ".join(" / ".join(r) for r in txt) if sh["kind"] == "table" else " / ".join(txt or [])
            if sh.get("image"):
                txt = "[picture %s]" % sh["image"].rsplit("/", 1)[1]
            if txt:
                out.append("%s #%d %s: %s" % (name, sh["id"], sh["name"], txt))
        if s["notes"]:
            out.append("%s notes: %s" % (name, s["notes"].replace("\n", " / ")))
    return out


def diff_text(src, dst):
    """What changed in the deck's text, pictures and slide order: "- old" / "+ new" lines."""
    d = [x for x in difflib.unified_diff(_lines(src), _lines(dst), lineterm="", n=0) if not x.startswith(("---", "+++", "@@"))]
    return [x[0] + " " + x[1:] for x in d]


def verify(src, dst, changed_parts=None):
    """Raise PatchError unless `dst` is a sound edit of `src`: valid zip (CRC),
    surviving parts in the same order, only slide, notes, media, presentation.xml
    and [Content_Types].xml parts (or the `changed_parts` you pass) differ, added
    or removed, every other part byte-identical, changed XML well-formed,
    relationships and content types intact, and python-pptx reopens it. Returns
    {"parts", "byte_identical", "changed", "added", "removed", "slides", "text_diff"}."""
    a, b = _Pkg(src), _Pkg(dst)
    added, removed = [n for n in b.names if n not in a.data], [n for n in a.names if n not in b.data]
    diff = [n for n in a.names if n in b.data and a.data[n] != b.data[n]]
    ok = (lambda n: n in set(changed_parts)) if changed_parts is not None else (lambda n: bool(EDITABLE.match(n)))
    bad = sorted(n for n in diff + added + removed if not ok(n))
    if bad:
        raise PatchError("parts changed that should not have: %s. Do not deliver this file; redo the edit with pptx_edit "
                         "instead of python-pptx save()." % bad)
    if [n for n in a.names if n in b.data] != [n for n in b.names if n in a.data]:
        raise PatchError("the order of the surviving parts changed")
    for n in diff + added:
        if n.endswith((".xml", ".rels")):
            try:
                etree.fromstring(b.data[n])
            except etree.XMLSyntaxError as e:
                raise PatchError("%s is not well-formed XML: %s" % (n, e))
    for n in b.names:
        if n.endswith(".rels"):
            for i, typ, tgt, mode in _rels(b, _owner(n)):
                if mode != "External" and tgt not in b.data:
                    raise PatchError("%s points at a missing part %s" % (n, tgt))
    ct = b.tree("[Content_Types].xml")
    defaults = {d.get("Extension", "").lower() for d in ct if d.tag.endswith("}Default")}
    overrides = {o.get("PartName") for o in ct if o.tag.endswith("}Override")}
    for n in b.names:
        if n != "[Content_Types].xml" and "/" + n not in overrides and n.rsplit(".", 1)[-1].lower() not in defaults:
            raise PatchError("%s has no content type; the deck would need repair in PowerPoint" % n)
    for o in overrides:
        if o.lstrip("/") not in b.data:
            raise PatchError("[Content_Types].xml lists %s but the part is gone" % o)
    try:
        import pptx
    except ImportError:
        pptx = None
    if pptx is not None:
        try:
            pptx.Presentation(dst)
        except Exception as e:
            raise PatchError("python-pptx cannot reopen the result: %s" % e)
    return {"parts": len(a.names), "byte_identical": len(a.names) - len(diff) - len(removed), "changed": sorted(diff),
            "added": sorted(added), "removed": sorted(removed), "slides": (len(_slides(a)), len(_slides(b))),
            "text_diff": diff_text(src, dst)}
