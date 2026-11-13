import { error } from "@sveltejs/kit";
import { dev } from "$app/environment";
import type { PageServerLoad } from "./$types";

/** Internal: exercises the live-view module against a running task. Not part of a production build. */
export const load: PageServerLoad = ({ params }) => {
	if (!dev) error(404, "Not found");
	return { uuid: params.uuid };
};
