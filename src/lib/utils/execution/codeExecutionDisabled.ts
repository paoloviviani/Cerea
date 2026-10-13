import { getContext, setContext } from "svelte";

/**
 * Whether Python fences on this surface may execute in the browser sandbox.
 *
 * The coding-agent transcript (`AgentView`, and the nested transcript in
 * `SubagentCard`) reuses the chat's message components, whose code blocks
 * otherwise auto-run a closed ```python fence that streamed in — in the
 * browser's Pyodide, through the tab-wide runs store. The quoted fragment of
 * the agent's own edit is not the person's code and must never run there
 * (seen live: a SyntaxError traceback under "Finished with errors"), and the
 * Run button on those blocks is wrong too: it runs in the browser, not on
 * the machine.
 *
 * A context rather than a prop because a block renders several layers down
 * through the markdown renderer, which has no business knowing about views.
 * Set once by the agent surfaces; absent everywhere else, where chat keeps
 * executing exactly as before.
 */
export const CODE_EXECUTION_DISABLED = Symbol("cerea.codeExecutionDisabled");

/** Mark this subtree as a no-execution surface (the agent transcript). */
export function setCodeExecutionDisabled(): void {
	setContext(CODE_EXECUTION_DISABLED, true);
}

/** True only under a provider above (the agent transcript). */
export function isCodeExecutionDisabled(): boolean {
	return getContext<boolean | undefined>(CODE_EXECUTION_DISABLED) === true;
}
