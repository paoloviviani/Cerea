/**
 * What a dictation recording becomes: one call to Cerea's `/api/transcribe`
 * (which sends it through the gateway as the user), and the text added to a
 * draft. Shared by the chat window and the agent composer so both record the
 * same way.
 */
import { base } from "$app/paths";

/** The transcript of one recording; throws with the server's message when it fails. */
export async function transcribeRecording(audio: Blob): Promise<string> {
	const response = await fetch(`${base}/api/transcribe`, {
		method: "POST",
		headers: { "Content-Type": audio.type },
		body: audio,
	});
	if (!response.ok) throw new Error(await response.text());
	const { text } = (await response.json()) as { text?: string };
	return (text ?? "").trim();
}

/** The draft with the transcript added after what is already there. */
export function appendTranscript(draft: string, text: string): string {
	return draft.trim() ? `${draft.trim()} ${text}` : text;
}
