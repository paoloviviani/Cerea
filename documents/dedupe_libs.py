"""Build-stage helper (see the Dockerfile): wheels with native code each vendor their own copy of the C++
runtime (`libstdc++-<hash>.so.*`, `libgcc_s-<hash>.so.*`: numpy, matplotlib, contourpy, kiwisolver and
pypdfium2 each ship about 3 MB of it). Where two copies carry the same name and the same bytes, keep one and make
the others symlinks to it: the loader finds the same file by the same name, so nothing changes at run time, and
the image loses about 10 MB, which is what keeps it under its size gate with PDFium in it.

Usage: python dedupe_libs.py <site-packages>"""

from __future__ import annotations

import filecmp
import os
import sys
from pathlib import Path


def main(root: Path) -> int:
    first: dict[str, Path] = {}
    saved = 0
    for lib in sorted(root.glob("*.libs/lib*")):
        if lib.is_symlink() or not lib.is_file() or not lib.name.startswith(("libstdc++-", "libgcc_s-")):
            continue
        keep = first.setdefault(lib.name, lib)
        if keep is lib or not filecmp.cmp(keep, lib, shallow=False):
            continue
        saved += lib.stat().st_size
        lib.unlink()
        lib.symlink_to(os.path.relpath(keep, lib.parent))
    print(f"dedupe_libs: {saved // 1024} KiB saved")
    return 0


if __name__ == "__main__":
    sys.exit(main(Path(sys.argv[1])))
