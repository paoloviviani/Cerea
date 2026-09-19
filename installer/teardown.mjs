/**
 * Tearing down what `install.mjs` brought up.
 *
 *   node installer/teardown.mjs [--pystino <path>] [--backup] [--images] [--all] [--yes]
 *
 * The installer is here, so the uninstaller is here — an operator who has only
 * ever run a command from this repository should not have to know that the
 * compose files, and the script that does the work, live in the other one.
 *
 * It does not reimplement the teardown. Pystino's `deploy/teardown.sh` is the
 * single implementation and this hands straight over to it, flags and all. Two
 * copies of "remove these containers and these volumes" would drift, and the
 * half that drifted would be discovered on the day somebody needed it to be
 * right.
 *
 * Finding the Pystino checkout: ask Docker first. Every container compose
 * created carries `com.docker.compose.project.config_files`, the absolute
 * paths of the files it was brought up with — so a running deployment says
 * where it came from, which beats guessing and beats asking. `--pystino`
 * overrides, a sibling directory is the last resort, and if none of the three
 * finds it the error says which flag to pass rather than doing something
 * approximate.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const PROJECT = "llm-platform";

function paint(text, colour) {
	const codes = { bold: "1", red: "31", yellow: "33", dim: "2" };
	return `[${codes[colour] ?? "0"}m${text}[0m`;
}

function fail(message) {
	console.error(paint(`\n${message}\n`, "red"));
	process.exit(1);
}

/** The deployment's own answer: where were its compose files read from? */
function rootFromRunningDeployment() {
	const ids = spawnSync(
		"docker",
		["ps", "-aq", "--filter", `label=com.docker.compose.project=${PROJECT}`],
		{ encoding: "utf8" }
	);
	const first = (ids.stdout ?? "").trim().split("\n")[0];
	if (!first) return null;

	const inspect = spawnSync(
		"docker",
		[
			"inspect",
			first,
			"--format",
			'{{index .Config.Labels "com.docker.compose.project.config_files"}}',
		],
		{ encoding: "utf8" }
	);
	const configFile = (inspect.stdout ?? "").trim().split(",")[0];
	if (!configFile || !path.isAbsolute(configFile)) return null;

	// .../<root>/deploy/compose/docker-compose.yml → <root>
	const root = path.resolve(path.dirname(configFile), "..", "..");
	return isPystinoRoot(root) ? root : null;
}

function isPystinoRoot(dir) {
	return fs.existsSync(path.join(dir, "deploy", "compose", "docker-compose.yml"));
}

function resolveRoot(cliPath) {
	if (cliPath) {
		const resolved = path.resolve(cliPath);
		if (!isPystinoRoot(resolved)) fail(`not a Pystino checkout: ${resolved}`);
		return resolved;
	}

	const fromDocker = rootFromRunningDeployment();
	if (fromDocker) return fromDocker;

	for (const guess of ["../Pystino", "../pystino"]) {
		const resolved = path.resolve(process.cwd(), guess);
		if (isPystinoRoot(resolved)) return resolved;
	}

	fail(
		"Could not find the Pystino checkout.\n" +
			"Nothing of this deployment is running (so Docker cannot say where it came\n" +
			"from) and no sibling checkout was found. Pass it:\n\n" +
			"  node installer/teardown.mjs --pystino /path/to/Pystino"
	);
}

function main() {
	const argv = process.argv.slice(2);
	if (argv.includes("--help") || argv.includes("-h")) {
		console.log(
			"Usage: node installer/teardown.mjs [--pystino <path>] [--backup] [--images] [--all] [--yes]\n\n" +
				"  --backup   save deploy/.env, the profile fragments and database dumps first\n" +
				"  --images   also remove the images this deployment built\n" +
				"  --all      --backup and --images together\n" +
				"  --yes      skip the confirmation prompt\n\n" +
				"Removes the containers, named volumes and networks of the `" +
				PROJECT +
				"` project.\n" +
				"Hands over to Pystino's deploy/teardown.sh, which is where the work lives."
		);
		process.exit(0);
	}

	const pystinoIndex = argv.indexOf("--pystino");
	const cliPath = pystinoIndex === -1 ? null : (argv[pystinoIndex + 1] ?? null);
	if (pystinoIndex !== -1 && !cliPath) fail("--pystino needs a path");

	const root = resolveRoot(cliPath);
	const script = path.join(root, "deploy", "teardown.sh");
	if (!fs.existsSync(script)) {
		fail(
			`This Pystino checkout has no deploy/teardown.sh:\n  ${root}\n\n` +
				"It predates the script. Either update that checkout, or remove the\n" +
				"deployment by hand:\n\n" +
				`  docker ps -aq --filter label=com.docker.compose.project=${PROJECT} | xargs -r docker rm -fv\n` +
				`  docker volume ls -q --filter name=^${PROJECT}_ | xargs -r docker volume rm`
		);
	}

	// Everything except --pystino and its value goes through untouched, so this
	// stays a door rather than a second set of options to keep in step.
	const passthrough = [];
	for (let i = 0; i < argv.length; i += 1) {
		if (argv[i] === "--pystino") {
			i += 1;
			continue;
		}
		passthrough.push(argv[i]);
	}

	console.log(paint("\nCerea + Pystino teardown", "bold"));
	console.log(`Pystino checkout: ${root}`);
	console.log(paint(`running ${script}\n`, "dim"));

	const run = spawnSync("bash", [script, ...passthrough], { stdio: "inherit", cwd: root });
	process.exit(run.status ?? 1);
}

main();
