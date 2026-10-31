/**
 * How the composer does dictation, a deployment-wide choice an administrator
 * makes under Administration -> Voice: `browser` (the Web Speech API), `model`
 * (record, then transcribe through the gateway) or `off`.
 *
 * Browser dictation may send the audio to the browser vendor's cloud, and the
 * model option sends it to the chosen provider through the gateway, which is
 * why an administrator, and not each user, decides.
 *
 * The old words (`yes`, `no`, `fallback`, unset) keep exactly the behaviour
 * they had: see the table at `parseDictationMode` and `dictationOffers`, which
 * differ with the deprecated `TRANSCRIPTION_BASE_URL` + `TRANSCRIPTION_MODEL`
 * pair set (the recorder was then always there, whatever the value).
 */

import { config } from "$lib/server/config";
import {
	DICTATION_MODES,
	dictationOffers,
	parseDictationMode,
	type DictationMode,
	type DictationOffers,
} from "$lib/utils/dictation";
import { legacyTranscriptionConfigured } from "./transcription";

export { DICTATION_MODES, parseDictationMode, type DictationMode };

/** The stored value as it is: the raw word, new or old. */
export function dictationSetting(): string {
	return String(config.CHAT_DICTATION ?? "");
}

/** The mode the admin screen shows. */
export function dictationMode(): DictationMode {
	return parseDictationMode(dictationSetting(), legacyTranscriptionConfigured());
}

/**
 * What the composers offer this user. `modelUsable` is "a gateway transcription
 * model resolves for them", resolved once per request by the caller.
 */
export function dictationOffersFor(modelUsable: boolean): DictationOffers {
	return dictationOffers(dictationSetting(), legacyTranscriptionConfigured(), modelUsable);
}

/**
 * Whether `/api/transcribe` may be used at all: the recorder is on offer. With
 * the legacy pair that is whatever the value says (as it always was); through
 * the gateway only for `model`.
 */
export function recorderAllowed(): boolean {
	return dictationOffers(dictationSetting(), legacyTranscriptionConfigured(), true).recorder;
}
