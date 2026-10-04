import { describe, expect, it } from "vitest";
import {
	buildEnrollCommand,
	quoteShellArg,
	DEFAULT_CODE_CLIENT_ID,
	GALOPIN_BIN,
	OPENCODE_VERSION,
} from "./codeEnrollCommand";
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

		expect(command).toBe(
			[
				"curl -fsSL 'https://cerea.example.org/chat/galopin/install.sh' | sh &&",
				`${GALOPIN_BIN} enroll \\`,
				"  --issuer 'https://idp.example.org' \\",
				"  --gateway 'https://gateway.example.org' \\",
				"  --cerea 'https://cerea.example.org/chat' &&",
				`${GALOPIN_BIN} run`,
			].join("\n")
		);
	});

	it("invokes the binary by its installed path, not a bare name", () => {
		// A fresh machine has ~/.local/bin off PATH in the installing shell;
		// a bare `galopin` fails with "command not found" between the &&s.
		const command = buildEnrollCommand(BASE_OPTIONS);

		expect(GALOPIN_BIN).toBe("~/.local/bin/galopin");
		expect(command).not.toMatch(/(^|\n| )galopin /);
	});

	it("adds the opencode install line only when asked, between the two installs", () => {
		const off = buildEnrollCommand(BASE_OPTIONS);
		const on = buildEnrollCommand({ ...BASE_OPTIONS, installOpencode: true });

		expect(off).not.toContain("opencode.ai");
		expect(on).toContain(
			` &&\ncurl -fsSL https://opencode.ai/install | bash -s -- --version ${OPENCODE_VERSION} &&\n`
		);
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
		const command = buildEnrollCommand({ ...BASE_OPTIONS, clientId: "custom-client" });
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
			`  --cerea 'https://cerea.example.org/chat' \\\n  --no-terminal &&\n${GALOPIN_BIN} run`
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
		});
		expect(command).toContain("  --client-id 'custom-client' \\\n  --no-terminal");
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
		const quoted = buildEnrollCommand({ ...BASE_OPTIONS, gatewayOrigin: dangerous });
		expect(quoted).toContain(`--gateway ${quoteShellArg(dangerous)}`);
		// no unquoted occurrence of the raw payload
		expect(quoted).not.toContain(`--gateway ${dangerous}`);
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
