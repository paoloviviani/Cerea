import type { CodeDevice } from "$lib/types/CodeAgent";
import { isCustomModelId } from "$lib/utils/customModelId";

/**
 * Which models the panel may offer and drive on a machine.
 *
 * Gateway models (`pystino/*`) bill through Pystino's ledger and policy; anything else
 * (opencode's free catalog, a provider key on the machine) bypasses both. A machine
 * therefore offers non-gateway models only when it was enrolled with
 * `--allow-free-models`, which it reports in its hello's policy. The agent enforces this
 * too; Cerea enforces it again here so a machine reporting a list it should not have
 * (an older or modified agent) still cannot be driven onto one from the panel.
 */
export const GATEWAY_PROVIDER = "pystino";

export function isGatewayModel(modelId: string): boolean {
	return modelId.startsWith(`${GATEWAY_PROVIDER}/`);
}

export function allowsModel(device: Pick<CodeDevice, "policy">, modelId: string): boolean {
	// Custom models are chat-only: a person's own prompt-plus-base variant has no
	// meaning on a machine, and "free models allowed" must not read as "any id".
	if (isCustomModelId(modelId)) return false;
	return device.policy?.allowFreeModels === true || isGatewayModel(modelId);
}

/** Splits a machine's model list into what the panel may show and how many it hid. */
export function filterModels<T extends { id: string }>(
	device: Pick<CodeDevice, "policy">,
	models: T[]
): { models: T[]; hidden: number } {
	const shown = models.filter((model) => allowsModel(device, model.id));
	return { models: shown, hidden: models.length - shown.length };
}
