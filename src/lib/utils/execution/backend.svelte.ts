/**
 * Where code runs, as the client knows it: the deployment's `CHAT_CODE_EXECUTION`
 * (layout data `codeExecution`). Everything browser-specific on the client (the
 * sandbox session, auto-running fences, the pause/resume of a parked run, the
 * wake lock, the "keep the page open" hint) asks here, so a backend that runs
 * code elsewhere switches them all off in one place.
 */
export type ClientExecutionBackend = "browser" | "off";

let backend = $state<ClientExecutionBackend>("browser");

/** Set from the layout data before anything renders. Unknown values read as the default. */
export function setClientExecutionBackend(value: unknown): void {
	backend = value === "off" ? "off" : "browser";
}

export function clientExecutionBackend(): ClientExecutionBackend {
	return backend;
}

/** Whether code runs in this browser: the one switch for browser-side execution. */
export function browserExecutionEnabled(): boolean {
	return backend === "browser";
}
