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
	if (opts.allowTerminal) {
		enroll.push("--allow-terminal");
	}

	return [install, enroll.join(" "), `${GALOPIN_BIN} run`].join(" && ");
}
