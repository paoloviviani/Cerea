/**
 * The one-liner `PairDeviceDialog` prints, and the re-enroll prompt the
 * `/code` device list shows for a device whose `enrolledIssuer` has drifted
 * or whose access was revoked (spec §12): install, enroll against this
 * deployment's issuer/gateway/client id, then run — chained with `&&` so a
 * failed step never silently runs the next one.
 *
 * A pure function, not a component method, so it has its own unit specs
 * independent of rendering: the shape of the printed command is exactly as
 * load-bearing as the values inside it. The machine-policy flags come from
 * `codeEnrollPolicy.ts`: a default emits nothing.
 */
import {
	defaultPolicyChoices,
	policyFlagArgs,
	quoteShellArg,
	type EnrollPolicyChoices,
} from "$lib/codeEnrollPolicy";

export { quoteShellArg };

/** The default the enrollment CLI itself falls back to (`agent/enroll.go`) —
 * the id baked into both bundled IdPs. `--client-id` is only worth printing
 * when a deployment overrides it. */
export const DEFAULT_CODE_CLIENT_ID = "opencode-enrollment";

export interface EnrollCommandOptions extends Partial<EnrollPolicyChoices> {
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

/** The policy choices an options object carries, the rest at default. */
function policyChoicesOf(opts: EnrollCommandOptions): EnrollPolicyChoices {
	const choices = defaultPolicyChoices();
	for (const key of Object.keys(choices) as Array<keyof EnrollPolicyChoices>) {
		const given = opts[key];
		if (given !== undefined) Object.assign(choices, { [key]: given });
	}
	return choices;
}

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
	enroll.push(...policyFlagArgs(policyChoicesOf(opts)));

	const steps = [install];
	if (installOpencode) {
		steps.push(installOpencode);
	}
	steps.push(enroll.join(" "), `${GALOPIN_BIN} run`);
	return steps.join(" && ");
}
