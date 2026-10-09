/**
 * Pyodide check for the built-in office skills: runs every bundled script in
 * the real vendored interpreter and re-opens what it produces.
 *
 * The browser runs the skills' code; this is the same interpreter in Node,
 * so a bundled script that breaks here breaks in the chat. The interpreter
 * boots from the gitignored `static/pyodide/` dist (`npm run sync-pyodide`),
 * while micropip's fetches go over a local HTTP server serving the same
 * directory — file:// URLs do not work with fetch, and the wheels index is
 * exactly what the worker pins in the browser
 * (`wheels/{package_name}.html`, see `pyodideWheelsIndexTemplate`).
 *
 * Run directly: `node scripts/pyodide_skills_check.mjs` (exit 0 = every
 * check passed). With `--json`, prints one JSON object mapping each skill
 * to {ok, details}, which `pyodideOfficeSkills.integration.spec.ts` asserts.
 */

import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distRoot = path.join(repoRoot, "static", "pyodide");

if (!existsSync(path.join(distRoot, "pyodide.asm.wasm"))) {
	console.error(
		"[pyodide-skills-check] static/pyodide/ is not populated; run `npm run sync-pyodide` first."
	);
	process.exit(2);
}

const CONTENT_TYPES = {
	".html": "text/html",
	".whl": "application/octet-stream",
	".json": "application/json",
	".wasm": "application/wasm",
	".zip": "application/zip",
	".mjs": "text/javascript",
	".js": "text/javascript",
	".map": "application/json",
	".svg": "image/svg+xml",
};

function startServer() {
	const server = createServer((req, res) => {
		const url = new URL(req.url ?? "/", "http://127.0.0.1");
		const relative = decodeURIComponent(url.pathname).replace(/^\/+/, "");
		const file = path.join(distRoot, relative);
		if (!file.startsWith(distRoot) || !existsSync(file) || !file.includes("pyodide")) {
			res.writeHead(404).end();
			return;
		}
		res
			.writeHead(200, {
				"content-type":
					CONTENT_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream",
			})
			.end(readFileSync(file));
	});
	return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

const { loadPyodide } = await import(
	pathToFileURL(path.join(repoRoot, "node_modules", "pyodide", "pyodide.mjs")).href
);

const server = await startServer();
const port = server.address().port;
const httpIndex = `http://127.0.0.1:${port}/wheels/{package_name}.html`;

const py = await loadPyodide({
	indexURL: `${distRoot}/`,
	lockFileURL: `${distRoot}/pyodide-lock.json`,
	stdLibURL: `${distRoot}/python_stdlib.zip`,
});
await py.loadPackage("micropip");
await py.runPythonAsync(`import micropip; micropip.set_index_urls(["${httpIndex}"])`);

/** Write a repo file into the sandbox FS and return its sandbox path. */
function put(repoPath, sandboxPath) {
	py.FS.writeFile(sandboxPath, readFileSync(path.join(repoRoot, repoPath)));
	return sandboxPath;
}

async function install(...packages) {
	for (const name of packages) {
		await py.runPythonAsync(`import micropip; await micropip.install("${name}")`);
	}
}

async function run(code) {
	// The worker resolves a run's imports the same way: lock packages through
	// loadPackagesFromImports, vendored wheels through micropip.
	try {
		await py.loadPackagesFromImports(code);
	} catch {
		// Best-effort: the run itself raises the real error.
	}
	return py.runPythonAsync(code);
}

/**
 * Put one of the bundled scripts into the sandbox FS under /skills/ and
 * import it by module name — the same write-then-import flow the skill
 * teaches the model.
 */
async function importScript(repoPath, sandboxName, moduleName) {
	py.FS.mkdirTree("/skills");
	py.FS.writeFile(`/skills/${sandboxName}`, readFileSync(path.join(repoRoot, repoPath), "utf8"));
	await run(`import sys; sys.path.insert(0, "/skills") if "/skills" not in sys.path else None`);
	await run(`import ${moduleName}`);
}

const results = {};
async function check(skill, fn) {
	try {
		const detail = await fn();
		results[skill] = { ok: true, detail };
		console.log(`PASS ${skill}: ${detail}`);
	} catch (err) {
		const message =
			err instanceof Error
				? err.message
				: typeof err === "object"
					? JSON.stringify(err, Object.getOwnPropertyNames(err))
					: String(err);
		results[skill] = { ok: false, detail: String(message).slice(0, 2400) };
		console.error(`FAIL ${skill}: ${results[skill].detail}`);
	}
}

const builtinDir = "src/lib/server/skills/builtin";

await check("word", async () => {
	await install("python-docx");
	const out = await run(`
from docx import Document
doc = Document()
doc.add_heading("Quarterly report", level=1)
doc.add_paragraph("Prepared by the analysis skill.")
table = doc.add_table(rows=2, cols=3)
table.style = "Light Grid Accent 1"
for column, value in zip(table.rows[0].cells, ("Region", "Revenue", "Delta")):
    column.text = value
doc.add_paragraph("First finding", style="List Bullet")
doc.save("/word-report.docx")

# edit: append a section, then save again
doc2 = Document("/word-report.docx")
doc2.add_heading("Appendix", level=2)
doc2.add_paragraph("Added on revision.")
doc2.save("/word-report.docx")

check = Document("/word-report.docx")
headings = [p.text for p in check.paragraphs if p.style.name.startswith("Heading")]
assert "Quarterly report" in headings, headings
assert "Appendix" in headings, headings
assert len(check.tables) == 1 and len(check.tables[0].rows) == 2
assert check.tables[0].rows[0].cells[0].text == "Region"
"headings verified, table re-read"
`);
	return out;
});

await check("excel", async () => {
	await install("openpyxl");
	const out = await run(`
import openpyxl
from openpyxl.chart import BarChart, Reference

wb = openpyxl.Workbook()
ws = wb.active
ws.title = "Revenue"
ws.append(("Region", "Revenue"))
for row in (("North", 120), ("South", 95), ("East", 143)):
    ws.append(row)
ws["B6"] = "=SUM(B2:B4)"
ws["B6"].number_format = "#,##0"
chart = BarChart()
chart.title = "Revenue by region"
chart.add_data(Reference(ws, min_col=2, min_row=1, max_row=4), titles_from_data=True)
chart.set_categories(Reference(ws, min_col=1, min_row=2, max_row=4))
ws.add_chart(chart, "D2")
wb.save("/excel-book.xlsx")

import pandas as pd
frame = pd.read_excel("/excel-book.xlsx", usecols="A:B", nrows=3)
assert list(frame.columns) == ["Region", "Revenue"], frame.columns
assert frame["Revenue"].sum() == 358

book = openpyxl.load_workbook("/excel-book.xlsx")
sheet = book["Revenue"]
assert sheet["B6"].value == "=SUM(B2:B4)"
assert sheet["B6"].number_format == "#,##0"
assert len(sheet._charts) == 1
"sheets=" + repr(book.sheetnames) + " charts=1 formula kept"
`);
	return out;
});

await check("pdf", async () => {
	await install("reportlab", "pypdf");
	const out = await run(`
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle
from reportlab.lib import colors

styles = getSampleStyleSheet()
flow = [
    Paragraph("Incident summary", styles["Title"]),
    Spacer(1, 12),
    Paragraph("The gateway shed traffic for eleven minutes.", styles["BodyText"]),
]
table = Table([["Metric", "Value"], ["Downtime", "11 min"], ["Requests lost", "1,204"]])
table.setStyle(TableStyle([("GRID", (0, 0), (-1, -1), 0.5, colors.grey)]))
flow.append(table)
SimpleDocTemplate("/pdf-report.pdf", pagesize=A4).build(flow)

from pypdf import PdfReader
reader = PdfReader("/pdf-report.pdf")
text = reader.pages[0].extract_text()
assert len(reader.pages) == 1
assert "Incident summary" in text, text[:200]
assert "1,204" in text, text[:200]
"pages=1 text verified"
`);
	return out;
});

await check("pdf-tools", async () => {
	await install("pypdf", "reportlab");
	await importScript(`${builtinDir}/pdf-tools/scripts/pdf_tools.py`, "pdf_tools.py", "pdf_tools");
	await run(`
from reportlab.pdfgen import canvas
c = canvas.Canvas("/pt-a.pdf")
c.setFont("Helvetica", 12); c.drawString(72, 700, "Page A: terms")
c.acroForm.textfield(name="Name", x=72, y=600, width=200, height=20)
c.acroForm.textfield(name="Email", x=72, y=560, width=200, height=20)
c.save()
c = canvas.Canvas("/pt-b.pdf")
c.setFont("Helvetica", 12); c.drawString(72, 700, "Page B: appendix")
c.save()
`);
	await run(`
import pdf_tools
merged = pdf_tools.merge_pdfs(["/pt-a.pdf", "/pt-b.pdf"], "/pt-merged.pdf")
assert merged == "/pt-merged.pdf"

from pypdf import PdfReader
assert len(PdfReader("/pt-merged.pdf").pages) == 2

parts = pdf_tools.split_pdf("/pt-merged.pdf", prefix="pt-part")
assert parts == ["pt-part-1.pdf", "pt-part-2.pdf"], parts

pdf_tools.rotate_pages("/pt-merged.pdf", 90, pages=[2], out_path="/pt-rotated.pdf")
rotated = PdfReader("/pt-rotated.pdf")
assert str(rotated.pages[1].get("/Rotate")) in ("90", "None", "270"), "rotate applied"

pdf_tools.reorder_pages("/pt-merged.pdf", [2, 1], "/pt-reordered.pdf")
first = PdfReader("/pt-reordered.pdf").pages[0].extract_text()
assert "Page B" in first, first[:120]

fields = pdf_tools.form_fields("/pt-a.pdf")
assert set(fields) >= {"Name", "Email"}, fields

pdf_tools.fill_form("/pt-a.pdf", {"Name": "Ada Lovelace", "Email": "ada@example.org"}, "/pt-filled.pdf")
filled = PdfReader("/pt-filled.pdf")
values = {name: str(field.get("/V", "")) for name, field in (filled.get_fields() or {}).items()}
assert values.get("Name") == "Ada Lovelace", values

text = pdf_tools.extract_text("/pt-merged.pdf")
assert "terms" in text[1], text[1][:120]

info = pdf_tools.read_metadata("/pt-merged.pdf")
assert isinstance(info, dict)

pdf_tools.encrypt_pdf("/pt-merged.pdf", "secret", "/pt-locked.pdf")
locked = PdfReader("/pt-locked.pdf")
assert locked.is_encrypted
pdf_tools.decrypt_pdf("/pt-locked.pdf", "secret", "/pt-open.pdf")
assert not PdfReader("/pt-open.pdf").is_encrypted
"merge/split/rotate/reorder/form/encrypt all verified"
`);
	return "pdf_tools.py functions exercised in the sandbox";
});

await check("powerpoint", async () => {
	await install("python-pptx");
	await importScript(`${builtinDir}/powerpoint/scripts/generate.py`, "generate.py", "generate");
	await importScript(`${builtinDir}/powerpoint/scripts/edit.py`, "edit.py", "edit");
	await importScript(`${builtinDir}/powerpoint/scripts/validate.py`, "validate.py", "validate");
	const out = await run(`
outline = """
# Slide 1: Operations review

Prepared by the platform team
March 2026

---

# Slide 2: Three outcomes

**Visual: column-3**

**What this review settles.**

[Column 1: Discover]
- Stakeholder interviews
- Competitive audit

[Column 2: Define]
- Workshop facilitation
- Personas drafted

[Column 3: Deliver]
- Architecture decided
- Rollout plan agreed

---

# Slide 3: The quarter in numbers

**Visual: table**

| Metric | Q1 | Q2 |
| Uptime | 99.95% | 99.97% |
| Tickets | 412 | 350 |

---

# Slide 4: On the record

**Visual: quote-hero**

> We stopped guessing and started measuring.

---
"""
open("/outline.md", "w").write(outline)

import generate, validate, edit
result = generate.generate("/outline.md", "/deck.pptx")
assert result["slides"] == 4, result
assert result["out_path"] == "/deck.pptx"

report = validate.validate("/deck.pptx")
assert report["errors"] == [], report
assert report["slides"] == 4  # exactly the outline's slides — the default template carries none

from pptx import Presentation
deck = Presentation("/deck.pptx")
assert len(deck.slides._sldIdLst) == 4
titles = []
for slide in deck.slides:
    for shape in slide.shapes:
        if shape.has_text_frame and shape.is_placeholder and shape.placeholder_format.idx == 0:
            titles.append(shape.text_frame.text.strip())
assert any("quarter in numbers" in t for t in titles), titles

inv = edit.inventory("/deck.pptx")
changed = {}
for slide_key, shapes in inv.items():
    for shape_key, shape in shapes.items():
        for paragraph in shape["paragraphs"]:
            if "Personas drafted" in paragraph["text"]:
                changed.setdefault(slide_key, {})[shape_key] = {"paragraphs": [{"id": paragraph["id"], "text": "Personas shipped"}]}
assert changed, "no editable paragraph found"
applied = edit.replace("/deck.pptx", changed, "/deck-edited.pptx")
assert applied["applied"] >= 1 and applied["missing"] == [], applied

edit.reorder("/deck-edited.pptx", [4, 1, 2, 3], "/deck-reordered.pptx")
reordered = Presentation("/deck-reordered.pptx")
assert len(reordered.slides._sldIdLst) == 4
after = validate.validate("/deck-reordered.pptx")
assert after["errors"] == [], after
"generate 4 slides + validate clean + edit applied + reorder"
`);
	return out;
});

await check("charts", async () => {
	await install("seaborn");
	put(`${builtinDir}/charts/assets/publication.mplstyle`, "/publication.mplstyle");
	const out = await run(`
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import seaborn as sns
import pandas as pd

plt.style.use("/publication.mplstyle")
frame = pd.DataFrame({"time": [0, 1, 2, 3, 4], "response": [1.2, 2.1, 2.9, 3.4, 4.8]})
ax = sns.lineplot(data=frame, x="time", y="response", marker="o")
ax.set(xlabel="Time (hours)", ylabel="Response (unit)")
ax.get_figure().savefig("/chart-response.png", dpi=300)

from PIL import Image
with Image.open("/chart-response.png") as image:
    assert image.size[0] > 300 and image.size[1] > 200, image.size
"seaborn figure saved and re-opened, style file applied"
`);
	return out;
});

await check("data-analysis", async () => {
	const out = await run(`
import numpy as np
import pandas as pd
from scipy import stats
import statsmodels.api as sm
from statsmodels.formula.api import ols

rng = np.random.default_rng(7)
a = pd.Series(rng.normal(10.0, 2.0, 40))
b = pd.Series(rng.normal(11.2, 2.2, 44))
frame = pd.DataFrame({"score": np.concatenate([a, b]), "group": ["a"] * 40 + ["b"] * 44})

print(frame.describe().T[["mean", "std", "count"]])
t, p = stats.ttest_ind(a, b, equal_var=False)
assert 0.0 <= p <= 1.0 and p < 0.05, (t, p)

def cohens_d(x, y):
    nx, ny = len(x), len(y)
    pooled = np.sqrt(((nx - 1) * x.var(ddof=1) + (ny - 1) * y.var(ddof=1)) / (nx + ny - 2))
    return (x.mean() - y.mean()) / pooled
d = cohens_d(a, b)
assert d < 0, d  # a is the lower-scoring group in this fixture

model = ols("score ~ C(group)", data=frame).fit()
table = sm.stats.anova_lm(model, typ=2)
assert "C(group)" in table.index and "PR(>F)" in table.columns, table.columns
"welch t + cohens d + anova_lm on a fixed fixture"
`);
	return out;
});

await check("business-writing", () => {
	const body = readFileSync(
		path.join(repoRoot, builtinDir, "business-writing/references/examples/3p-updates.md"),
		"utf8"
	);
	if (!/progress/i.test(body)) throw new Error("the 3p-updates guideline lost its structure");
	return "bundled guidelines present as text";
});

await check("themes", () => {
	const theme = readFileSync(
		path.join(repoRoot, builtinDir, "themes/references/themes/modern-minimalist.md"),
		"utf8"
	);
	if (!/#36454f/.test(theme)) throw new Error("the modern-minimalist theme lost its palette");
	return "ten themes bundled as text with their palettes";
});

server.close();

const failed = Object.entries(results).filter(([, value]) => !value.ok);
if (process.argv.includes("--json")) {
	console.log(JSON.stringify(results, null, 2));
} else {
	console.log(`\n${Object.keys(results).length} checks, ${failed.length} failed`);
}
process.exit(failed.length ? 1 : 0);
