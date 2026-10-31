/**
 * How the composer does dictation, a deployment-wide choice an administrator
 * makes under Administration -> Voice: `browser` (the Web Speech API), `model`
 * (record, then transcribe through the gateway) or `off`.
 *
 * Browser dictation may send the audio to the browser vendor's cloud, and the
 * model option sends it to the chosen provider through the gateway, which is
 * why an administrator, and not each user, decides.
 *
 * An unset value (or the old `fallback`) means `model` where the deprecated
 * `TRANSCRIPTION_BASE_URL` + `TRANSCRIPTION_MODEL` pair is set, `browser`
 * otherwise, so an existing deployment keeps what it had. `yes` and `no` are
 * still read as `browser` and `off`.
 */

import { config } from "$lib/server/config";
import { DICTATION_MODES, parseDictationMode, type DictationMode } from "$lib/utils/dictation";
import { legacyTranscriptionConfigured, resolveTranscriptionModel } from "./transcription";

export { DICTATION_MODES, parseDictationMode, type DictationMode };

/** The mode in force: stored value, else the environment, else the default. */
export function dictationMode(): DictationMode {
	return parseDictationMode(config.CHAT_DICTATION, legacyTranscriptionConfigured());
}

/**
 * Whether the microphone-and-model recorder works for this user: the mode is
 * `model` and there is something to transcribe with (a gateway model they may
 * use, or the deprecated direct endpoint).
 */
export async function modelDictationAvailable(token: string | undefined): Promise<boolean> {
	if (dictationMode() !== "model") return false;
	if (legacyTranscriptionConfigured()) return true;
	return Boolean(token && (await resolveTranscriptionModel(token)).model);
}
