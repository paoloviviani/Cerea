/**
 * Vendor the wheels the office skills need — plus the interpreter's own
 * micropip — into `static/pyodide/`, so `micropip.install(...)` works with
 * the network gate UNCHANGED: no third-party request ever leaves the
 * browser (rung (a) of the packages plan; see docs/pyodide.md).
 *
 * micropip resolves a requirement through two entirely different paths, and
 * this script populates both:
 *
 * - "Lock" packages — EVERY package `pyodide-lock.json` lists (the full built
 *   set: numpy, pandas, scipy, scikit-learn, matplotlib, the office skills'
 *   compiled deps lxml/Pillow, micropip itself, …) — are fetched from the
 *   Pyodide release that matches the pinned npm package version exactly (same
 *   ABI tag), and placed beside `pyodide-lock.json`. `pyodide.loadPackage()`
 *   resolves them from the interpreter's own indexURL, the same origin the gate
 *   already allows. Without micropip's own wheel here, `import micropip` raises
 *   ModuleNotFoundError — this Pyodide release does not auto-bootstrap it — so
 *   it too is one of the lock files vendored. This is the full ~300MB set
 *   (ADR 0073 rung b): any lock package installs offline, same-origin.
 *
 * - The document packages themselves (python-docx, openpyxl, et-xmlfile,
 *   pypdf, python-pptx, XlsxWriter) are NOT in the lock: they are ordinary
 *   pure-Python PyPI wheels. micropip resolves a bare package name through
 *   its own index protocol, which a flat directory of .whl files does not
 *   satisfy — verified empirically against a real Pyodide-in-Node run: it
 *   needs a PEP 503 "Simple" HTML index page per package name. This script
 *   generates those pages too, one per package, alongside the wheels under
 *   `wheels/`.
 *
 * Every wheel is pinned by exact sha256, verified after download: this is a
 * vendoring decision (unlike the core runtime files, mirrored verbatim from
 * the npm package), so integrity is this script's job, not npm's.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const packageRoot = path.resolve("node_modules/pyodide");
const outRoot = path.resolve("static/pyodide");
const wheelsRoot = path.join(outRoot, "wheels");

const pkg = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
const lock = JSON.parse(await readFile(path.join(packageRoot, "pyodide-lock.json"), "utf8"));
const PYODIDE_CDN = `https://cdn.jsdelivr.net/pyodide/v${pkg.version}/full/`;

/**
 * Pure-Python PyPI wheels, hand-pinned (not in pyodide-lock.json). Each
 * sha256 was verified against the file downloaded from PyPI at authoring
 * time; a mismatch here means the upstream file changed and must be
 * re-verified before trusting it, never silently accepted.
 */
const PYPI_WHEELS = [
	{
		name: "python-docx",
		version: "1.2.0",
		filename: "python_docx-1.2.0-py3-none-any.whl",
		url: "https://files.pythonhosted.org/packages/d0/00/1e03a4989fa5795da308cd774f05b704ace555a70f9bf9d3be057b680bcf/python_docx-1.2.0-py3-none-any.whl",
		sha256: "3fd478f3250fbbbfd3b94fe1e985955737c145627498896a8a6bf81f4baf66c7",
		license: "MIT",
	},
	{
		name: "openpyxl",
		version: "3.1.5",
		filename: "openpyxl-3.1.5-py2.py3-none-any.whl",
		url: "https://files.pythonhosted.org/packages/c0/da/977ded879c29cbd04de313843e76868e6e13408a94ed6b987245dc7c8506/openpyxl-3.1.5-py2.py3-none-any.whl",
		sha256: "5282c12b107bffeef825f4617dc029afaf41d0ea60823bbb665ef3079dc79de2",
		license: "MIT",
	},
	{
		name: "et-xmlfile",
		version: "2.0.0",
		filename: "et_xmlfile-2.0.0-py3-none-any.whl",
		url: "https://files.pythonhosted.org/packages/c1/8b/5fe2cc11fee489817272089c4203e679c63b570a5aaeb18d852ae3cbba6a/et_xmlfile-2.0.0-py3-none-any.whl",
		sha256: "7a91720bc756843502c3b7504c77b8fe44217c85c537d85037f0f536151b2caa",
		license: "MIT",
	},
	{
		name: "pypdf",
		version: "6.19.0",
		filename: "pypdf-6.19.0-py3-none-any.whl",
		url: "https://files.pythonhosted.org/packages/3c/2c/c43c03eaf630435f023f1dc61ec4a4a78951ad5530a62c71cc89bde307b7/pypdf-6.19.0-py3-none-any.whl",
		sha256: "7e5d6e730e7dae87d560a2cee218b852f6498c8be61966f3cd02ead971e48d14",
		license: "BSD-3-Clause",
	},
	{
		name: "python-pptx",
		version: "1.0.2",
		filename: "python_pptx-1.0.2-py3-none-any.whl",
		url: "https://files.pythonhosted.org/packages/d9/4f/00be2196329ebbff56ce564aa94efb0fbc828d00de250b1980de1a34ab49/python_pptx-1.0.2-py3-none-any.whl",
		sha256: "160838e0b8565a8b1f67947675886e9fea18aa5e795db7ae531606d68e785cba",
		license: "MIT",
	},
	{
		name: "xlsxwriter",
		version: "3.2.9",
		filename: "xlsxwriter-3.2.9-py3-none-any.whl",
		url: "https://files.pythonhosted.org/packages/3a/0c/3662f4a66880196a590b202f0db82d919dd2f89e99a27fadef91c4a33d41/xlsxwriter-3.2.9-py3-none-any.whl",
		sha256: "9a5db42bc5dff014806c58a20b9eae7322a134abb6fce3c92c181bfb275ec5b3",
		license: "BSD-2-Clause",
	},
];

/** PEP 503: lowercase, runs of `-_.` collapsed to a single `-`. */
function canonicalize(name) {
	return name.toLowerCase().replace(/[-_.]+/g, "-");
}

async function sha256Of(filePath) {
	const data = await readFile(filePath);
	return createHash("sha256").update(data).digest("hex");
}

async function alreadyCurrent(filePath, expectedSha256) {
	try {
		await stat(filePath);
	} catch {
		return false;
	}
	return (await sha256Of(filePath)) === expectedSha256;
}

async function fetchAndVerify(url, destPath, expectedSha256, label) {
	if (await alreadyCurrent(destPath, expectedSha256)) return false;
	const res = await fetch(url);
	if (!res.ok) throw new Error(`${label}: ${res.status} ${res.statusText} fetching ${url}`);
	const buffer = Buffer.from(await res.arrayBuffer());
	const actual = createHash("sha256").update(buffer).digest("hex");
	if (actual !== expectedSha256) {
		throw new Error(
			`${label}: sha256 mismatch fetching ${url}\n  expected ${expectedSha256}\n  got      ${actual}\n` +
				"Refusing to vendor a file that doesn't match its pin — re-verify before updating the pin."
		);
	}
	await writeFile(destPath, buffer);
	return true;
}

/** Run `fn` over `items` with at most `limit` in flight; downloads are IO-bound. */
async function mapLimit(items, limit, fn) {
	let cursor = 0;
	const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (cursor < items.length) {
			const index = cursor++;
			await fn(items[index]);
		}
	});
	await Promise.all(workers);
}

await mkdir(outRoot, { recursive: true });
await mkdir(wheelsRoot, { recursive: true });

let downloaded = 0;

// EVERY built package in the lock, beside pyodide-lock.json — the full
// same-origin package set (ADR 0073 rung b), so any import (numpy, pandas,
// scipy, scikit-learn, matplotlib, the office skills' compiled deps, micropip
// itself) resolves through `loadPackage`/micropip with the gate unchanged and
// no third-party request. file_name and sha256 come from the lock, the
// authority for this pinned release; nothing here is hand-pinned. This is
// ~300MB and the deliberate cost of "any lock package works offline"; the
// sha256 short-circuit in fetchAndVerify makes a re-run with a warm
// static/pyodide/ nearly free. Bounded concurrency keeps a cold build (357
// files) to a few minutes rather than an hour of sequential fetches.
const lockNames = Object.keys(lock.packages);
await mapLimit(lockNames, 10, async (name) => {
	const entry = lock.packages[name];
	const url = `${PYODIDE_CDN}${entry.file_name}`;
	const dest = path.join(outRoot, entry.file_name);
	if (await fetchAndVerify(url, dest, entry.sha256, name)) downloaded += 1;
});

// Pure PyPI wheels, under wheels/, plus one PEP 503 Simple HTML index per
// package so `micropip.install("<name>")` (a bare name, not a URL) can find
// them — a flat directory of .whl files alone does not satisfy micropip's
// index protocol.
for (const entry of PYPI_WHEELS) {
	const dest = path.join(wheelsRoot, entry.filename);
	if (await fetchAndVerify(entry.url, dest, entry.sha256, entry.name)) downloaded += 1;

	const canonical = canonicalize(entry.name);
	const indexPath = path.join(wheelsRoot, `${canonical}.html`);
	const indexHtml =
		"<!DOCTYPE html>\n<html><body>\n" +
		`<a href="${entry.filename}#sha256=${entry.sha256}">${entry.filename}</a>\n` +
		"</body></html>\n";
	await writeFile(indexPath, indexHtml);
}

// Attribution for the vendored wheels, alongside the existing Pyodide notice.
const noticeLines = [
	"Vendored wheels for the code-execution sandbox's document packages.",
	"Fetched from PyPI (files.pythonhosted.org) and pinned by exact sha256 in",
	"scripts/sync_pyodide_wheels.mjs; served same-origin so micropip.install(...)",
	"works with the network gate unchanged.",
	"",
	...PYPI_WHEELS.map((e) => `${e.name} ${e.version} — ${e.license} — ${e.filename}`),
	"",
	`Plus all ${lockNames.length} built packages of the pinned Pyodide release`,
	"(https://cdn.jsdelivr.net/pyodide/), mirrored verbatim beside pyodide-lock.json.",
	"Each carries its own upstream licence; pyodide-lock.json is the authoritative",
	"list of names, versions and files.",
	"",
];
await writeFile(path.join(wheelsRoot, "NOTICE.txt"), noticeLines.join("\n"));

console.log(
	`[sync-pyodide-wheels] pyodide ${pkg.version}: ${downloaded} file(s) downloaded, ` +
		`${lockNames.length} lock package(s) + ${PYPI_WHEELS.length} PyPI wheel(s) vendored.`
);
