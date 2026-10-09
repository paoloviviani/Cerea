---
name: business-writing
description: Write internal communications in the formats companies actually use — 3P updates, company newsletters, FAQ answers, status reports, leadership updates, project updates, and incident reports. Use when asked to write any sort of internal communication.
---

## When to use this skill

Use this skill to write internal communications:

- 3P updates (Progress, Plans, Problems)
- Company newsletters
- FAQ responses
- Status reports
- Leadership updates
- Project updates
- Incident reports

## How to use this skill

To write any internal communication:

1. **Identify the communication type** from the request
2. **Load the appropriate guideline file** with the `load_skill_file` tool (skill `business-writing`):
   - `references/examples/3p-updates.md` — for Progress/Plans/Problems team updates
   - `references/examples/company-newsletter.md` — for company-wide newsletters
   - `references/examples/faq-answers.md` — for answering frequently asked questions
   - `references/examples/general-comms.md` — for anything else that doesn't explicitly match one of the above
3. **Follow the specific instructions** in that file for formatting, tone, and content gathering

If the communication type doesn't match any existing guideline, ask for clarification or more context about the desired format.

## Delivering the result

The document is the deliverable: emit it directly as a fenced code block whose
info string names the file (e.g. ```markdown title=update.md) so the app shows
it as a downloadable file card — do not wrap it in Python and do not paste
base64. When the person asks for the text in the chat instead, write it inline.

## Rules

- Every claim traces back to something the person said or an `execute_code`
  result you saw yourself; never invent findings, numbers, or incidents.
- Match the person's language: if they write in another language, write the
  communication in it.
- Mark anything uncertain as uncertain in the text.

## Keywords

3P updates, company newsletter, company comms, weekly update, faqs, common questions, updates, internal comms
