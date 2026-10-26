"""Every installed dependency (runtime and development) carries an OSI-approved licence."""

from __future__ import annotations

import re
from importlib import metadata

# OSI-approved licences seen in this dependency tree. A new licence fails this test until a person
# has checked it against the OSI list and added it here and in documents/README.md.
OSI_SPDX = {"MIT", "MIT-CMU", "HPND", "BSD-2-Clause", "BSD-3-Clause", "Apache-2.0", "PSF-2.0", "MPL-2.0", "ISC"}
OSI_CLASSIFIER = re.compile(r"^License :: OSI Approved ::")
# One recorded exception. numpy is BSD-3-Clause; its metadata also lists the licences of vendored parts:
# 0BSD and Zlib (both OSI-approved) and CC0-1.0, which applies to one vendored header (Highway's
# hwy/contrib/random/random-inl.h, a public-domain dedication) and is not on the OSI list. numpy is a
# dependency of matplotlib (the chart renderer); the exact expression is allowed so any change to it is seen.
EXCEPTIONS = {"numpy": "BSD-3-Clause AND 0BSD AND MIT AND Zlib AND CC0-1.0"}
TEXT_HINTS = ("MIT", "BSD", "Apache", "Mozilla Public License", "Python Software Foundation", "PSF", "ISC", "HPND")


def licence_ok(dist: metadata.Distribution) -> bool:
    md = dist.metadata
    expr = md.get("License-Expression")
    if expr and EXCEPTIONS.get(md.get("Name", "").lower()) == expr:
        return True
    if expr:
        return all(tok in OSI_SPDX for tok in re.split(r"\s+(?:AND|OR)\s+|[()]", expr) if tok.strip())
    if any(OSI_CLASSIFIER.match(c) for c in md.get_all("Classifier") or []):
        return True
    text = md.get("License") or ""
    return any(h in text for h in TEXT_HINTS)


def test_all_dependencies_are_osi_approved() -> None:
    bad = []
    for dist in metadata.distributions():
        name = dist.metadata.get("Name", "?")
        if name.lower() in ("pip", "setuptools", "wheel"):
            continue
        if not licence_ok(dist):
            bad.append((name, dist.metadata.get("License-Expression") or dist.metadata.get("License")))
    assert not bad, f"licence not recognised as OSI-approved: {bad}"
