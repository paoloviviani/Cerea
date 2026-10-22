/**
 * Whether the composer offers browser dictation (the Web Speech API). A
 * deployment-wide choice an administrator makes under Administration -> Voice.
 *
 * - `yes`: always offered, where the browser supports it.
 * - `no`: never.
 * - `fallback` (the default): offered only when the deployment has no
 *   server-side transcription (`TRANSCRIPTION_MODEL` and `TRANSCRIPTION_BASE_URL`), so the recorder
 *   button and the dictation button are never both there.
 *
 * Browser dictation may send the audio to the browser vendor's cloud, which is
 * why an administrator, and not each person, decides whether it is offered.
 */

import { config } from "$lib/server/config";
import { DICTATION_MODES, parseDictationMode, type DictationMode } from "$lib/utils/dictation";

export { DICTATION_MODES, parseDictationMode, type DictationMode };

/** The mode in force: stored value, else the environment, else `fallback`. */
export function dictationMode(): DictationMode {
	return parseDictationMode(config.CHAT_DICTATION);
}
