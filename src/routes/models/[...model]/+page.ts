import { base } from "$app/paths";
import { isCustomModelId } from "$lib/utils/customModelId";

export async function load({ params, parent, fetch }) {
	// Subscribing is about a catalogue model's author; a custom model has none.
	if (!isCustomModelId(params.model))
		await fetch(`${base}/api/v2/models/${params.model}/subscribe`, {
			method: "POST",
		});

	return {
		settings: await parent().then((data) => ({
			...data.settings,
			activeModel: params.model,
		})),
	};
}
