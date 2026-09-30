import { describe, expect, it } from "vitest";
import {
	buildEnrollCommand,
	quoteShellArg,
	DEFAULT_CODE_CLIENT_ID,
	GALOPIN_BIN,
} from "./codeEnrollCommand";

const BASE_OPTIONS = {
	origin: "https://cerea.example.org/chat",
	issuer: "https://idp.example.org",
	gatewayOrigin: "https://gateway.example.org",
};

describe("buildEnrollCommand", () => {
	it("chains install, enroll and run with the default client id omitted", () => {
		const command = buildEnrollCommand(BASE_OPTIONS);

		expect(command).toBe(
			"curl -fsSL 'https://cerea.example.org/chat/galopin/install.sh' | sh && " +
				`${GALOPIN_BIN} enroll --issuer 'https://idp.example.org' ` +
				"--gateway 'https://gateway.example.org' --cerea 'https://cerea.example.org/chat' && " +
				`${GALOPIN_BIN} run`
		);
	});

	it("invokes the binary by its installed path, not a bare name", () => {
		// A fresh machine has ~/.local/bin off PATH in the installing shell;
		// a bare `galopin` fails with "command not found" between the &&s.
		const command = buildEnrollCommand(BASE_OPTIONS);

		expect(GALOPIN_BIN).toBe('"${GALOPIN_INSTALL_DIR:-$HOME/.local/bin}/galopin"');
		expect(command).not.toMatch(/(^| && | )galopin /);
	});

	it("adds the opencode install line only when asked, between the two installs", () => {
		const off = buildEnrollCommand(BASE_OPTIONS);
		const on = buildEnrollCommand({ ...BASE_OPTIONS, installOpencode: true });

		expect(off).not.toContain("opencode.ai");
		expect(on).toContain(" && curl -fsSL https://opencode.ai/install | bash && ");
	});

	it("adds --allow-auto-accept only when asked, before --allow-terminal", () => {
		const off = buildEnrollCommand(BASE_OPTIONS);
		const on = buildEnrollCommand({ ...BASE_OPTIONS, allowAutoAccept: true, allowTerminal: true });

		expect(off).not.toContain("--allow-auto-accept");
		expect(on).toContain("--allow-auto-accept");
		expect(on.indexOf("--allow-auto-accept")).toBeLessThan(on.indexOf("--allow-terminal"));
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

	it("adds --allow-terminal only when asked, at the end of the enroll step", () => {
		const off = buildEnrollCommand(BASE_OPTIONS);
		const on = buildEnrollCommand({ ...BASE_OPTIONS, allowTerminal: true });

		expect(off).not.toContain("--allow-terminal");
		expect(on).toContain(
			`--cerea 'https://cerea.example.org/chat' --allow-terminal && ${GALOPIN_BIN} run`
		);
	});

	it("adds --allow-project-config only when asked, between auto-accept and terminal", () => {
		const off = buildEnrollCommand(BASE_OPTIONS);
		const on = buildEnrollCommand({
			...BASE_OPTIONS,
			allowAutoAccept: true,
			allowProjectConfig: true,
			allowTerminal: true,
		});

		expect(off).not.toContain("--allow-project-config");
		expect(on).toContain("--allow-project-config");
		expect(on.indexOf("--allow-auto-accept")).toBeLessThan(on.indexOf("--allow-project-config"));
		expect(on.indexOf("--allow-project-config")).toBeLessThan(on.indexOf("--allow-terminal"));
	});

	it("combines a custom client id and --allow-terminal together", () => {
		const command = buildEnrollCommand({
			...BASE_OPTIONS,
			clientId: "custom-client",
			allowTerminal: true,
		});
		expect(command).toContain("--client-id 'custom-client' --allow-terminal");
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
