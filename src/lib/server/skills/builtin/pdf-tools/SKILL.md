---
name: pdf-tools
description: Work with existing PDFs - fill in a PDF form (with the doc_outline and doc_edit tools when they are offered), merge, split, rotate, reorder pages, extract text and metadata, encrypt and decrypt with pypdf. Use when the task is manipulating a PDF the user already has, not creating a new one.
---

# PDF tools

Use this skill when the user wants an existing PDF changed or inspected:
filling a form, merging, splitting, rotating, reordering, extracting text or
metadata, encrypting or decrypting. For **creating** a new PDF, use the `pdf`
skill instead.

**A scanned or image-only PDF** has no text to extract. When `look_doc` is in your tool list, look at its pages to
read it as it really looks (a form with no fields, a scan, a drawing): a few pages at a time, only the ones you need.

## One rule for forms

**When `doc_edit` is in your tool list, a PDF form is filled ONLY with
`doc_outline` and `doc_edit`.** Do not fill a form in the sandbox, and do not
use the helper's `form_fields` or `fill_form` below. If the tools are not in
your tool list, jump to the last section, "Fallback: forms in the sandbox".
Everything else in this skill (merge, split, rotate, reorder, text, metadata,
encryption) has no tool and is always done in the sandbox.

1. `doc_outline` on the PDF lists its pages (with their size in points and the text lines on them, each with its
   position) and, when it has a form, every field: its full `name`, `type`, `pages`, current `value`, what it
   accepts (`allowed`, or `options` with each `value` and `label`), `max_length`, `required` or `read_only` when
   set, and where it is: `rect` (`page`, `x`, `y`, `w`, `h` in PDF points, origin at the page's bottom left), a
   `label` (the text beside, or the column header above, or just above it) and, for fields lined up in rows and
   columns, `table: {id, row, col}` (the label is then the column header). Always call it first and use the field
   names exactly; never guess a field name.
2. **Match the user's data to the fields by label and position, never by the order of the names.** Generic names
   (`Testo104`, `Text12`) say nothing and are not in reading order: read `label`, `table` and `rect`, and when a
   form's fields have no label, look at the page with `look_doc` and compare the positions. When a match is
   ambiguous (two fields that could hold the same thing, a value that fits none of a list's options), ask the user
   before filling. Do not invent values the user did not give, and leave the other fields as they are.
3. `doc_edit` with one operation, `fill_form({values, flatten?})`:
   - text field: the text; checkbox: `true`, `false` or its on-state name (the
     name is not always "Yes"); radio group: one of its `allowed` names; list
     or combo box: an option's `value` or `label` (a list of them for a
     multi-select list);
   - every value is checked first, and a bad one is refused with what the field
     takes, so nothing is half-filled: read the message and correct it;
   - text wider than its box is shrunk to fit (to 6 pt); `clipped` lists a value that still does not fit: shorten
     it or tell the user.
   - **Never flatten unless the user asks for it.** A flattened PDF is no longer a form. To see the values, use
     `look_doc`, which draws filled fields; flatten is never a way to look. When the user does ask, `flatten: true`
     saves a separate file, `<name>-flattened.pdf`, and the fillable file stays as it was (`flatten_in_place`
     only if the user asked to replace it).
4. **After filling, look at the page with `look_doc`** (when it is offered) and check that every value is in its
   box and fully visible; fix what is not and fill again. Report what was filled, from the result: the fields set,
   the fields left empty (`skipped`), the **required fields still empty** (`required_missing`: tell the user), and
   any value that did not take (`not_taken`; say so, never claim it was filled). The file is a new version of the
   same name.
5. Text is limited to Western European characters (accents and the euro are
   fine); a value with other letters (Polish "Ł", Greek, Cyrillic) is refused
   with the characters named: tell the user, do not transliterate unasked.
6. If `doc_outline` says the PDF is an **XFA** form (Adobe LiveCycle) or is
   **signed** (`signed: true`: filling would invalidate the digital signature,
   and there is no way around it here), it cannot be filled: say so plainly and
   offer what can be done (the user can fill an XFA form in Adobe Acrobat, or a
   signed one in a copy made before signing).
7. If the PDF has **no form fields** (a scanned or printed form, or blanks that
   are only drawn lines), `fill_form` can't fill it, but `doc_edit` can write on the page:
   `place_text({items: [{page, x, y, text, size?, font?}]})`. Say there are no fields, then:
   - read the text lines of `doc_outline` (`x`, `y` is the baseline start, `w` the estimated width) and put each
     value next to its label: `x` a little past the label's `x + w` (or on the blank line), `y` the label's `y` plus
     about 1 point; size 9 to 11 unless the blank is small. Look at the form with `look_doc` first when the blanks
     are not obvious from the text;
   - call `place_text` once with all the items (it cannot be combined with `fill_form` and is refused on a PDF
     that has fields, unless `allow_on_form: true` is given to add text the fields do not cover);
   - **check with `look_doc`** and adjust. To correct misplaced text, do not place more text on top of it: call
     `doc_edit` with `version` set to the version before the placement (`file_versions` in `doc_outline` lists
     them), and place again with the corrected positions (the result lists each item and whether it was found at
     its position);
   - positions are in the page's own space, not the picture's: on a **rotated** page (`rotation` in the page's
     entry) compare with the `lines` positions, not with what `look_doc` shows, and a page whose visible area is
     cropped says where it starts (`origin_x`, `origin_y`); `place_text` refuses a rotated page's item that is not
     next to a listed line;
   - text is limited to Western European characters, as above;
   - the sandbox route (`reportlab` and `pypdf`: install them with `micropip`, find the label positions with a
     pypdf text visitor, draw an overlay and merge it) is only for when `doc_edit` is not in your tool list.
8. **Never rebuild an official or third-party form as a substitute** (not with `doc_create`, not in the sandbox):
   a lookalike is not the form the user has to submit. If the original is damaged or lost, restore the earlier
   version (`doc_edit` with `version` set to a version that is still the original; `file_versions` in `doc_outline`
   lists them), or, if there is none, ask the user to attach the original again; do not recreate it.

## Setup

```python
import micropip
await micropip.install("pypdf")
```

## The bundled toolkit

Write the bundled script into the working directory and import it - every
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
pdf_tools.encrypt_pdf("in.pdf", "secret", "locked.pdf")
pdf_tools.decrypt_pdf("locked.pdf", "secret", "open.pdf")
```

## What each operation does and doesn't do

- **Merge** keeps pages, bookmarks and form fields as they are; it does not
  renumber pages inside documents.
- **Split** writes one file per page with `part-1.pdf`, `part-2.pdf`, ...
- **Rotate** turns whole pages in 90 degree steps; it cannot rotate text within a
  page.
- **Extract text** works on text-layer PDFs. A scanned page returns little or
  no text - that is the file, not a bug; say so rather than inventing content.
- **Encrypt/decrypt** use RC4-128, because AES needs the `cryptography`
  package, which does not exist in this sandbox. Say this when the user
  asks for encryption; an AES-encrypted input PDF cannot be opened here.

## Rules

- An attached PDF is readable in the sandbox at `/mnt/data/<its filename>` -
  pass that path to the toolkit; outputs you write go to the working
  directory and come back as downloads.

- `pdfplumber`, `pdftoppm`/Poppler, LibreOffice and image rendering do not
  exist here and no install makes them appear - pypdf is the tool for all of
  the above.
- Never alter content the user didn't ask to change; work page-structurally
  (merge, split, rotate, reorder) or on the named fields only.
- Deliverables are saved to `/mnt/output/<clear name>`; only files under
  `/mnt/output/` are offered as downloads, scratch files elsewhere are never
  shown. Only describe files you actually produced. Verify by re-opening the output with pypdf and
  reporting page counts or extracted values.

## Fallback: forms in the sandbox

**Read this section only if `doc_edit` is NOT in your tool list.** If it is,
stop reading here: this is the in-sandbox method for deployments without the
document service, and it must not be mixed with the tools.

```python
listing = pdf_tools.form_fields("/mnt/data/form.pdf")     # always first
for f in listing["fields"]:
    print(f["name"], f["type"], f["pages"], f["value"], f.get("allowed") or f.get("options"))
report = pdf_tools.fill_form(
    "/mnt/data/form.pdf", {"full_name": "Ada", "agree": True}, "/mnt/output/form-filled.pdf"
)
```

- `form_fields` returns `{"has_form", "xfa", "fields", "note"?}`. Each field has
  `name`, `type` (text, checkbox, radio, list, combo, signature, button),
  `pages`, `value`, `allowed` (a checkbox: `True`, `False` and its on-state; a
  radio group: its options), `options` (list or combo box: `value` and
  `label`), `max_length`, `required`, `read_only`. Use the names exactly; ask the
  user about anything ambiguous; never guess.
- `fill_form(path, values, out_path, flatten=False)` fills every page. Values:
  text; `True`/`False` or the on-state name for a checkbox; one of `allowed`
  for a radio group; an option's value or label for a list or combo box.
  Every value is checked first: a bad one raises an error naming the field and
  what it takes, and nothing is written, so fix the value and call again.
- It returns a report read back from the written file: `filled`, `rejected`
  (did not take - say so), `skipped` (fields given no value),
  `required_missing`, `diff`. Report
  what was filled from it. `flatten=True` bakes the values in and removes the
  form.
- An XFA form (`xfa: True`), a signed PDF (`signed: True`) or a PDF with no
  fields (`has_form: False`) cannot be filled here either: say so. Text is
  limited to Western European characters.
