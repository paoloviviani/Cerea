/**
 * Seeded admin skill definitions (Phase 1, ADR 0072).
 *
 * Read-only shared definitions shaped like an `McpConnector` of scope
 * `deployment`: the definition is shared, and the sharing is trivially
 * safe because a skill holds no secrets — it is instructions, not
 * credentials. There is no admin editor in v1; these live in code.
 * A per-skill global kill-switch costs nothing and exists via
 * `CHAT_SKILLS_DISABLED` (comma-separated names).
 *
 * Every seed is boring on purpose: procedural knowledge that fits
 * Pyodide-only execution — stdlib Python through the existing sandbox
 * channels, no network, no packages, no shell. Portable skills with shell
 * scripts do NOT transfer here: Cerea skills are instructions +
 * stdlib-Python-or-nothing, out of scope by architecture (multi-tenant
 * box, no server isolation), not by omission.
 */

export const ADMIN_SKILL_CSV_SHAPING = `---
name: csv-shaping
description: Reshape CSV data the person pastes or attaches — clean rows, rename or drop columns, filter, sort, and pivot with Python's csv module.
---

# CSV shaping

Use this skill when the person wants a CSV file cleaned, reshaped, or summarized.

## Procedure

1. Read the data first. If it is pasted in chat, save it to a variable; if it is an attached file, read it from the working directory. Never invent rows — work with exactly what was given.
2. Inspect before transforming: print the header, the row count, and one sample row. Report these briefly so the person can confirm you read the right file.
3. Transform with the \`csv\` module from the standard library only — no third-party packages, no network, no shell. Typical steps, in order:
   - Drop fully-empty rows and strip surrounding whitespace from every cell.
   - Rename columns only when the person asked, and say what you renamed.
   - Filter, sort, or pivot exactly as requested — one focused code block per step, verifying each step's output before the next.
4. Verify after transforming: print the new header, the new row count, and the first three rows.
5. Deliver the result the way the file convention requires: a computed file (the reshaped CSV) is written to the working directory by a sandbox code block under a clear filename, with one line saying what you made. A small summary table may be shown inline as text.

## Rules

- Standard library only (\`csv\`, \`json\`, \`collections\`, \`statistics\`). Never emit pip install commands.
- If a column the person named does not exist, stop and ask — do not guess which column they meant.
- Quote fields containing commas or newlines so the output stays valid CSV.
`;

export const ADMIN_SKILL_REPORT_WRITING = `---
name: report-writing
description: Turn findings, numbers, or a conversation's conclusions into a short structured markdown report with a title, summary, details, and next steps.
---

# Report writing

Use this skill when the person asks for a write-up, summary document, or report of findings discussed in the conversation.

## Procedure

1. Collect the material first: the conclusions, numbers, and decisions already stated in this conversation. Never invent findings — every claim in the report must trace back to something the person said or an \`execute_code\` result you saw yourself.
2. Structure the report the same way every time:
   - \`# <title>\` — what the report is about, in the person's words.
   - \`## Summary\` — three sentences at most, the answer first.
   - \`## Details\` — short sections with \`- \` bullets; numbers in backticks.
   - \`## Next steps\` — concrete actions, each starting with a verb. Omit when there are none rather than inventing some.
3. Keep it short: one page by default. Say explicitly what you left out when the conversation held more than fits.
4. Deliver it as a text file the person asked for: emit it directly as a fenced code block whose info string names the file (e.g. \`\`\`markdown title=report.md). The block's content is the file itself, verbatim — do not wrap it in Python, do not paste base64.

## Rules

- Mark anything uncertain as uncertain in the text; never present a guess as a finding.
- Match the person's language: if they write in another language, write the report in it.
- When the person asks for code instead of a document, this skill does not apply.
`;

export const ADMIN_SKILL_JSON_SHAPING = `---
name: json-shaping
description: Inspect, validate, and reshape JSON data — pretty-print, extract nested fields, flatten lists of objects to rows, and convert between JSON and CSV.
---

# JSON shaping

Use this skill when the person pastes JSON (or attaches a \`.json\` file) and wants it inspected, cleaned, or converted.

## Procedure

1. Parse first, assume nothing: load the data with the standard-library \`json\` module and report its top-level shape (object, list, scalar), its size, and its keys or length. If parsing fails, show the error and the position — do not repair the data silently.
2. Reshape only as requested, one focused code block per step:
   - Extract nested fields with explicit key paths; missing keys become \`null\`, never a crash and never a guess.
   - Flatten a list of objects to rows (one value per key path) for CSV conversion; nested lists become a count plus the first element unless asked otherwise.
   - Convert JSON to CSV with the \`csv\` module (header row first, comma-quoting for embedded commas), or CSV rows back to a list of objects.
3. Verify: print the new shape and the first two entries or rows after each step.
4. Deliver computed files (reshaped JSON or CSV) by writing them to the working directory from a sandbox code block under a clear filename, with one line saying what you made. Small results may be shown inline as a fenced \`\`\`json block instead.

## Rules

- Standard library only (\`json\`, \`csv\`). Never emit pip install commands, never fetch schemas or data over the network.
- Preserve key order and never drop a field the person did not ask to drop; report dropped fields explicitly.
- For large inputs, work on the first N entries to demonstrate the transform, then apply it to the whole — say both counts.
`;

/** Every seeded definition, in one list. */
export const ADMIN_SKILL_CONTENTS: string[] = [
	ADMIN_SKILL_CSV_SHAPING,
	ADMIN_SKILL_REPORT_WRITING,
	ADMIN_SKILL_JSON_SHAPING,
];

/**
 * Names disabled deployment-wide via `CHAT_SKILLS_DISABLED="name1,name2"`.
 * A global kill-switch per skill that costs nothing; unset means all seeds on.
 */
export function adminDisabledSkillNames(): Set<string> {
	const raw = process.env.CHAT_SKILLS_DISABLED ?? "";
	return new Set(
		raw
			.split(",")
			.map((name) => name.trim())
			.filter((name) => name.length > 0)
	);
}
