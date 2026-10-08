"""pdf_tools: pypdf recipes for working with existing PDFs, importable as-is.

Every function takes and returns file paths in the working directory. All of
it runs in Cerea's Python sandbox (pypdf only, standard library otherwise):
`import micropip; await micropip.install("pypdf")` first, then write this file
into the working directory and `import pdf_tools`.

Note on encryption: AES needs the `cryptography` package, which is not
available in this sandbox — `encrypt_pdf` therefore uses RC4-128, and opening
an AES-encrypted PDF will raise. Say so before choosing to encrypt.
"""

from __future__ import annotations

from pypdf import PdfReader, PdfWriter


def merge_pdfs(paths: list[str], out_path: str) -> str:
	"""Append the given PDFs, in order, into one file. Keeps bookmarks where they exist."""
	writer = PdfWriter()
	for path in paths:
		writer.append(path)
	with open(out_path, "wb") as fh:
		writer.write(fh)
	return out_path


def split_pdf(path: str, prefix: str = "page") -> list[str]:
	"""Write one PDF per page, named `<prefix>-<n>.pdf` (1-based). Returns the paths."""
	reader = PdfReader(path)
	written = []
	for index, page in enumerate(reader.pages):
		writer = PdfWriter()
		writer.add_page(page)
		out = f"{prefix}-{index + 1}.pdf"
		with open(out, "wb") as fh:
			writer.write(fh)
		written.append(out)
	return written


def rotate_pages(path: str, degrees: int, pages: list[int] | None, out_path: str) -> str:
	"""Rotate pages by 90/180/270. `pages` are 1-based; None means every page."""
	reader = PdfReader(path)
	writer = PdfWriter()
	for index, page in enumerate(reader.pages):
		if pages is None or (index + 1) in pages:
			page.rotate(degrees)
		writer.add_page(page)
	with open(out_path, "wb") as fh:
		writer.write(fh)
	return out_path


def reorder_pages(path: str, order: list[int], out_path: str) -> str:
	"""Write the pages in a new order; `order` is 1-based and may repeat or skip."""
	reader = PdfReader(path)
	writer = PdfWriter()
	for number in order:
		writer.add_page(reader.pages[number - 1])
	with open(out_path, "wb") as fh:
		writer.write(fh)
	return out_path


def extract_text(path: str, pages: list[int] | None = None) -> dict[int, str]:
	"""Text per page (1-based keys). A scanned page yields little or no text."""
	reader = PdfReader(path)
	targets = range(1, len(reader.pages) + 1) if pages is None else pages
	return {number: reader.pages[number - 1].extract_text() or "" for number in targets}


def read_metadata(path: str) -> dict[str, str | None]:
	"""The document's metadata (title, author, dates, producer), if any."""
	reader = PdfReader(path)
	return {key: value for key, value in (reader.metadata or {}).items()}


def form_fields(path: str) -> dict[str, str]:
	"""The AcroForm field names a fillable PDF offers, with their current values."""
	reader = PdfReader(path)
	fields = reader.get_fields() or {}
	return {
		name: str(field.get("/V", "")) if field.get("/V") is not None else ""
		for name, field in fields.items()
		if field.get("/FT") in ("/Tx", "/CheckBox", "/RadioButton", "/Choice")
	}


def fill_form(path: str, values: dict[str, str], out_path: str, flatten: bool = False) -> str:
	"""Fill AcroForm fields by name. `flatten=True` bakes the values in (no longer editable)."""
	reader = PdfReader(path)
	writer = PdfWriter()
	writer.append(reader)
	writer.update_page_form_field_values(writer.pages[0], values, auto_regenerate=None)
	if flatten:
		for page in writer.pages:
			page.flatten()
	with open(out_path, "wb") as fh:
		writer.write(fh)
	return out_path


def encrypt_pdf(path: str, user_password: str, out_path: str, owner_password: str | None = None) -> str:
	"""Encrypt with RC4-128 (AES is unavailable in this sandbox)."""
	reader = PdfReader(path)
	writer = PdfWriter()
	writer.append(reader)
	writer.encrypt(
		user_password=user_password,
		owner_password=owner_password or user_password,
		algorithm="RC4-128",
	)
	with open(out_path, "wb") as fh:
		writer.write(fh)
	return out_path


def decrypt_pdf(path: str, password: str, out_path: str) -> str:
	"""Remove encryption from a PDF this sandbox can open (RC4, not AES)."""
	reader = PdfReader(path, password=password)
	writer = PdfWriter()
	writer.append(reader)
	with open(out_path, "wb") as fh:
		writer.write(fh)
	return out_path
