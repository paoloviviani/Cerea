/**
 * The Voice & audio settings an administrator saves (Administration ->
 * Assistant -> Voice): one document. Dictation's mode lives in the ordinary
 * configuration (`CHAT_DICTATION`); this holds what that cannot, the
 * transcription model, so it works whatever else is enabled.
 */
export interface VoiceConfig {
	/** The gateway model that transcribes attached audio and dictation; null: the default. */
	transcriptionModel?: string | null;
	updatedAt: Date;
}
