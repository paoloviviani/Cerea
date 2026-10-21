import type { HandleServerError } from "@sveltejs/kit";
import { logger } from "$lib/server/logger";
import { safeRequestFields } from "./safeLogFields";

type HandleServerErrorInput = Parameters<HandleServerError>[0];

export async function handleServerError({
	error,
	event,
	status,
	message,
}: HandleServerErrorInput): Promise<App.Error> {
	// handle 404
	if (event.route.id === null) {
		return {
			message: `Page ${event.url.pathname} not found`,
		};
	}

	const errorId = crypto.randomUUID();

	logger.error({
		...safeRequestFields(event),
		method: event.request.method,
		message,
		error,
		errorId,
		status,
		stack: error instanceof Error ? error.stack : undefined,
	});

	return {
		message: "An error occurred",
		errorId,
	};
}
