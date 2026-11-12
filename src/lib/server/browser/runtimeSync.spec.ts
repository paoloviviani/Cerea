/**
 * The runtime keeps copies of the files Cerea owns (`browser-runtime/scripts/sync-contract.mjs`
 * writes them). On a branch that has the runtime, this recomputes what the sync would write from
 * Cerea's files and fails when the runtime's copy differs: a contract that drifted shows up here,
 * not as a parse error on a user's machine. Skipped on a branch without the runtime.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const here = resolve(process.cwd(), "src/lib/server/browser");
const runtime = resolve(process.cwd(), "browser-runtime/src");
const read = (dir: string, name: string) => readFileSync(join(dir, name), "utf8");

// The same transforms as sync-contract.mjs.
const fix = (text: string) =>
	text
		.replace(/from "\.\/(\w+)";/g, 'from "./$1.ts";')
		.replace('from "./sanitize.ts"', 'from "./cereaSanitize.ts"');
const header = (what: string) =>
	`/**\n * COPY of Cerea's \`src/lib/server/browser/${what}\` (made by scripts/sync-contract.mjs): never edit it here.\n */\n`;

function expectedContract(): string {
	let contract = read(here, "contract.ts");
	contract =
		contract.slice(0, contract.indexOf("// ----- the runtime, as Cerea calls it")).trimEnd() + "\n";
	return contract.replace(
		"/**\n",
		"/**\n * COPY of Cerea's `src/lib/server/browser/contract.ts` (made by scripts/sync-contract.mjs): never\n * edit it here. The runtime validates its own answers against these schemas in tests, so a drift\n * shows up as a failing test, not as a parse error in production.\n *\n"
	);
}

describe.skipIf(!existsSync(join(runtime, "contract.ts")))(
	"the runtime's copies of Cerea's files",
	() => {
		it("contract.ts is in sync (run browser-runtime/scripts/sync-contract.mjs)", () => {
			expect(read(runtime, "contract.ts")).toBe(expectedContract());
		});
		it.each([
			["classifier.ts", "classifier.ts", "classifier.ts"],
			["siteRules.ts", "siteRules.ts", "siteRules.ts"],
			["cereaSanitize.ts", "sanitize.ts", "sanitize.ts"],
		])("%s is in sync", (copy, source, label) => {
			expect(read(runtime, copy)).toBe(header(label) + fix(read(here, source)));
		});
	}
);
