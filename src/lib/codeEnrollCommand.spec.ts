import { describe, expect, it } from "vitest";
import { buildEnrollCommand, quoteShellArg, DEFAULT_CODE_CLIENT_ID } from "./codeEnrollCommand";

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
				"galopin enroll --issuer 'https://idp.example.org' " +
				"--gateway 'https://gateway.example.org' --cerea 'https://cerea.example.org/chat' && " +
				"galopin run"
		);
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
			"--cerea 'https://cerea.example.org/chat' --allow-terminal && galopin run"
		);
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
