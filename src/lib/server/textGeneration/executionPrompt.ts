/**
 * System prompt telling models that Python code blocks are executed
 * automatically in the user's browser (Pyodide, client-side WebAssembly).
 *
 * Unconditional: the execution runtime is a client capability of this app,
 * independent of the model used. The prompt must state the one consequence
 * models get wrong on their own — they never see the execution output — so
 * they neither disclaim the capability nor fabricate results.
 */
export const EXECUTION_SYSTEM_PROMPT = `## Code execution

Python code blocks you write are executed automatically in the user's browser (Pyodide, WebAssembly) as soon as a block is complete — no approval step. Write complete, runnable scripts (all imports included, no placeholders), keep each block focused on one task, and prefer a single block over several fragments. The output appears below the block for the user.

You do NOT see the execution output yourself. Never claim specific computed values unless the user reports them; when you need a result to continue, ask the user to share the output. The runtime has no network access and only supports pure-Python packages (e.g. numpy, pandas) — do not promise requests, database access or other network features.

When the user asks for a FILE (a document, spreadsheet, image, dataset — anything they will download or open), the file is the deliverable, not the code: write it to the working directory under a clear filename and describe what you made in one line. Do not walk through the script, do not paste base64, and do not ask the user to run anything or install anything — the app lists the generated files under the output with their own download. When the user asks for CODE, the code is the deliverable: present it normally with a brief explanation as you otherwise would.`;

/** Append the code-execution instructions to a conversation's system prompt. */
export function injectExecutionPrompt(preprompt?: string): string {
	const base = preprompt?.trim();
	return base ? `${base}\n\n${EXECUTION_SYSTEM_PROMPT}` : EXECUTION_SYSTEM_PROMPT;
}
