// Bundles main, preload and renderer with esbuild into dist/ (electron stays external).
import { build } from "esbuild";
import { cpSync, mkdirSync, rmSync } from "node:fs";

rmSync("dist", { recursive: true, force: true });
mkdirSync("dist/renderer", { recursive: true });
const common = {
	tsconfig: "tsconfig.json",
	bundle: true,
	sourcemap: false,
	logLevel: "info",
	target: "node22",
};
await build({
	...common,
	entryPoints: ["src/main/main.ts"],
	outfile: "dist/main/main.js",
	platform: "node",
	format: "cjs",
	external: ["electron"],
});
await build({
	...common,
	entryPoints: ["src/preload/ui.ts"],
	outfile: "dist/preload/ui.js",
	platform: "node",
	format: "cjs",
	external: ["electron"],
});
await build({
	...common,
	entryPoints: ["src/renderer/ui.ts"],
	outfile: "dist/renderer/ui.js",
	platform: "browser",
	format: "iife",
	target: "chrome140",
});
cpSync("src/renderer/index.html", "dist/renderer/index.html");
cpSync("src/renderer/style.css", "dist/renderer/style.css");
