import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The vendored token file is a byte copy of the console's, on purpose.
 *
 * Both repositories must stay independently clonable and buildable, so the
 * chat cannot read the console's file at build time — it vendors a copy
 * (`src/styles/tokens.css` plus `src/styles/fonts/`) instead. A copy with no
 * check is how two spellings of one setting diverge silently, so this test
 * makes divergence loud: when the sibling checkout is present it compares
 * the two files line by line, and when it is absent (this repo cloned alone,
 * CI without the console) the suite skips rather than failing the build for
 * a file that was never promised to be there.
 *
 * Stay out of `scripts/`: that directory belongs to the live checks.
 */
const VENDORED = new URL("./tokens.css", import.meta.url);
const SOURCE = new URL("../../../Pystino/packages/ui/src/tokens.css", import.meta.url);

const hasSource = existsSync(SOURCE);

describe.skipIf(!hasSource)("tokens.css drift", () => {
	it("is a byte copy of the console's tokens.css", () => {
		const vendored = readFileSync(VENDORED, "utf8").split("\n");
		const source = readFileSync(SOURCE, "utf8").split("\n");
		const diffs: Array<string> = [];
		const count = Math.max(vendored.length, source.length);
		for (let i = 0; i < count; i++) {
			const mine = vendored[i] ?? "(no line)";
			const theirs = source[i] ?? "(no line)";
			if (mine !== theirs) {
				diffs.push(`line ${i + 1}:\n    vendored: ${mine}\n    console:  ${theirs}`);
			}
		}
		expect(
			diffs,
			`token drift: src/styles/tokens.css differs from ` +
				`Pystino packages/ui/src/tokens.css in ${diffs.length} line(s). ` +
				`Copy the console's file (and fonts/ if @font-face changed) over the ` +
				`vendored one, or reconcile deliberately in both — never edit one side ` +
				`alone:\n${diffs.slice(0, 20).join("\n")}`
		).toEqual([]);
	});
});
