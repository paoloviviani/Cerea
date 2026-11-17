#!/usr/bin/env python3
"""Assemble the GitHub Pages output.

Layout (see .github/workflows/docs.yml):
  <out>/index.html, <out>/*      the landing page (site/landing/)
  <out>/docs/                    the mkdocs build (already built there)
  <out>/<old page>/index.html    a redirect to /Cerea/docs/<old page>/ for each
                                 page the docs site had at the Pages root
  <out>/assets, <out>/screenshots   copies of the docs image trees, so old
                                 embedded image URLs keep working

Usage: build-pages.py <out>   (run after `mkdocs build --site-dir <out>/docs`)
"""
import html
import shutil
import sys
from pathlib import Path

BASE = "/Cerea"
HOST = "https://paoloviviani.github.io"

REDIRECT = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Moved: Cerea documentation</title>
<meta name="robots" content="noindex">
<link rel="canonical" href="{canon}">
<meta http-equiv="refresh" content="0; url={target}">
<script>location.replace({target_js} + location.hash)</script>
</head>
<body>
<p>This page moved to <a href="{target}">{target}</a>.</p>
</body>
</html>
"""


def write(path: Path, target: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        REDIRECT.format(
            canon=html.escape(HOST + target),
            target=html.escape(target),
            target_js='"' + target + '"',
        )
    )


def main() -> None:
    out = Path(sys.argv[1]).resolve()
    docs = out / "docs"
    if not (docs / "index.html").is_file():
        sys.exit(f"{docs}/index.html missing: build mkdocs into {docs} first")
    landing = Path(__file__).resolve().parent.parent / "site" / "landing"
    shutil.copytree(landing, out, dirs_exist_ok=True)
    (out / ".nojekyll").write_text("")
    count = 0
    for page in sorted(docs.rglob("*.html")):
        rel = page.relative_to(docs)
        if rel.name == "404.html" or rel.parts == ("index.html",):
            continue
        if rel.name == "index.html":
            url, dest = "/".join(rel.parts[:-1]), out.joinpath(*rel.parts)
            target = f"{BASE}/docs/{url}/"
        else:
            dest = out / rel
            target = f"{BASE}/docs/{rel.as_posix()}"
        if dest.exists():
            sys.exit(f"{dest} collides with the landing page")
        write(dest, target)
        count += 1
    # Old asset/image URLs that other sites may embed: redirect only the pages;
    # files cannot redirect on Pages, so copy the image trees at the old paths.
    for tree in ("assets", "screenshots"):
        src = docs / tree
        if src.is_dir():
            shutil.copytree(src, out / tree, dirs_exist_ok=True)
    print(f"{count} redirect pages written")


if __name__ == "__main__":
    main()
