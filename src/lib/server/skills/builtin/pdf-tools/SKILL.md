---
name: pdf-tools
description: Work with existing PDFs using pypdf — fill AcroForm fields, merge, split, rotate, reorder pages, extract text and metadata, encrypt and decrypt. Use when the task is manipulating a PDF the person already has, not creating a new one.
---

# PDF tools

Use this skill when the person wants an existing PDF changed or inspected:
merging, splitting, rotating, reordering, filling forms, extracting text or
metadata, encrypting or decrypting. For **creating** a new PDF, use the `pdf`
skill instead.

## Setup

```python
import micropip
await micropip.install("pypdf")
```

## The bundled toolkit

Write the bundled script into the working directory and import it — every
function takes file paths and returns the output path:

```python
# after loading scripts/pdf_tools.py with load_skill_file, write it out, then:
import pdf_tools

pdf_tools.merge_pdfs(["a.pdf", "b.pdf"], "combined.pdf")
pdf_tools.split_pdf("combined.pdf", prefix="part")
pdf_tools.rotate_pages("in.pdf", 90, pages=[3, 4], out_path="rotated.pdf")
pdf_tools.reorder_pages("in.pdf", [2, 1, 3], out_path="reordered.pdf")
text = pdf_tools.extract_text("in.pdf")          # {page_number: text}
info = pdf_tools.read_metadata("in.pdf")
fields = pdf_tools.form_fields("form.pdf")        # what can be filled
pdf_tools.fill_form("form.pdf", {"Name": "Ada"}, "filled.pdf")
pdf_tools.encrypt_pdf("in.pdf", "secret", "locked.pdf")
pdf_tools.decrypt_pdf("locked.pdf", "secret", "open.pdf")
```

Check `form_fields(...)` first and report the field names to the person when
a fill request doesn't match them exactly — do not guess field names.

## What each operation does and doesn't do

- **Merge** keeps pages, bookmarks and form fields as they are; it does not
  renumber pages inside documents.
- **Split** writes one file per page with `part-1.pdf`, `part-2.pdf`, …
- **Rotate** turns whole pages in 90° steps; it cannot rotate text within a
  page.
- **Extract text** works on text-layer PDFs. A scanned page returns little or
  no text — that is the file, not a bug; say so rather than inventing content.
- **Fill form** writes AcroForm values. `flatten=True` bakes values in;
  otherwise the PDF stays editable.
- **Encrypt/decrypt** use RC4-128, because AES needs the `cryptography`
  package, which does not exist in this sandbox. Say this when the person
  asks for encryption; an AES-encrypted input PDF cannot be opened here.

## Rules

- `pdfplumber`, `pdftoppm`/Poppler, LibreOffice and image rendering do not
  exist here and no install makes them appear — pypdf is the tool for all of
  the above.
- Never alter content the person didn't ask to change; work page-structurally
  (merge, split, rotate, reorder) or on the named fields only.
- Files are written to the working directory under clear names; only describe
  files you actually produced. Verify by re-opening the output with pypdf and
  reporting page counts or extracted values.
