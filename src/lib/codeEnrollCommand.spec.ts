import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
	buildDockerCommand,
	buildEnrollCommand,
	cleanContainerName,
	GALOPIN_IMAGE,
	quoteShellArg,
	DEFAULT_CODE_CLIENT_ID,
	GALOPIN_BIN,
	OPENCODE_VERSION,
} from "./codeEnrollCommand";
import { OPENCODE_SHA256 } from "./opencodeVersion";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const BASE_OPTIONS = {
	origin: "https://cerea.example.org/chat",
	issuer: "https://idp.example.org",
	gatewayOrigin: "https://gateway.example.org",
};

describe("buildEnrollCommand", () => {
	it("chains install, enroll and run, one step and one flag per line, default client id omitted", () => {
		const command = buildEnrollCommand(BASE_OPTIONS);

		// The dialog ticks "Bill to my default group" by default, so the
		// printed command carries --default-group even untouched (enroll's
		// own default stays off; the divergence is the dialog's, pinned in
		// codeEnrollPolicy.spec.ts).
		expect(command).toBe(
			[
				"curl -fsSL 'https://cerea.example.org/chat/galopin/install.sh' | sh &&",
				`${GALOPIN_BIN} enroll \\`,
				"  --cerea 'https://cerea.example.org/chat' \\",
				"  --default-group &&",
				`${GALOPIN_BIN} run`,
			].join("\n")
		);
	});

	it("is short by default: no issuer, gateway or client id, the binary asks this Cerea", () => {
		const command = buildEnrollCommand({ ...BASE_OPTIONS, clientId: "custom-client" });
		expect(command).not.toMatch(/--issuer|--gateway|--client-id/);
		expect(command).toContain("--cerea 'https://cerea.example.org/chat'");
	});

	it("spells the deployment's facts out when explicit, for an older galopin", () => {
		const command = buildEnrollCommand({
			...BASE_OPTIONS,
			clientId: "custom-client",
			explicit: true,
		});
		expect(command).toContain("--issuer 'https://idp.example.org' \\");
		expect(command).toContain("--gateway 'https://gateway.example.org' \\");
		expect(command).toContain("--client-id 'custom-client'");
	});

	it("invokes the binary by its installed path, not a bare name", () => {
		// A fresh machine has ~/.local/bin off PATH in the installing shell;
		// a bare `galopin` fails with "command not found" between the &&s.
		const command = buildEnrollCommand(BASE_OPTIONS);

		expect(GALOPIN_BIN).toBe("~/.local/bin/galopin");
		expect(command).not.toMatch(/(^|\n| )galopin /);
	});

	it("has the served installer install the pinned opencode only when asked, never opencode.ai's script", () => {
		const off = buildEnrollCommand(BASE_OPTIONS);
		const on = buildEnrollCommand({ ...BASE_OPTIONS, installOpencode: true });

		expect(off).not.toContain("--with-opencode");
		expect(on).toContain("install.sh' | sh -s -- --with-opencode &&\n");
		expect(on).not.toContain("opencode.ai");
	});

	it("never prints --allow-auto-accept: the selector replaced it", () => {
		const command = buildEnrollCommand({ ...BASE_OPTIONS, allowTerminal: true });
		expect(command).not.toContain("auto-accept");
	});

	it("omits --client-id when it equals the CLI's own default, explicitly", () => {
		const command = buildEnrollCommand({ ...BASE_OPTIONS, clientId: DEFAULT_CODE_CLIENT_ID });
		expect(command).not.toContain("--client-id");
	});

	it("prints --client-id only when it differs from the default", () => {
		const command = buildEnrollCommand({
			...BASE_OPTIONS,
			clientId: "custom-client",
			explicit: true,
		});
		expect(command).toContain("--client-id 'custom-client'");
	});

	it("treats a blank client id as the default (also omitted)", () => {
		const command = buildEnrollCommand({ ...BASE_OPTIONS, clientId: "   " });
		expect(command).not.toContain("--client-id");
	});

	it("terminals are on by default: --no-terminal only when turned off, last line of enroll", () => {
		const on = buildEnrollCommand(BASE_OPTIONS);
		const off = buildEnrollCommand({ ...BASE_OPTIONS, allowTerminal: false });

		expect(on).not.toContain("terminal");
		expect(off).toContain(
			`  --cerea 'https://cerea.example.org/chat' \\\n  --default-group \\\n  --no-terminal &&\n${GALOPIN_BIN} run`
		);
	});

	it("adds --allow-project-config only when asked, after the terminal flag", () => {
		const off = buildEnrollCommand(BASE_OPTIONS);
		const on = buildEnrollCommand({
			...BASE_OPTIONS,
			allowProjectConfig: true,
			allowTerminal: false,
		});

		expect(off).not.toContain("--allow-project-config");
		expect(on).toContain("--allow-project-config");
		expect(on.indexOf("--no-terminal")).toBeLessThan(on.indexOf("--allow-project-config"));
	});

	it("a value stays on its flag's line: a custom client id, then --no-terminal", () => {
		const command = buildEnrollCommand({
			...BASE_OPTIONS,
			clientId: "custom-client",
			allowTerminal: false,
			explicit: true,
		});
		expect(command).toContain(
			"  --client-id 'custom-client' \\\n  --default-group \\\n  --no-terminal"
		);
	});

	it("parses as one POSIX command list: every line but the last continues", () => {
		const lines = buildEnrollCommand({ ...BASE_OPTIONS, installOpencode: true }).split("\n");
		for (const line of lines.slice(0, -1)) expect(line).toMatch(/( \\| &&)$/);
		expect(lines.at(-1)).toBe(`${GALOPIN_BIN} run`);
	});

	it("strips a trailing slash from origin before use", () => {
		const command = buildEnrollCommand({
			...BASE_OPTIONS,
			origin: "https://cerea.example.org/chat/",
		});
		expect(command).toContain("'https://cerea.example.org/chat/galopin/install.sh'");
		expect(command).toContain("--cerea 'https://cerea.example.org/chat'");
	});
});

describe("quoteShellArg", () => {
	it("wraps a plain value in single quotes", () => {
		expect(quoteShellArg("https://example.org")).toBe("'https://example.org'");
	});

	it("defensively escapes an embedded single quote", () => {
		expect(quoteShellArg("it's-a-client")).toBe(`'it'"'"'s-a-client'`);
	});

	it("keeps a value with shell metacharacters inert once quoted", () => {
		const dangerous = "$(rm -rf /); echo pwned";
		const quoted = buildEnrollCommand({
			...BASE_OPTIONS,
			gatewayOrigin: dangerous,
			explicit: true,
		});
		expect(quoted).toContain(`--gateway ${quoteShellArg(dangerous)}`);
		// no unquoted occurrence of the raw payload
		expect(quoted).not.toContain(`--gateway ${dangerous}`);
	});
});

describe("the goose engine", () => {
	it("installs galopin and the pinned goose in one go and enrolls with --engine goose", () => {
		const command = buildEnrollCommand({ ...BASE_OPTIONS, engine: "goose", installOpencode: true });
		expect(command).toContain(
			"curl -fsSL 'https://cerea.example.org/chat/galopin/install.sh' | sh -s -- --engine goose &&"
		);
		// The opencode install line is not wanted with goose, even when ticked.
		expect(command).not.toContain("--with-opencode");
		expect(command).toContain("  --engine goose \\\n");
	});

	it("prints nothing for the default engine", () => {
		expect(buildEnrollCommand({ ...BASE_OPTIONS, engine: "opencode" })).not.toContain("--engine");
	});
});

describe("the pinned opencode release", () => {
	it("is the one in agent/packaging/opencode-version, which galopin reports and CI tests", () => {
		const pinned = readFileSync(
			fileURLToPath(new URL("../../agent/packaging/opencode-version", import.meta.url)),
			"utf8"
		);
		expect(pinned).toMatch(/^\d+\.\d+\.\d+\n$/);
		expect(OPENCODE_VERSION).toBe(pinned.trim());
	});
});

describe("the pinned opencode archives' checksums", () => {
	it("are the ones in agent/packaging/opencode-sha256", () => {
		const file = new Map(
			readFileSync(
				fileURLToPath(new URL("../../agent/packaging/opencode-sha256", import.meta.url)),
				"utf8"
			)
				.trim()
				.split("\n")
				.map((line) => {
					const [sum, name] = line.split(/\s+/);
					return [name, sum] as const;
				})
		);
		expect(Object.fromEntries(file)).toEqual(OPENCODE_SHA256);
		expect([...file.keys()].sort()).toEqual([
			"opencode-darwin-arm64.zip",
			"opencode-darwin-x64-baseline.zip",
			"opencode-darwin-x64.zip",
			"opencode-linux-arm64-musl.tar.gz",
			"opencode-linux-arm64.tar.gz",
			"opencode-linux-x64-baseline-musl.tar.gz",
			"opencode-linux-x64-baseline.tar.gz",
			"opencode-linux-x64-musl.tar.gz",
			"opencode-linux-x64.tar.gz",
		]);
		for (const sum of file.values()) expect(sum).toMatch(/^[0-9a-f]{64}$/);
	});
});

describe("buildDockerCommand", () => {
	const DOCKER = { ...BASE_OPTIONS, version: "0.49.1" };

	it("is one docker run: the image of this release, then start and the enroll flags", () => {
		expect(buildDockerCommand(DOCKER)).toBe(
			[
				"docker run -it --rm \\",
				"  --hostname sandbox \\",
				'  -v "$PWD":/workspace \\',
				"  ghcr.io/paoloviviani/galopin:0.49.1 \\",
				"  start \\",
				"  --issuer 'https://idp.example.org' \\",
				"  --gateway 'https://gateway.example.org' \\",
				"  --cerea 'https://cerea.example.org/chat' \\",
				"  --default-group",
			].join("\n")
		);
		expect(GALOPIN_IMAGE).toBe("ghcr.io/paoloviviani/galopin");
	});

	it("prints exactly the flags the native enroll prints, whatever is chosen", () => {
		const choices = {
			...BASE_OPTIONS,
			clientId: "my-client",
			allowProjectConfig: true,
			noFiles: true,
			workspaceRoots: ["/my projects/*"],
			fileDeny: ["**/.env"],
			maxTerminals: 3,
		};
		const flagsOf = (text: string, marker: string) =>
			text
				.split(marker)[1]
				.split(/ &&\n|$/)[0]
				.replace(/ \\\n {2}/g, " ")
				.trim();
		const native = flagsOf(buildEnrollCommand({ ...choices, explicit: true }), "galopin enroll");
		const docker = flagsOf(buildDockerCommand({ ...choices, version: "1.2.3" }), "  start");
		expect(docker).toBe(native);
		expect(docker).toContain("--workspace-root '/my projects/*'");
		expect(docker).toContain("--client-id 'my-client'");
	});

	it("has no install step, no opencode install and never the goose engine", () => {
		const command = buildDockerCommand({ ...DOCKER, engine: "goose", installOpencode: true });
		expect(command).not.toContain("install.sh");
		expect(command).not.toContain("--with-opencode");
		expect(command).not.toContain("--engine");
		expect(command).not.toContain("galopin run");
	});

	it("names the computer and, only when asked, keeps the pairing in a volume of that name", () => {
		expect(buildDockerCommand({ ...DOCKER, name: "Build Box 2" })).toContain(
			"--hostname build-box-2"
		);
		expect(buildDockerCommand({ ...DOCKER, name: "Build Box 2" })).not.toContain("-v galopin-");
		const kept = buildDockerCommand({ ...DOCKER, name: "build", keepPairing: true });
		expect(kept).toContain("  -v galopin-build:/home/galopin \\\n");
		expect(kept.indexOf("galopin-build:/home/galopin")).toBeGreaterThan(
			kept.indexOf("--hostname build")
		);
		expect(kept.indexOf("galopin-build:/home/galopin")).toBeLessThan(kept.indexOf(GALOPIN_IMAGE));
	});

	it("takes the tag from the version it is given", () => {
		expect(buildDockerCommand({ ...DOCKER, version: "1.2.3" })).toContain(
			`${GALOPIN_IMAGE}:1.2.3 `
		);
	});
});

describe("buildDockerCommand, read by a real shell", () => {
	/** The arguments bash gives `docker`, one per line, for a command text. */
	function argvOf(command: string): string[] {
		const script = `docker() { printf '%s\\n' "$@"; }\n${command}\n`;
		execFileSync("bash", ["-n"], { input: script });
		return execFileSync("bash", ["-c", script], { env: { PWD: "/proj" }, encoding: "utf8" })
			.split("\n")
			.slice(0, -1);
	}

	it("is valid shell, and the flags reach the image's `start` as single arguments", () => {
		const argv = argvOf(
			buildDockerCommand({
				...BASE_OPTIONS,
				version: "1.2.3",
				name: "Lab Box",
				keepPairing: true,
				workspaceRoots: ["/my projects/*"],
				fileDeny: ["**/.env"],
			})
		);
		expect(argv).toEqual([
			"run",
			"-it",
			"--rm",
			"--hostname",
			"lab-box",
			"-v",
			"galopin-lab-box:/home/galopin",
			"-v",
			expect.stringMatching(/:\/workspace$/),
			`${GALOPIN_IMAGE}:1.2.3`,
			"start",
			"--issuer",
			"https://idp.example.org",
			"--gateway",
			"https://gateway.example.org",
			"--cerea",
			"https://cerea.example.org/chat",
			"--default-group",
			"--workspace-root",
			"/my projects/*",
			"--file-deny",
			"**/.env",
		]);
	});
});

describe("cleanContainerName", () => {
	it("keeps a good name, lower-cases, and turns anything else into single hyphens", () => {
		expect(cleanContainerName("ci-box")).toBe("ci-box");
		expect(cleanContainerName("My Laptop_2")).toBe("my-laptop-2");
		expect(cleanContainerName("  --a..b--  ")).toBe("a-b");
	});
	it("falls back to the default when nothing usable is left, and stays within 63 characters", () => {
		expect(cleanContainerName("")).toBe("sandbox");
		expect(cleanContainerName("***")).toBe("sandbox");
		expect(cleanContainerName("é ü")).toBe("sandbox");
		expect(cleanContainerName("a".repeat(100))).toHaveLength(63);
		expect(cleanContainerName("a".repeat(62) + "-b")).toBe("a".repeat(62));
	});
	it("never lets a shell metacharacter through", () => {
		expect(cleanContainerName("x; rm -rf /")).toBe("x-rm-rf");
		expect(cleanContainerName("$(id)")).toBe("id");
	});
});
