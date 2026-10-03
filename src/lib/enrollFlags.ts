/**
 * Every flag `galopin enroll` registers, classified: which the Pair-a-machine
 * dialog exposes as a control and which are connection plumbing it does not.
 *
 * This is a TypeScript copy of `agent/packaging/enroll-flags.json`, the file
 * the agent half keeps in step with `enroll`'s own flag set (a Go test fails
 * when a flag is added without being classified there). `enrollFlags.spec.ts`
 * compares this copy with that file, so the two cannot drift apart silently;
 * it also checks that every `exposed: true` flag has a dialog control
 * (`codeEnrollPolicy.ts`'s `FLAG_CONTROLS`) and that every default emits
 * nothing.
 *
 * `kind` is how the flag takes its value: `bool` (present or absent), `int`,
 * `string`, `list` (repeatable, one value each) or `keyAction` (repeatable
 * `KEY=allow|ask|deny`). `default` is the flag's value when absent: for the
 * two key/action flags that is the empty list, and what enroll then does
 * (the default ceiling, `bash=ask` and `session_spawn=ask`) is the ceiling
 * table's business (`codeEnrollPolicy.ts`, `DEFAULT_CEILING`). The retired
 * `--allow-auto-accept` is registered by enroll (it warns that it does
 * nothing) and listed by the agent's file as `retired`; it is not here.
 */
export type EnrollFlagKind = "bool" | "int" | "string" | "list" | "keyAction";

export interface EnrollFlag {
	flag: string;
	kind: EnrollFlagKind;
	default: boolean | number | string | string[];
	exposed: boolean;
}

export const ENROLL_FLAGS: readonly EnrollFlag[] = [
	// Connection plumbing: set by the dialog's own origins, or not a policy.
	{ flag: "cerea", kind: "string", default: "", exposed: false },
	{ flag: "client-id", kind: "string", default: "opencode-enrollment", exposed: false },
	{ flag: "creds", kind: "string", default: "", exposed: false },
	{ flag: "device", kind: "bool", default: false, exposed: false },
	{ flag: "discover", kind: "bool", default: true, exposed: false },
	{ flag: "gateway", kind: "string", default: "", exposed: false },
	{ flag: "group", kind: "string", default: "", exposed: false },
	{ flag: "issuer", kind: "string", default: "", exposed: false },
	{ flag: "loopback", kind: "bool", default: false, exposed: false },
	{ flag: "no-discover", kind: "bool", default: false, exposed: false },
	{ flag: "output", kind: "string", default: "", exposed: false },
	{ flag: "shim-port", kind: "int", default: 41871, exposed: false },
	{ flag: "yes", kind: "bool", default: false, exposed: false },
	// On by default since enroll turned them on; the dialog's control for each
	// is its --no-* negation below, so these spellings only restate the default.
	{ flag: "allow-background-subagents", kind: "bool", default: true, exposed: false },
	{ flag: "allow-command-shell", kind: "bool", default: true, exposed: false },
	{ flag: "allow-terminal", kind: "bool", default: true, exposed: false },
	// Machine policy: one control each in the dialog.
	{ flag: "allow-free-models", kind: "bool", default: false, exposed: true },
	{ flag: "allow-opencode-provider", kind: "bool", default: false, exposed: true },
	{ flag: "allow-project-config", kind: "bool", default: false, exposed: true },
	{ flag: "file-deny", kind: "list", default: [], exposed: true },
	{ flag: "max-terminals", kind: "int", default: 8, exposed: true },
	{ flag: "no-agent-tools", kind: "bool", default: false, exposed: true },
	{ flag: "no-background-subagents", kind: "bool", default: false, exposed: true },
	{ flag: "no-command-shell", kind: "bool", default: false, exposed: true },
	{ flag: "no-default-file-deny", kind: "bool", default: false, exposed: true },
	{ flag: "no-files", kind: "bool", default: false, exposed: true },
	{ flag: "no-terminal", kind: "bool", default: false, exposed: true },
	{ flag: "permission-max", kind: "keyAction", default: [], exposed: true },
	{ flag: "permission-rule", kind: "keyAction", default: [], exposed: true },
	{ flag: "workspace-root", kind: "list", default: [], exposed: true },
];
