/**
 * The static escalate list (ADR 0107 section 2): asks that always come to the user, whatever the
 * administrator's rows say. Structural, it does not parse shell: it reads paths and, for a command,
 * looks for the protected names as text. An obfuscated command passes this and reaches the model,
 * which is the designed guard.
 *
 * Ported from galopin's `Protected` (agent/internal/decide/protected.go): its own state and the
 * opencode config it owns, the credential stores and `.env` files, and CI configuration writes.
 * Cerea does not know the machine's home directory, so names are matched wherever they sit.
 */

export interface StaticTarget {
	tool: string;
	/** The ask's patterns and its path/command metadata. */
	targets: string[];
}

const OWN = [
	/(^|[\\/\s"'=~])\.?galopin([\\/\s"']|$)/i,
	/\.config[\\/]opencode/i,
	/\.local[\\/]share[\\/]opencode/i,
	/(^|[\\/\s"'=])opencode\.jsonc?([\s"']|$)/i,
];
const SECRET = [
	/(^|[\\/\s"'=~])\.(ssh|gnupg|aws|azure|kube|docker|password-store|pystino|cerea)([\\/\s"']|$)/i,
	/\.config[\\/](gcloud|gh|git|pystino|cerea)([\\/\s"']|$)/i,
	/(^|[\\/\s"'=])\.(netrc|npmrc|pypirc|git-credentials)([\s"']|$)/i,
	/(^|[\\/\s"'=])authorized_keys([\s"']|$)/i,
	/(^|[\\/\s"'=])\.env(\.[\w.-]+)?([\s"']|$)/i,
];
const CI = [
	/(^|[\\/])\.github[\\/]workflows[\\/]/,
	/(^|[\\/])\.gitlab-ci\.yml$/,
	/(^|[\\/])\.circleci[\\/]/,
	/(^|[\\/])\.buildkite[\\/]/,
	/(^|[\\/])azure-pipelines\.yml$/,
	/(^|[\\/])Jenkinsfile$/,
];

/** A repository's own git directory (config, hooks, info, anything under it): `.git` as a whole path segment. */
const GIT_DIR = /(^|[\\/])\.git([\\/]|$)/;

const WRITE_TOOLS = new Set(["edit", "write", "patch", "multiedit", "apply_patch"]);

/** Why this ask always goes to the user, or null when the static list has no objection. */
export function staticEscalateReason(ask: StaticTarget): string | null {
	for (const t of ask.targets) {
		if (OWN.some((r) => r.test(t))) return "it touches the agent's own configuration";
		if (SECRET.some((r) => r.test(t))) return "it touches credentials or a secrets file";
	}
	if (WRITE_TOOLS.has(ask.tool) && ask.targets.some((t) => CI.some((r) => r.test(t)))) {
		return "it changes CI configuration";
	}
	if (WRITE_TOOLS.has(ask.tool) && ask.targets.some((t) => GIT_DIR.test(t))) {
		return "it changes a repository's git directory (config, hooks)";
	}
	return null;
}
