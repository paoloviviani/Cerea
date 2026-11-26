// Stages the browser runtime the app runs itself (ADR 0122) into resources/browser-runtime/, from
// where electron-builder ships it (extraResources). It is the very bundle galopin embeds
// (agent/internal/browserrt/cerea-browser.mjs, whose source hash a Go test checks), so the app and
// galopin run the same code, plus the one dependency the bundle leaves external: playwright-core,
// at the version galopin installs. The Node that runs it is the one the app ships (fetch-node.mjs).
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const bundle = join(root, "..", "agent", "internal", "browserrt");
const target = join(root, "resources", "browser-runtime");

const pinned = JSON.parse(readFileSync(join(bundle, "package.json"), "utf8")).dependencies[
	"playwright-core"
];
const installed = JSON.parse(
	readFileSync(join(root, "node_modules", "playwright-core", "package.json"), "utf8")
).version;
assert.equal(
	installed,
	pinned,
	`desktop has playwright-core ${installed}, the runtime bundle pins ${pinned}: keep them equal`
);
assert.ok(existsSync(join(bundle, "cerea-browser.mjs")), "the runtime bundle is missing");

rmSync(target, { recursive: true, force: true });
mkdirSync(join(target, "node_modules"), { recursive: true });
cpSync(join(bundle, "cerea-browser.mjs"), join(target, "cerea-browser.mjs"));
cpSync(
	join(root, "node_modules", "playwright-core"),
	join(target, "node_modules", "playwright-core"),
	{ recursive: true, dereference: true }
);
console.log(`staged the browser runtime (playwright-core ${installed}) in ${target}`);
