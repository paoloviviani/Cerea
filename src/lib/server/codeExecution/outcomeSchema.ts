import { z } from "zod";

/**
 * The shape of a code run's outcome, whoever produced it: the browser posting to
 * `code-execution/+server.ts`, or the server sandbox's exec daemon (`sandboxSessions.ts`). One
 * schema, so a reply from either is held to the same bounds before it is recorded.
 */
export const outcomeFieldsSchema = z.object({
	ok: z.boolean(),
	stdout: z.string(),
	stderr: z.string(),
	result: z.string().optional(),
	error: z.string().optional(),
	files: z
		.array(z.object({ path: z.string().max(1024), size: z.number().int().nonnegative() }))
		.max(200)
		.default([]),
	// Set when the run was stopped at the time limit and the interpreter restarted; the model's
	// result says so, and lists the restored files.
	timeout: z
		.object({
			seconds: z.number().int().positive().max(3600),
			mountedFiles: z.array(z.string().max(512)).max(500),
		})
		.optional(),
});

export type OutcomeFields = z.infer<typeof outcomeFieldsSchema>;
