/**
 * The one-liner `PairDeviceDialog` prints, and the re-enroll prompt the
 * `/code` device list shows for a device whose `enrolledIssuer` has drifted
 * or whose access was revoked (spec §12): install, enroll against this
 * deployment's issuer/gateway/client id, then run — chained with `&&` so a
 * failed step never silently runs the next one.
 *
 * A pure function, not a component method, so it has its own unit specs
 * independent of rendering: the shape of the printed command is exactly as
 * load-bearing as the values inside it.
 */

/** The default the enrollment CLI itself falls back to (`agent/enroll.go`) —
 * the id baked into both bundled IdPs. `--client-id` is only worth printing
 * when a deployment overrides it. */
export const DEFAULT_CODE_CLIENT_ID = "opencode-enrollment";

/** POSIX single-quoting: closes the quote, appends a literal single quote via
 * `'"'"'`, reopens it. Defensive rather than load-bearing — every value here
 * is deployment configuration (an origin, an issuer, a client id), never
 * end-user input — but a misconfigured `CODE_MACHINE_CLIENT_ID` or a gateway
 * origin with a stray character must not silently break out of its argument. */
export function quoteShellArg(value: string): string {
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export interface EnrollCommandOptions {
	/** This deployment's own address, base path included (`PublicConfig`'s
	 * `origin`) — used for both the installer's URL and `--cerea`. */
	origin: string;
	/** The chat's own OIDC issuer (`codeOidcIssuerUrl`). */
	issuer: string;
	/** The gateway origin or `/v1` base (`codeGatewayOrigin`, already
	 * resolved by the caller — the browser-origin fallback is the caller's
	 * job, not this function's, since only the caller knows whether the
	 * value it has is a real setting or a fallback). */
	gatewayOrigin: string;
	/** `codeOidcClientId`; omitted (or equal to the default) leaves
	 * `--client-id` out of the printed command, matching the CLI's own
	 * default. */
	clientId?: string;
	/** Adds `--allow-terminal`, off by default. */
	allowTerminal?: boolean;
	/** Adds `--allow-auto-accept`, off by default. Auto-accept lets the
	 * agent answer its own tool permission asks without a person — the
	 * machine-side gate behind the panel's Auto-accept toggle
	 * (`Policy.autoAccept`; handoffs and questions are never
	 * auto-accepted whatever this says). */
	allowAutoAccept?: boolean;
	/** Adds `--allow-project-config`, off by default. Lets a repo's own
	 * opencode config load (its agents, commands, MCP, plugins, AGENTS.md)
	 * with the gateway provider and default models pinned over it — enable
	 * only on machines that open repos you trust, since repo plugins run
	 * as you. */
	allowProjectConfig?: boolean;
	/** Adds the opencode install line before enroll — galopin runs the
	 * opencode binary as its agent, and a fresh machine has neither it nor
	 * a reason to know that. Off by default because a machine that already
	 * has opencode (or runs the acp backend) should not re-install it. */
	installOpencode?: boolean;
}

/** The binary's path as the installer installs it — `${GALOPIN_INSTALL_DIR:-
 * $HOME/.local/bin}/galopin` (galopinDist.ts's renderInstallScript). The
 * printed command uses it instead of a bare `galopin` because on a fresh
 * machine `~/.local/bin` is not on the installing shell's PATH yet, and a
 * bare name fails with "command not found" between the `&&`s. `$HOME` is
 * POSIX-guaranteed enough for a login shell; if some shell leaves it unset
 * the enroll step fails loudly instead of silently running the wrong
 * binary. */
export const GALOPIN_BIN = '"${GALOPIN_INSTALL_DIR:-$HOME/.local/bin}/galopin"';

export function buildEnrollCommand(opts: EnrollCommandOptions): string {
	const origin = opts.origin.replace(/\/+$/, "");
	const install = `curl -fsSL ${quoteShellArg(`${origin}/galopin/install.sh`)} | sh`;
	// opencode's own installer: it appends $HOME/.opencode/bin to PATH in
	// the rc files but NOT in this shell, so the same fresh-machine trap as
	// galopin's applies — galopin falls back to $HOME/.opencode/bin/opencode
	// itself (agent opencode.go's Start), which is why no export is needed
	// here and the line stays honest on both a fresh and a loaded PATH.
	const installOpencode = opts.installOpencode
		? `curl -fsSL https://opencode.ai/install | bash`
		: null;

	const enroll = [
		GALOPIN_BIN,
		"enroll",
		"--issuer",
		quoteShellArg(opts.issuer),
		"--gateway",
		quoteShellArg(opts.gatewayOrigin),
		"--cerea",
		quoteShellArg(origin),
	];
	const clientId = opts.clientId?.trim() || DEFAULT_CODE_CLIENT_ID;
	if (clientId !== DEFAULT_CODE_CLIENT_ID) {
		enroll.push("--client-id", quoteShellArg(clientId));
	}
	if (opts.allowAutoAccept) {
		enroll.push("--allow-auto-accept");
	}
	if (opts.allowProjectConfig) {
		enroll.push("--allow-project-config");
	}
	if (opts.allowTerminal) {
		enroll.push("--allow-terminal");
	}

	const steps = [install];
	if (installOpencode) {
		steps.push(installOpencode);
	}
	steps.push(enroll.join(" "), `${GALOPIN_BIN} run`);
	return steps.join(" && ");
}
