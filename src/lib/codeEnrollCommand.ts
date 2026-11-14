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
 * The served installer installs exactly this release (checksum-verified, see
 * `opencodeVersion.ts`) rather than the newest, which may change a wire
 * galopin depends on.
 * `codeEnrollCommand.spec.ts` fails if this drifts from the file; change both
 * with `agent/packaging/bump-opencode.sh <version>`. */
export const OPENCODE_VERSION = "2.3.0";

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
	/** Print the deployment's facts as flags (`--issuer`, `--gateway`, a non-default `--client-id`).
	 * Off by default: the binary the same line installs asks this Cerea for them
	 * (`/galopin/enroll.json`). On for an older galopin that cannot, and for the container. */
	explicit?: boolean;
	/** `codeMachineFlow`: how this deployment signs a machine in; `device` or `loopback` is spelled
	 * out in the explicit form, `auto` (or absent) leaves it to the machine. */
	flow?: "device" | "loopback" | "auto";
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

/** The `galopin enroll` flags a deployment and a policy turn into, one per
 * entry (`--flag value`, already shell-quoted). The native command and the
 * Docker one print exactly these, so the two cannot drift apart. */
function enrollFlagLines(opts: EnrollCommandOptions): string[] {
	const origin = opts.origin.replace(/\/+$/, "");
	// One flag per line, its value beside it: the args come flat, and a new
	// line starts at every `--flag`.
	const flags: string[] = [];
	const push = (...args: string[]) => {
		for (const arg of args) {
			if (arg.startsWith("--") || flags.length === 0) flags.push(arg);
			else flags[flags.length - 1] += ` ${arg}`;
		}
	};
	if (opts.explicit) {
		push("--issuer", quoteShellArg(opts.issuer));
		push("--gateway", quoteShellArg(opts.gatewayOrigin));
	}
	push("--cerea", quoteShellArg(origin));
	const clientId = opts.clientId?.trim() || DEFAULT_CODE_CLIENT_ID;
	if (opts.explicit && clientId !== DEFAULT_CODE_CLIENT_ID) {
		push("--client-id", quoteShellArg(clientId));
	}
	if (opts.explicit && (opts.flow === "device" || opts.flow === "loopback")) {
		push(`--${opts.flow}`);
	}
	push(...policyFlagArgs(policyChoicesOf(opts)));
	return flags;
}

export function buildEnrollCommand(opts: EnrollCommandOptions): string {
	const origin = opts.origin.replace(/\/+$/, "");
	const goose = policyChoicesOf(opts).engine === "goose";
	// The served installer also installs the engine: the pinned goose release, or,
	// with `--with-opencode`, the pinned opencode release; both are verified
	// against checksums recorded in this repo. opencode lands in
	// $HOME/.opencode/bin, which galopin finds itself (agent opencode.go's
	// Start), so no PATH export is needed here.
	const engineArgs = goose
		? " -s -- --engine goose"
		: opts.installOpencode
			? " -s -- --with-opencode"
			: "";
	const install = `curl -fsSL ${quoteShellArg(`${origin}/galopin/install.sh`)} | sh${engineArgs}`;

	const enroll = [`${GALOPIN_BIN} enroll`, ...enrollFlagLines(opts)].join(CONT);

	// One step per line; a line ending in `&&` continues without a backslash,
	// and a failed step still never runs the next one.
	const steps = [install];
	steps.push(enroll, `${GALOPIN_BIN} run`);
	return steps.join(" &&\n");
}

/** The galopin image (`agent/Dockerfile`), published with each Cerea release:
 * `galopin:X.Y.Z` goes with `cerea:X.Y.Z`. */
export const GALOPIN_IMAGE = "ghcr.io/paoloviviani/galopin";

/** The computer name a container gets when the person does not pick one. */
export const DEFAULT_CONTAINER_NAME = "sandbox";

/** A name Docker accepts as a hostname and as part of a volume name: lower
 * case letters, digits and hyphens, no hyphen at either end, at most 63
 * characters. Anything else becomes a hyphen; nothing left gives the default. */
export function cleanContainerName(raw: string): string {
	const cleaned = raw
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 63)
		.replace(/-+$/, "");
	return cleaned || DEFAULT_CONTAINER_NAME;
}

export interface DockerCommandOptions extends EnrollCommandOptions {
	/** The Cerea release (`APP_VERSION`): the image tag. */
	version: string;
	/** The computer's name in the Agents panel (the container's hostname);
	 * cleaned by `cleanContainerName`. */
	name?: string;
	/** Keep the pairing across restarts in a named volume on the home
	 * directory. Off: the container leaves nothing behind. */
	keepPairing?: boolean;
}

/**
 * The same pairing as `buildEnrollCommand`, in a disposable container: one
 * `docker run` that enrolls and runs, whose flags after `start` are exactly
 * the native command's `enroll` flags (the image's entrypoint takes them as
 * they are). The image carries opencode and the pinned galopin, so there is
 * no install step, and the goose engine is not in it: the engine is always
 * opencode here, and `installOpencode` means nothing.
 */
export function buildDockerCommand(opts: DockerCommandOptions): string {
	const name = cleanContainerName(opts.name ?? "");
	const flags = enrollFlagLines({
		...opts,
		engine: "opencode",
		installOpencode: false,
		explicit: true,
	});
	const lines = ["docker run -it --rm", `--hostname ${name}`];
	if (opts.keepPairing) lines.push(`-v galopin-${name}:/home/galopin`);
	lines.push('-v "$PWD":/workspace', `${GALOPIN_IMAGE}:${opts.version}`, "start", ...flags);
	return lines.join(CONT);
}

export interface ConnectorsEnrollOptions {
	/** This deployment's own address, base path included (`PublicConfig`'s `origin`). */
	origin: string;
	/** The chat's own OIDC issuer (`codeOidcIssuerUrl`). */
	issuer: string;
	/** `codeOidcClientId`; left out of the command when it is the default. */
	clientId?: string;
	/** `codeMachineFlow`; `device` or `loopback` is added to the explicit form. */
	flow?: "device" | "loopback" | "auto";
}

/**
 * The three steps of connecting a machine that only serves local MCP servers (ADR 0102), each
 * as its own copyable command: install galopin from this deployment's own `/galopin/` download,
 * enroll it as a connectors machine against this deployment's issuer, and run it with no coding
 * agent. A connectors machine needs no gateway, no billing group and no opencode, so none of
 * the agent command's flags appear. The `enroll` flags are one per line, like the agent
 * command's.
 */
export function buildConnectorsCommands(opts: ConnectorsEnrollOptions): {
	install: string;
	/** The short form: `--connectors-only --cerea <base>`; `enroll` asks this Cerea for the rest. */
	enroll: string;
	/** The same with the deployment's issuer (and a non-default client id) as flags, for an older galopin. */
	enrollExplicit: string;
	run: string;
} {
	const origin = opts.origin.replace(/\/+$/, "");
	const cerea = `--cerea ${quoteShellArg(origin)}`;
	const explicit: string[] = ["--connectors-only"];
	explicit.push(`--issuer ${quoteShellArg(opts.issuer)}`);
	explicit.push(cerea);
	const clientId = opts.clientId?.trim() || DEFAULT_CODE_CLIENT_ID;
	if (clientId !== DEFAULT_CODE_CLIENT_ID) explicit.push(`--client-id ${quoteShellArg(clientId)}`);
	if (opts.flow === "device" || opts.flow === "loopback") explicit.push(`--${opts.flow}`);
	return {
		install: `curl -fsSL ${quoteShellArg(`${origin}/galopin/install.sh`)} | sh`,
		enroll: [`${GALOPIN_BIN} enroll`, "--connectors-only", cerea].join(CONT),
		enrollExplicit: [`${GALOPIN_BIN} enroll`, ...explicit].join(CONT),
		run: `${GALOPIN_BIN} run`,
	};
}
