/**
 * Server sandboxes (ADR 0115), as the chat sees them: one switch and where the manager is.
 *
 * | key                    | meaning                                                         |
 * |------------------------|-----------------------------------------------------------------|
 * | SANDBOX                | `off` (default), `local` (a manager in this compose) or `remote` |
 * | SANDBOX_MANAGER_URL    | the manager's address; the chat reaches it by this and nothing else |
 * | SANDBOX_MANAGER_TOKEN  | the manager's service token                                      |
 *
 * `off` means no sandbox is used whatever else is set. ./configure writes the three together and
 * `./configure --check` reports a mix; this module reports the same mix at start, as a warning,
 * and never turns a half-set switch on.
 */

export type SandboxMode = "off" | "local" | "remote";

export interface SandboxConfig {
	mode: Exclude<SandboxMode, "off">;
	url: string;
	token: string;
}

export interface SandboxSettings {
	/** What the chat will use: null when sandboxes are off or not fully configured. */
	config: SandboxConfig | null;
	/** The mode as written, `off` for an empty or unknown value. */
	mode: SandboxMode;
	/** Why the three settings disagree; empty when they agree. Shown in the start-up log. */
	problems: string[];
}

type Env = Record<string, string | undefined>;

export function parseSandboxSettings(env: Env): SandboxSettings {
	const raw = (env.SANDBOX ?? "").trim().toLowerCase();
	const url = (env.SANDBOX_MANAGER_URL ?? "").trim().replace(/\/+$/, "");
	const token = (env.SANDBOX_MANAGER_TOKEN ?? "").trim();
	const problems: string[] = [];
	let mode: SandboxMode = "off";
	if (raw === "local" || raw === "remote") mode = raw;
	else if (raw !== "" && raw !== "off") {
		problems.push(`SANDBOX='${raw}' is not off, local or remote: treated as off`);
	}
	if (mode === "off") {
		if (url || token) {
			problems.push(
				"SANDBOX is off but SANDBOX_MANAGER_URL or SANDBOX_MANAGER_TOKEN is set: sandboxes stay off"
			);
		}
		return { config: null, mode, problems };
	}
	if (!/^https?:\/\/[^\s/]+/.test(url)) {
		problems.push(
			`SANDBOX=${mode} needs SANDBOX_MANAGER_URL (an http(s):// address): sandboxes stay off`
		);
	}
	if (!token) {
		problems.push(`SANDBOX=${mode} needs SANDBOX_MANAGER_TOKEN: sandboxes stay off`);
	}
	if (problems.length > 0) return { config: null, mode, problems };
	return { config: { mode, url, token }, mode, problems };
}
