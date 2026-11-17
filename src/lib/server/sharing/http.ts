import { error } from "@sveltejs/kit";
import { ShareError } from "./shares";

/** Runs a sharing call and turns its refusals into the HTTP answer. */
export async function asHttp<T>(run: () => Promise<T>): Promise<T> {
	try {
		return await run();
	} catch (err) {
		if (err instanceof ShareError) error(err.status, err.message);
		throw err;
	}
}
