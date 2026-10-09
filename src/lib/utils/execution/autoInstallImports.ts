/**
 * Import name -> vendored wheel package name, for the document packages this
 * deployment ships as plain PyPI wheels (scripts/sync_pyodide_wheels.mjs)
 * rather than through Pyodide's own lock file: a static scan of a run's
 * imports only ever sees the import name it wrote, which for these differs
 * from what micropip needs to install.
 */
export const VENDORED_PACKAGE_BY_IMPORT: Record<string, string> = {
	docx: "python-docx",
	pptx: "python-pptx",
	openpyxl: "openpyxl",
	pypdf: "pypdf",
	reportlab: "reportlab",
	seaborn: "seaborn",
};

/**
 * The slice of the Pyodide API this needs, so the install logic itself can be
 * driven from a plain object in a unit test rather than a real interpreter.
 */
export interface AutoInstallHost {
	/** A run's top-level import names (a static/AST scan, not an execution). */
	findImports(code: string): string[];
	/** Pyodide's own lock-file packages the code imports (no-ops on unknown names). */
	loadPackagesFromImports(code: string): Promise<unknown>;
	/** Install one vendored package by name through micropip. */
	installPackage(packageName: string): Promise<void>;
	/** Called just before an install is attempted, to surface it in the run's output. */
	onInstalling?(packageName: string): void;
}

/**
 * Install a run's own imports before it runs, so e.g. `from docx import
 * Document` with no `micropip.install` just works. Two tiers: Pyodide's own
 * lock-file packages via `loadPackagesFromImports`, and the vendored document
 * packages above through micropip. Best-effort throughout: an import this
 * cannot resolve, or an install that fails, is left for the run itself to
 * raise as its normal `ModuleNotFoundError` rather than failing here.
 *
 * `installed` is the caller's cache of vendored packages already installed
 * this interpreter's lifetime, so a run that imports the same package twice
 * pays the install once.
 */
export async function autoInstallImports(
	host: AutoInstallHost,
	code: string,
	installed: Set<string>
): Promise<void> {
	let importNames: string[];
	try {
		importNames = host.findImports(code);
	} catch {
		return;
	}
	try {
		await host.loadPackagesFromImports(code);
	} catch {
		// Best-effort: the run itself will raise the real error.
	}
	for (const importName of importNames) {
		const packageName = VENDORED_PACKAGE_BY_IMPORT[importName];
		if (!packageName || installed.has(packageName)) continue;
		try {
			host.onInstalling?.(packageName);
			await host.installPackage(packageName);
			installed.add(packageName);
		} catch {
			// Best-effort: the run itself will raise the real error.
		}
	}
}
