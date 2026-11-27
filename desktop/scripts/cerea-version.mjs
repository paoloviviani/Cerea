// The Cerea version (the root package.json's): what the app and its galopin report, so a build says
// which Cerea release it was made from. desktop/package.json keeps a placeholder version.
import { readFileSync } from "node:fs";
import { join } from "node:path";

export function cereaVersion() {
	const v = JSON.parse(
		readFileSync(join(import.meta.dirname, "..", "..", "package.json"), "utf8")
	).version;
	if (!/^\d+\.\d+\.\d+$/.test(v ?? "")) throw new Error(`no X.Y.Z version in package.json: ${v}`);
	return v;
}
