// Bundles the runtime into one ES module that galopin embeds and installs next to a pinned
// playwright-core (the one dependency left external: it ships its own browser driver).
//   npm run bundle        writes ../agent/internal/browserrt/cerea-browser.mjs and package.json
// The bundle starts with the hash of the sources it was made from; a Go test checks it, so a stale
// bundle fails CI instead of shipping.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { build } from "esbuild";

const root = join(import.meta.dirname, "..");
const target = join(root, "..", "agent", "internal", "browserrt");

export function sourceHash() {
	const files = readdirSync(join(root, "src"))
		.filter((f) => f.endsWith(".ts"))
		.sort();
	const h = createHash("sha256");
	for (const f of files)
		h.update(f)
			.update("\0")
			.update(readFileSync(join(root, "src", f)));
	h.update(readFileSync(join(root, "package.json")));
	return h.digest("hex");
}

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
mkdirSync(target, { recursive: true });
const result = await build({
	entryPoints: [join(root, "src", "main.ts")],
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	external: ["playwright-core"],
	tsconfig: join(root, "tsconfig.json"),
	write: false,
	legalComments: "none",
	banner: {
		js: `// cerea-browser runtime ${pkg.version}; source-hash: ${sourceHash()}\nimport { createRequire as __cr } from "node:module";\nconst require = __cr(import.meta.url);`,
	},
});
writeFileSync(join(target, "cerea-browser.mjs"), result.outputFiles[0].text);
writeFileSync(
	join(target, "package.json"),
	`${JSON.stringify(
		{
			name: "cerea-browser-runtime-install",
			private: true,
			type: "module",
			description: "Installed by `galopin browser setup`; do not edit.",
			dependencies: { "playwright-core": pkg.dependencies["playwright-core"] },
		},
		null,
		"\t"
	)}\n`
);
console.log(`bundled ${(result.outputFiles[0].text.length / 1024).toFixed(0)} KB`);
