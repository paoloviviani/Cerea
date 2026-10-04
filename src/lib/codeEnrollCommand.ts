/**
 * The one-liner `PairDeviceDialog` prints, and the re-enroll prompt the
 * `/code` device list shows for a device whose `enrolledIssuer` has drifted
 * or whose access was revoked (spec §12): install, enroll against this
 * deployment's issuer/gateway/client id, then run — chained with `&&` so a
 * failed step never silently runs the next one, one step per line and one
 * enroll flag per line, so it reads at a glance and still pastes as is.
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

/** The opencode release galopin is built and tested against. The source of
 * truth is `agent/packaging/opencode-version`: the Go backend embeds it and
 * reports it in its hello, and CI installs it for the live integration tests.
 * The install line asks opencode's installer for exactly this release rather
 * than the newest, which may change a wire galopin depends on.
 * `codeEnrollCommand.spec.ts` fails if this drifts from the file; change both
 * with `agent/packaging/bump-opencode.sh <version>`. */
export const OPENCODE_VERSION = "1.18.34";

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

/** The binary's path as the installer installs it by default
 * (galopinDist.ts's renderInstallScript: `${GALOPIN_INSTALL_DIR:-$HOME/.local/bin}`).
 * The printed command uses the full path instead of a bare `galopin` because
 * on a fresh machine `~/.local/bin` is not on the installing shell's PATH yet,
 * and a bare name fails with "command not found" between the `&&`s. Someone
 * who set GALOPIN_INSTALL_DIR knows to edit it; everyone else reads a short,
 * plain path (an unquoted leading `~` expands in every POSIX shell). */
export const GALOPIN_BIN = "~/.local/bin/galopin";

/** Continuation of one shell command onto the next line. */
const CONT = " \\\n  ";

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
		? `curl -fsSL https://opencode.ai/install | bash -s -- --version ${OPENCODE_VERSION}`
		: null;

	// One flag per line, its value beside it: the args come flat, and a new
	// line starts at every `--flag`.
	const flags: string[] = [];
	const push = (...args: string[]) => {
		for (const arg of args) {
			if (arg.startsWith("--") || flags.length === 0) flags.push(arg);
			else flags[flags.length - 1] += ` ${arg}`;
		}
	};
	push("--issuer", quoteShellArg(opts.issuer));
	push("--gateway", quoteShellArg(opts.gatewayOrigin));
	push("--cerea", quoteShellArg(origin));
	const clientId = opts.clientId?.trim() || DEFAULT_CODE_CLIENT_ID;
	if (clientId !== DEFAULT_CODE_CLIENT_ID) {
		push("--client-id", quoteShellArg(clientId));
	}
	push(...policyFlagArgs(policyChoicesOf(opts)));
	const enroll = [`${GALOPIN_BIN} enroll`, ...flags].join(CONT);

	// One step per line; a line ending in `&&` continues without a backslash,
	// and a failed step still never runs the next one.
	const steps = [install];
	if (installOpencode) {
		steps.push(installOpencode);
	}
	steps.push(enroll, `${GALOPIN_BIN} run`);
	return steps.join(" &&\n");
}
