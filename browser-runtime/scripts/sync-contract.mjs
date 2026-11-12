// Re-copies the files Cerea owns (contract, classifier, site rules, sanitizer) from the Cerea
// server side, with the imports the runtime needs. Usage:
//   node scripts/sync-contract.mjs [path-to-src/lib/server/browser]
// Default: this repository's src/lib/server/browser.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.argv[2] ?? join(import.meta.dirname, "..", "..", "src", "lib", "server", "browser");
const read = (name) => readFileSync(join(root, name), "utf8");
const out = (name, text) => writeFileSync(join(import.meta.dirname, "..", "src", name), text);

let contract = read("contract.ts");
contract = contract.slice(0, contract.indexOf("// ----- the runtime, as Cerea calls it")).trimEnd() + "\n";
contract = contract.replace(
	"/**\n",
	"/**\n * COPY of Cerea's `src/lib/server/browser/contract.ts` (made by scripts/sync-contract.mjs): never\n * edit it here. The runtime validates its own answers against these schemas in tests, so a drift\n * shows up as a failing test, not as a parse error in production.\n *\n",
	1
);
out("contract.ts", contract);

const fix = (text) => text.replace(/from "\.\/(\w+)";/g, 'from "./$1.ts";').replace('from "./sanitize.ts"', 'from "./cereaSanitize.ts"');
const header = (what) => `/**\n * COPY of Cerea's \`src/lib/server/browser/${what}\` (made by scripts/sync-contract.mjs): never edit it here.\n */\n`;
out("classifier.ts", header("classifier.ts") + fix(read("classifier.ts")));
out("siteRules.ts", header("siteRules.ts") + fix(read("siteRules.ts")));
out("cereaSanitize.ts", header("sanitize.ts") + fix(read("sanitize.ts")));
console.log("synced from", root);
