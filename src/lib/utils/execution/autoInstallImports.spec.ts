import { describe, expect, it, vi } from "vitest";
import {
	autoInstallImports,
	VENDORED_PACKAGE_BY_IMPORT,
	type AutoInstallHost,
} from "./autoInstallImports";

function makeHost(overrides: Partial<AutoInstallHost> = {}): AutoInstallHost & {
	installed: string[];
	installing: string[];
} {
	const installed: string[] = [];
	const installing: string[] = [];
	return {
		findImports: vi.fn(() => []),
		loadPackagesFromImports: vi.fn(async () => undefined),
		installPackage: vi.fn(async (packageName: string) => {
			installed.push(packageName);
		}),
		onInstalling: (packageName: string) => installing.push(packageName),
		installed,
		installing,
		...overrides,
	};
}

describe("VENDORED_PACKAGE_BY_IMPORT", () => {
	it("maps the office-document imports to their vendored package names", () => {
		expect(VENDORED_PACKAGE_BY_IMPORT).toEqual({
			docx: "python-docx",
			pptx: "python-pptx",
			openpyxl: "openpyxl",
			pypdf: "pypdf",
		});
	});
});

describe("autoInstallImports", () => {
	it("installs the vendored package for a run's import, surfacing it first", async () => {
		const host = makeHost({ findImports: () => ["docx"] });
		const installed = new Set<string>();

		await autoInstallImports(host, "from docx import Document", installed);

		expect(host.installed).toEqual(["python-docx"]);
		expect(host.installing).toEqual(["python-docx"]);
		expect(installed.has("python-docx")).toBe(true);
	});

	it("also tries Pyodide's own lock-file packages via loadPackagesFromImports", async () => {
		const host = makeHost({ findImports: () => ["numpy"] });
		const installed = new Set<string>();

		await autoInstallImports(host, "import numpy as np", installed);

		expect(host.loadPackagesFromImports).toHaveBeenCalledWith("import numpy as np");
		// numpy has no vendored-package entry, so nothing is installed through micropip.
		expect(host.installed).toEqual([]);
	});

	it("skips an import with no vendored mapping and one already installed", async () => {
		const host = makeHost({ findImports: () => ["docx", "not_a_real_module_xyz"] });
		const installed = new Set<string>(["python-docx"]);

		await autoInstallImports(
			host,
			"from docx import Document\nimport not_a_real_module_xyz",
			installed
		);

		expect(host.installed).toEqual([]);
		expect(host.installing).toEqual([]);
	});

	it("does not reinstall a package already installed this interpreter's lifetime", async () => {
		const host = makeHost({ findImports: () => ["docx"] });
		const installed = new Set<string>();

		await autoInstallImports(host, "from docx import Document", installed);
		await autoInstallImports(host, "from docx import Document", installed);

		expect(host.installed).toEqual(["python-docx"]);
	});

	it("does not fail the run when an install throws", async () => {
		const host = makeHost({
			findImports: () => ["docx"],
			installPackage: vi.fn(async () => {
				throw new Error("network unreachable");
			}),
		});
		const installed = new Set<string>();

		await expect(
			autoInstallImports(host, "from docx import Document", installed)
		).resolves.toBeUndefined();
		expect(installed.has("python-docx")).toBe(false);
	});

	it("does not fail the run when loadPackagesFromImports throws", async () => {
		const host = makeHost({
			findImports: () => ["docx"],
			loadPackagesFromImports: vi.fn(async () => {
				throw new Error("lock file fetch failed");
			}),
		});
		const installed = new Set<string>();

		await expect(
			autoInstallImports(host, "from docx import Document", installed)
		).resolves.toBeUndefined();
		expect(installed.has("python-docx")).toBe(true);
	});

	it("does not fail the run when finding imports itself throws", async () => {
		const host = makeHost({
			findImports: vi.fn(() => {
				throw new Error("parse error");
			}),
		});
		const installed = new Set<string>();

		await expect(autoInstallImports(host, "not even python(", installed)).resolves.toBeUndefined();
		expect(host.loadPackagesFromImports).not.toHaveBeenCalled();
	});
});
