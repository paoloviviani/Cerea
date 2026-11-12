/**
 * The galopin container's entrypoint (`agent/packaging/docker-entrypoint.sh`),
 * run for real with a fake `galopin` that records how it was called. What the
 * Pair dialog's Docker command relies on: the arguments after `start` reach
 * `galopin enroll` exactly as written (a path with spaces and a glob survive),
 * then `galopin run` follows; and the older ways in (the environment, an
 * enrolled home, nothing) still do what the docs say.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(
	new URL("../../agent/packaging/docker-entrypoint.sh", import.meta.url)
);

let work: string;
beforeEach(() => {
	work = mkdtempSync(join(tmpdir(), "entrypoint-"));
	mkdirSync(join(work, "bin"));
	mkdirSync(join(work, "home"));
	writeFileSync(
		join(work, "bin", "galopin"),
		'#!/bin/bash\nprintf "%s\\n" "$(IFS="|"; echo "$*")" >> "$GALOPIN_LOG"\n'
	);
	chmodSync(join(work, "bin", "galopin"), 0o755);
});
afterEach(() => rmSync(work, { recursive: true, force: true }));

/** The calls galopin got, in order, each as its arguments joined by `|`. */
function calls(args: string[], env: Record<string, string> = {}): string[] {
	const log = join(work, "log");
	writeFileSync(log, "");
	try {
		execFileSync("bash", [SCRIPT, "start", ...args], {
			env: {
				PATH: `${join(work, "bin")}:/usr/bin:/bin`,
				HOME: join(work, "home"),
				GALOPIN_LOG: log,
				...env,
			},
			input: "",
			stdio: ["pipe", "ignore", "ignore"],
		});
	} catch {
		// `start` with nothing to do ends in an interactive bash that exits on EOF.
	}
	return readFileSync(log, "utf8").split("\n").filter(Boolean);
}

function enrolledHome() {
	mkdirSync(join(work, "home", ".config", "galopin"), { recursive: true });
	writeFileSync(join(work, "home", ".config", "galopin", "credentials.json"), "{}");
}

describe("docker-entrypoint.sh start", () => {
	it("ARGS: enrolls with exactly those arguments, then runs", () => {
		expect(
			calls(["--issuer", "https://x/auth", "--workspace-root", "/my path/*", "--default-group"])
		).toEqual([
			"enroll|--issuer|https://x/auth|--workspace-root|/my path/*|--default-group",
			"run",
		]);
	});

	it("ARGS beat the environment and an enrolled home", () => {
		enrolledHome();
		expect(calls(["--issuer", "I"], { GATEWAY_BASE_URL: "https://g" })).toEqual([
			"enroll|--issuer|I",
			"run",
		]);
	});

	it("no ARGS, enrolled: runs the agent and does not enroll again", () => {
		enrolledHome();
		expect(calls([])).toEqual(["run"]);
	});

	it("no ARGS, GATEWAY_BASE_URL: enrolls from the environment with the kit's defaults, then runs", () => {
		expect(calls([], { GATEWAY_BASE_URL: "https://g/", GALOPIN_ENROLL_ARGS: "--device" })).toEqual([
			"enroll|--issuer|https://g/authelia|--gateway|https://g|--cerea|https://g/chat|--device",
			"run",
		]);
	});

	it("no ARGS, nothing else: calls galopin not at all (a shell with instructions)", () => {
		expect(calls([])).toEqual([]);
	});

	it("any other command runs as it is", () => {
		const log = join(work, "log");
		writeFileSync(log, "");
		execFileSync("bash", [SCRIPT, "galopin", "auth", "status"], {
			env: {
				PATH: `${join(work, "bin")}:/usr/bin:/bin`,
				HOME: join(work, "home"),
				GALOPIN_LOG: log,
			},
		});
		expect(readFileSync(log, "utf8").trim()).toBe("auth|status");
	});
});
