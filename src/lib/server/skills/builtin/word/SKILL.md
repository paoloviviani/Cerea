---
name: word
description: Create, edit, and check .docx documents with python-docx — reports, letters, meeting notes, and any Word file, with consistent styles, clean tables, and verified structure. Use when the task involves reading, creating, or editing Word documents.
---

# Word documents

Use this skill when the person wants a `.docx` created, edited, or checked.

## Setup

Install before importing — the package name differs from the import name:

```python
import micropip
await micropip.install("python-docx")
import docx  # python-docx
```

## Reading a document

- A document the person attached is at `/mnt/data/<its filename>` in the
  sandbox; one produced earlier in the conversation is in the working
  directory.

- Load it with `docx.Document(path)` and inspect before changing: read the
  paragraph styles, the tables' shape, and the section setup (page size,
  margins, orientation). Report briefly what you found so the person can
  confirm you are working on the right file.
- Extract text as the ground truth for every edit: iterate paragraphs and
  tables explicitly, never assume a document's structure from its length.
- Preserve what you did not touch: styles, headers and footers, section
  properties, and numbering survive best when you edit runs and cells rather
  than deleting and recreating content.

## Creating a document

- Build structure with real styles, not manual formatting: headings via
  `add_heading`, body text with the Normal style, emphasis with bold/italic
  runs. Lists are paragraphs with `List Bullet` / `List Number` styles.
- Tables: `add_table` with a style (e.g. `Light Grid Accent 1`), then set the
  header row bold. Fill cell-by-cell; merged cells only when the layout
  demands it.
- Keep hierarchy visible: a title, headed sections, short paragraphs. Page
  breaks (`add_page_break`) before major sections of a long report.
- Prefer the package over hand-built OOXML in every case — constructing
  document XML by string surgery breaks on the first non-trivial document.

## Checking before delivery

There is no renderer in this environment, so a document is verified by
reading it back, not by looking at a picture:

1. Re-open the saved file with `python-docx` and print an outline: heading
   texts and levels, table count and dimensions, paragraph count.
2. Check the content: no placeholder text left, no duplicated sections, table
   cells all filled where they should be, and no empty paragraphs where
   spacing was intended.
3. Say in one line what you checked and what you could not check (exact
   visual layout — the person should open the file to judge spacing).

## Quality expectations

- Deliver a client-ready document: consistent typography, spacing, margins,
  and clear hierarchy.
- Avoid formatting defects: broken tables, unreadable characters, or
  default-template styling where the document calls for real structure.
- Use ASCII hyphens only. Avoid U+2011 (non-breaking hyphen) and other
  Unicode dashes.
- Citations and references must be human-readable; never leave tool tokens or
  placeholder strings.

## Rules

- The document is the deliverable: the file must exist when you finish —
  run the code yourself or write one complete runnable block; a script the
  person still has to run is not the file.
- Edit the file the person attached in place (read it, modify, save under a
  new name unless asked to overwrite) — never rebuild an edited document from
  scratch unless they asked for a redesign.
- Files are written to the working directory by a code block under a clear
  filename; the app lists them as downloads. Only describe files you actually
  produced.
- Iterate with the `execute_code` tool when you need to see a result
  (structure, extracted text, a table's contents) — run, read, fix, run again.
