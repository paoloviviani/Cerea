import type { CallErrorCode } from "$lib/types/machineProtocol";

/** A refusal a machine call answers with: the code and a sentence the agent's model can read. */
export class CallError extends Error {
	constructor(
		readonly code: CallErrorCode,
		message: string
	) {
		super(message);
	}
}
