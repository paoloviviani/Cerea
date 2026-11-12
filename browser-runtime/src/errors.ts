/** An error whose message is meant for the caller (the model reads it): clear and free of internals. */
export class ToolError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ToolError";
	}
}
