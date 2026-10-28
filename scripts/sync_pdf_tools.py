#!/usr/bin/env python3
"""Copy the PDF form code of the document service into the `pdf-tools` skill's helper.

The service (`documents/src/cerea_documents/pdfform.py`) and the sandbox helper
(`src/lib/server/skills/builtin/pdf-tools/scripts/pdf_tools.py`) must fill forms the same way, and the helper is
a single file the sandbox imports, so the shared code is copied between two markers, with the skill's tab
indentation. `documents/tests/test_pdf_tools_helper.py` fails when the copy is stale.

    python3 scripts/sync_pdf_tools.py          # rewrite the helper
    python3 scripts/sync_pdf_tools.py --check  # exit 1 when it is stale
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "documents/src/cerea_documents/pdfform.py"
TARGET = ROOT / "src/lib/server/skills/builtin/pdf-tools/scripts/pdf_tools.py"
BEGIN = "# --- BEGIN pdfform: copied from documents/src/cerea_documents/pdfform.py by scripts/sync_pdf_tools.py ---"
END = "# --- END pdfform ---"


def render_block(source: str) -> str:
	"""The shared code without its module docstring and `from __future__` line, tab-indented."""
	body = re.sub(r'\A""".*?"""\n', "", source, count=1, flags=re.S)
	body = "\n".join(line for line in body.splitlines() if not line.startswith("from __future__"))
	lines = []
	for line in body.strip("\n").splitlines():
		stripped = line.lstrip(" ")
		indent = len(line) - len(stripped)
		lines.append("\t" * (indent // 4) + " " * (indent % 4) + stripped)
	return BEGIN + "\n" + re.sub(r"\n{3,}", "\n\n\n", "\n".join(lines)) + "\n" + END


def current_block(target: str) -> str | None:
	found = re.search(re.escape(BEGIN) + r".*?" + re.escape(END), target, flags=re.S)
	return found.group(0) if found else None


def main(argv: list[str]) -> int:
	block = render_block(SOURCE.read_text(encoding="utf-8"))
	target = TARGET.read_text(encoding="utf-8")
	have = current_block(target)
	if have is None:
		print(f"{TARGET} has no pdfform block between its markers", file=sys.stderr)
		return 1
	if have == block:
		return 0
	if "--check" in argv:
		print("pdf_tools.py is out of date: run python3 scripts/sync_pdf_tools.py", file=sys.stderr)
		return 1
	TARGET.write_text(target.replace(have, block), encoding="utf-8")
	print(f"rewrote the pdfform block of {TARGET.relative_to(ROOT)}")
	return 0


if __name__ == "__main__":
	sys.exit(main(sys.argv[1:]))
